"""Two-sided maker replay on recorded public BTCUSDT events."""
import argparse
from bisect import bisect_left, bisect_right
from dataclasses import asdict, dataclass
import itertools
import json
import math
from pathlib import Path
import sqlite3

import numpy as np

from microstructure import STAKE, load


@dataclass(frozen=True)
class Rules:
    entry_offset: int
    take_profit: int
    hold_ms: int
    min_imbalance: float


def flow_fill(times, prices, quantities, start, end, price, qty, buy):
    """Require sufficient volume strictly through limit after order arrival."""
    consumed = 0.
    for i in range(bisect_right(times,start),bisect_left(times,end)):
        distance = price - prices[i] if buy else prices[i] - price
        if distance > 0:
            consumed += quantities[i]
            if consumed >= qty:
                return int(times[i])
    return None


def run(tape, rules, latency=250, taker_slip=1):
    t = tape.time
    bids, asks = tape.best_bid, tape.best_ask
    sells = tape.trades[tape.trades[:,3] == 1,:3].T.tolist()
    buys = tape.trades[tape.trades[:,3] == 0,:3].T.tolist()
    # Snapshot depth estimates taker fallback at the same approximate 250 USDT size.
    ledger = []
    blocked = -1
    orders = 0
    ready = np.isfinite(tape.features[:,0]) & (tape.features[:,0] >= rules.min_imbalance)
    for i in np.flatnonzero(ready):
        now = t[i]
        if now <= blocked:
            continue
        if now + 1000 + rules.hold_ms + 4 * latency + 1000 >= t[-1]:
            break
        j = int(np.searchsorted(t,now + latency))
        tick = .01
        limit = math.floor((bids[i] * (1 - rules.entry_offset / 10000) + 1e-9) / tick) * tick
        blocked = t[j]
        if tape.span[i] != tape.span[j] or limit >= asks[j]:
            continue
        qty = math.floor(STAKE / limit * 1e8) / 1e8
        orders += 1
        expires = t[j] + 1000 + latency
        filled = flow_fill(*sells,t[j],expires,limit,qty,True)
        if filled is None:
            blocked = expires
            continue
        fill_idx = int(np.searchsorted(t,filled))
        k = int(np.searchsorted(t,filled + latency))
        target = math.ceil((limit * (1 + rules.take_profit / 10000) - 1e-9) / tick) * tick
        deadline = t[k] + rules.hold_ms + latency
        if target <= bids[k]:
            # A crossing post-only order is rejected. Send a taker exit after latency.
            deadline = t[k]
            sale = None
        else:
            sale = flow_fill(*buys,t[k],deadline,target,qty,False)
        if sale is not None:
            exit_price = target
            blocked = sale
        else:
            exit_idx = int(np.searchsorted(t,deadline + latency))
            while exit_idx < len(t) and not np.isfinite(tape.sell[exit_idx]):
                exit_idx += 1
            if exit_idx == len(t):
                raise ValueError('No taker liquidation quote after inventory timeout')
            exit_price = tape.sell[exit_idx] * (1 - taker_slip / 10000)
            blocked = t[exit_idx]
        end_idx = min(len(t)-1,np.searchsorted(t,blocked))
        gap = tape.span[j] != tape.span[fill_idx] or tape.span[j] != tape.span[end_idx]
        ledger.append((qty*limit, qty*exit_price, sale is not None, gap))
    return ledger, orders


def stats(run_result, maker, taker, minutes):
    ledger, orders = run_result
    gross = fees = peak = drawdown = 0.
    maker_exits = wins = ambiguous = 0
    clean_pnl = maker_pnl = fallback_pnl = 0.
    for entry, exit_, passive, gap in ledger:
        pnl = exit_ - entry
        cost = (entry * maker + exit_ * (maker if passive else taker)) / 10000
        ambiguous += int(gap)
        if not gap:
            clean_pnl += pnl - cost
        if passive:
            maker_pnl += pnl - cost
        else:
            fallback_pnl += pnl - cost
        gross += pnl
        fees += cost
        peak = max(peak,gross-fees)
        drawdown = max(drawdown,peak-gross+fees)
        maker_exits += passive
        wins += int(pnl > cost)
    return {'pnl':float(gross-fees),'gross':float(gross),'fees':float(fees),'cycles':len(ledger),
            'perMinute':len(ledger)/minutes,'makerExits':maker_exits,'wins':wins,
            'orders':orders,'ambiguous':ambiguous,'drawdown':float(drawdown),
            'cleanPnl':float(clean_pnl),'makerPnl':float(maker_pnl),'fallbackPnl':float(fallback_pnl)}


def study(db, last):
    maximum = db.execute('SELECT MAX(seq) FROM market WHERE session=5').fetchone()[0]
    if maximum is None or not 519027 < last <= maximum:
        raise ValueError('Fin de capture invalide pour la session 5')
    development = load(db,5,519027,381351)
    holdout = load(db,5,last,519027)
    def minutes(tape):
        return (int(tape.time[-1])-int(tape.time[0])) / 60000
    grid = [Rules(*x) for x in itertools.product((0,1,3),(4,10,22),(1500,5000,12000),(-1.,.5))]
    fees = ((10,10),(2,3),(0,2),(0,0))
    selections = {}
    cache = {rules:run(development,rules) for rules in grid}
    for maker,taker in fees:
        ranked = [(rules,stats(result,maker,taker,minutes(development))) for rules,result in cache.items()]
        rules, score = max(ranked,key=lambda item: item[1]['pnl'] - .25*item[1]['drawdown']
                           if item[1]['cycles'] >= 20 else -float('inf'))
        test = stats(run(holdout,rules),maker,taker,minutes(holdout))
        stress = stats(run(holdout,rules,500,2),maker,taker,minutes(holdout))
        selections[f'{maker}/{taker}'] = {
            'rules':asdict(rules),'development':score,'test':test,'stress':stress,
            'qualified': (min(score['pnl'],test['pnl'],stress['pnl']) > 0 and
                          min(test['perMinute'],stress['perMinute']) >= 10 and
                          max(test['ambiguous'],stress['ambiguous']) == 0)}
    return {'session':5,'selectionEnd':519027,'holdoutEnd':last,'gridSize':len(grid),
            'developmentMinutes':minutes(development),'holdoutMinutes':minutes(holdout),
            'results':selections}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',type=Path,default=Path('data/live.sqlite'))
    parser.add_argument('--end-seq',type=int,default=823725)
    parser.add_argument('--out',type=Path,default=Path('data/maker-study.json'))
    args = parser.parse_args()
    db = sqlite3.connect(args.db.resolve().as_uri()+'?mode=ro',uri=True)
    try:
        results = study(db,args.end_seq)
    finally:
        db.close()
    result = json.dumps(results,indent=2,allow_nan=False)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    temporary = args.out.with_suffix('.tmp')
    temporary.write_text(result,encoding='utf8')
    temporary.replace(args.out)
    print(result)


if __name__ == '__main__':
    main()
