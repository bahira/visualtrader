"""Offline BTC futures study of the Phoenix Sentinel Pine rules."""
from dataclasses import dataclass, asdict
import argparse
from hashlib import sha256
import itertools
import json
import math
from pathlib import Path
import re

import numpy as np
import pandas as pd

MINUTE = 60_000
BAR = 240 * MINUTE
START_CAPITAL = 1000
SPLIT = '2025-01-01'
VALIDATION = '2024-01-01'


@dataclass(frozen=True)
class Rules:
    leverage: int
    trail: float
    activation: float
    stop: float
    leverage_tick: float = 0.1


@dataclass
class Position:
    side: int
    quantity: float
    entry: float
    fee: float
    stop: float
    activation: float
    offset: float
    best: float | None = None
    funding: float = 0

    def level(self):
        if self.best is None:
            return self.stop
        return self.best - self.side * self.offset

    def observe(self, price):
        if self.side * (price - self.activation) >= 0:
            if self.best is None or self.side * (price - self.best) > 0:
                self.best = price


def pine_rules(path):
    raw = path.read_text(encoding='utf-8-sig')
    values = {key: float(value) for key, value in re.findall(
        r'(?m)^(\w+)\s*=\s*input\.(?:int|float)\(([\d.]+)', raw)}
    fee = float(re.search(r'commission_value\s*=\s*([\d.]+)', raw)[1]) / 100
    return Rules(int(values['LEV']), values['TRAIL_PCT']/100, values['MIN_PROFIT']/100,
                 values['SWAN_SL_PCT']/100), values, fee, sha256(path.read_bytes()).hexdigest()


def bar_signals(bars, inputs):
    closes = bars['close'].to_numpy()
    length = int(inputs['KERNEL_LEN'])
    x = (np.arange(length) - length / 2) / inputs['KERNEL_ALPHA']
    weights = 1 / np.cosh(x)
    kernel = pd.Series(np.convolve(closes, weights / weights.sum(), mode='full')[:len(closes)])
    kernel.iloc[:length-1] = np.nan
    previous = kernel.shift()
    long = (kernel > previous) & (previous <= kernel.shift(2))
    short = ((kernel < previous) & (previous >= kernel.shift(2)) &
             (bars['close'].reset_index(drop=True) >= bars['high'].reset_index(drop=True)
              .rolling(int(inputs['SHORT_LB'])).max() * inputs['SHORT_FILTER']))
    return np.where(long, 1, np.where(short, -1, 0))


def traverse(position, o, h, l, c, high_first):
    """Walk one OHLC path. Gap fills occur at the executable opening price."""
    if position.side * (o - position.level()) <= 0:
        return o, 'trail' if position.best is not None else 'stop'
    path = (o,h,l,c) if high_first else (o,l,h,c)
    for price in path:
        stop = position.level()
        if position.side * (price - stop) <= 0:
            return stop, 'trail' if position.best is not None else 'stop'
        position.observe(price)
    return None


def prepare(directory, inputs):
    def feather(kind):
        frame = pd.read_feather(directory / f'BTC_USDT_USDT-{kind}.feather')
        if not frame.date.is_monotonic_increasing or frame.date.duplicated().any():
            raise ValueError(f'Horodatages invalides dans {kind}')
        return frame
    def times(frame):
        return frame.date.to_numpy(dtype='datetime64[ms]').astype(np.int64)
    bars = feather('4h-futures')
    minutes = feather('1m-futures')
    fund = feather('1h-funding_rate')
    marks = feather('1h-mark')
    joined = fund.merge(marks[['date','open']], on='date', how='left', validate='one_to_one')
    if joined['open'].isna().any():
        raise ValueError('Mark futures manquant à une échéance funding')
    mt, bt, ft = times(minutes), times(bars), times(joined)
    bt = np.append(bt, bt[-1] + BAR)
    offsets = np.searchsorted(mt,bt)
    if (mt[offsets[:-1]] != bt[:-1]).any():
        raise ValueError('Une première minute de bougie 4 h manque')
    funding = np.zeros(len(mt))
    funding_indices = np.searchsorted(mt,ft)
    valid = funding_indices < len(mt)
    if (mt[funding_indices[valid]] != ft[valid]).any():
        raise ValueError('Une minute de settlement funding manque')
    funding[funding_indices[valid]] = (joined.funding_rate * joined.open).to_numpy()[valid]
    ranges = np.diff(mt) != MINUTE
    return {'time':mt, 'bars':bt, 'offsets':offsets, 'ohlc':minutes[['open','high','low','close']].to_numpy(),
            'funding':funding, 'signals':bar_signals(bars,inputs), 'missingMinutes':int(ranges.sum()),
            'close':bars.close.to_numpy()}


def timestamp(value):
    return int(pd.Timestamp(value,tz='UTC').timestamp() * 1000)


def simulate(data, rules, start, end, fee, slippage, adverse=False):
    t, b, offsets = data['time'], data['bars'], data['offsets']
    prices, funding = data['ohlc'], data['funding']
    first = max(1,int(np.searchsorted(b,start)))
    last = min(len(b)-1,int(np.searchsorted(b,end)))
    cash, peak, drawdown = START_CAPITAL, START_CAPITAL, 0
    fees = fund_total = gross = 0.
    wins = trades = 0
    totals = {}
    position = None
    reasons = {}
    halted = False

    def mark(price):
        nonlocal peak, drawdown
        equity = cash if position is None else (
            cash + position.quantity * position.side * (price-position.entry) - position.quantity * price * fee)
        peak = max(peak,equity)
        drawdown = max(drawdown, 1 - equity / peak)
        return equity

    def close(raw_price, when, reason):
        nonlocal position, cash, fees, trades, wins, gross
        fill = raw_price * (1 - position.side * slippage)
        pnl = position.quantity * position.side * (fill-position.entry)
        exit_fee = position.quantity * fill * fee
        net = pnl - position.fee - exit_fee + position.funding
        cash += pnl - exit_fee
        gross += pnl
        fees += exit_fee
        trades += 1
        wins += net > 0
        year = str(pd.Timestamp(int(when),unit='ms',tz='UTC').year)
        totals[year] = totals.get(year,0.) + net
        reasons[reason] = reasons.get(reason,0) + 1
        position = None
        mark(raw_price)

    for i in range(first,last):
        j0,j1 = offsets[i:i+2]
        if j0 == j1:
            continue
        side = int(data['signals'][i-1])
        raw = prices[j0,0]
        if position and funding[j0]:
            amount = -position.side * position.quantity * funding[j0]
            position.funding += amount
            cash += amount
            fund_total += amount
        if side and (position is None or side != position.side):
            equity = cash if position is None else (
                cash + position.quantity * position.side * (data['close'][i-1] - position.entry))
            if position:
                close(raw,t[j0],'reversal')
            if min(cash,equity) <= 0:
                halted = True
                break
            fill = raw * (1 + side * slippage)
            qty = equity * rules.leverage / data['close'][i-1]
            entry_fee = qty * fill * fee
            fees += entry_fee
            cash -= entry_fee
            tick = rules.leverage_tick
            offset = math.floor(fill * rules.trail / tick + .5) * tick
            position = Position(side,qty,fill,entry_fee,fill*(1-side*rules.stop),
                                fill*(1+side*rules.activation),offset)
            mark(raw)
        if position is None:
            continue
        for j in range(j0,j1):
            o,h,l,c = prices[j]
            if j != j0 and funding[j]:
                amount = -position.side * position.quantity * funding[j]
                position.funding += amount
                cash += amount
                fund_total += amount
            # Baseline uses the closer extreme first. Stress takes the adverse extreme first.
            high_first = (position.side < 0) if adverse else (h-o < o-l)
            result = traverse(position,o,h,l,c,high_first)
            if result:
                close(result[0],t[j],result[1])
                break
            if mark(c) <= 0:
                close(c,t[j],'equity_stop')
                halted = True
                break
        if halted:
            break
    if position:
        close(prices[offsets[last]-1,3], t[offsets[last]-1], 'period_end')
    return {'returnPct':100*(cash/START_CAPITAL-1),'maxDrawdownPct':100*drawdown,
            'trades':trades,'winPct':100*wins/trades if trades else 0, 'fees':fees,'funding':fund_total,
            'gross':gross,'equity':cash,'years':totals,'exits':reasons,'halted':halted}


def research(data, exact, fee):
    end = data['bars'][-1]
    train = (data['bars'][0],timestamp(VALIDATION))
    validation = (timestamp(VALIDATION),timestamp(SPLIT))
    holdout = (timestamp(SPLIT),end)
    plan = Rules(exact.leverage,.001,exact.activation,exact.stop)
    grid = [Rules(lev,trail,arm,exact.stop) for lev,trail,arm in
            itertools.product((1,2,3),(.0003,.001,.0025,.005),(.0025,.005,.01))]
    def score(rules):
        rows = [simulate(data,rules,*period,fee,.0002) for period in (train,validation)]
        return min(row['returnPct'] - row['maxDrawdownPct'] for row in rows)
    scored = sorted(((score(rules),idx,rules) for idx,rules in enumerate(grid)), reverse=True)
    best = scored[0][2]
    results = {}
    for label,rules in [('Pine',exact),('Plan',plan),('Sélection',best)]:
        results[label] = {'rules':asdict(rules),'train':simulate(data,rules,*train,fee,.0002),
                          'validation':simulate(data,rules,*validation,fee,.0002),
                          'holdout':simulate(data,rules,*holdout,fee,.0002),
                          'stress':simulate(data,rules,*holdout,fee,.0005,adverse=True)}
    return {'results':results, 'split':SPLIT, 'validationStart':VALIDATION, 'gridSize':len(grid),
            'candidateScore':scored[0][0], 'candidatePassedSelection':scored[0][0] > 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pine',type=Path)
    parser.add_argument('dataset',type=Path)
    parser.add_argument('--out',type=Path,default=Path('data/phoenix-research.json'))
    args = parser.parse_args()
    exact, inputs, fee, sha = pine_rules(args.pine)
    data = prepare(args.dataset,inputs)
    report = research(data,exact,fee)
    report.update({'pineSha256':sha,'fee':fee,'lastClosedBarEnd':str(pd.Timestamp(
        int(data['bars'][-1]),unit='ms',tz='UTC')), 'missingMinuteTransitions':data['missingMinutes']})
    args.out.parent.mkdir(parents=True,exist_ok=True)
    output = args.out.with_suffix('.tmp')
    output.write_text(json.dumps(report,indent=2,ensure_ascii=False,allow_nan=False),encoding='utf8')
    output.replace(args.out)
    print(json.dumps(report,indent=2,ensure_ascii=False))


if __name__ == '__main__':
    main()
