"""Inventory-aware, two-sided spot paper replay. No exchange client."""
import argparse
from bisect import bisect_left, bisect_right
from dataclasses import asdict, dataclass
from itertools import product
import json
import math
from pathlib import Path
import sqlite3

import numpy as np

from microstructure import load
from maker_study import flow_fill

TICK = .01
END_TRAIN = 519027
END_VALIDATION = 823725
END_TEST = 858448


@dataclass(frozen=True)
class Quote:
    width_bps: int
    refresh_ms: int
    skew_bps: int
    flow_bps: int


def tick(price, side):
    units = price / TICK
    return (math.floor(units + 1e-7) if side == 1 else math.ceil(units - 1e-7)) * TICK


def replay(tape, config, fee_bps=10, latency=250, slip_bps=1):
    # One unit on each side of the initial inventory. Orders are one fixed unit.
    qty = math.floor(100 / tape.mid[0]*1e8)/1e8
    holdings, initial = 1, 1
    cash = gross = fees = 0.
    buys = tape.trades[tape.trades[:,3] == 0,:3].T.tolist()
    sells = tape.trades[tape.trades[:,3] == 1,:3].T.tolist()
    ts = tape.time
    horizon = int(ts[-1])
    next_quote = int(ts[0])
    count = [0,0]
    gaps = posts = rejects = 0
    peak = dd = 0.
    k = 0

    def equity(i):
        return cash + (holdings-initial)*qty*tape.mid[i]

    rejected_windows = 0
    equity_cursor = 0

    def mark_until(stop):
        nonlocal equity_cursor, peak, dd
        for snapshot in range(equity_cursor,stop):
            value = equity(snapshot)
            peak = max(peak,value)
            dd = max(dd,peak-value)
        equity_cursor = stop

    while next_quote + config.refresh_ms + 2*latency + 450 < horizon:
        i = bisect_left(ts,next_quote,lo=k)
        if i >= len(ts):
            break
        mark_until(i)
        signal = int(ts[i])
        k = i + 1
        next_quote = signal + config.refresh_ms + 2*latency
        if not np.isfinite(tape.features[i,0]):
            continue
        arrive = bisect_left(ts,signal+latency,lo=i+1)
        if arrive >= len(ts) or tape.span[i] != tape.span[arrive]:
            rejected_windows += 1
            continue
        opens = int(ts[arrive])
        # Requote only after the previous cancellation can have reached the book.
        cancel = opens + config.refresh_ms + latency
        next_quote = cancel
        if cancel + latency + 450 >= horizon:
            break
        mid = tape.mid[i]
        flow = tape.features[i,5]
        reservation = mid * (1 + (config.flow_bps*flow - config.skew_bps*(holdings-initial))/10000)
        width = mid * config.width_bps / 10000
        events = []
        for side, flow_events in ((1,sells),(-1,buys)):
            if (side == 1 and holdings == 2) or (side == -1 and holdings == 0):
                continue
            # At the decision instant quotes rest at or outside the displayed touches.
            raw = reservation - side*width
            quote = tick(min(raw,tape.best_bid[i]) if side == 1 else max(raw,tape.best_ask[i]),side)
            if (side == 1 and quote >= tape.best_ask[arrive]) or (
                    side == -1 and quote <= tape.best_bid[arrive]):
                rejects += 1
                continue
            posts += 1
            fill = flow_fill(*flow_events,opens,cancel,quote,qty,side==1)
            if fill is not None:
                events.append((fill,side,quote))
        # A future quote may react to these fills only after the cancellation window ends.
        review = bisect_left(ts,cancel,lo=arrive)
        if tape.span[arrive] != tape.span[review]:
            gaps += len(events)
        for filled,side,price in sorted(events):
            mark = bisect_left(ts,filled,lo=arrive)
            mark_until(mark)
            holdings += side
            index = 0 if side == 1 else 1
            count[index] += 1
            amount = price*qty
            cost = amount*fee_bps/10000
            fees += cost
            gross -= side*amount
            cash -= side*amount + cost
        mark_until(review+1)
    mark_until(len(ts))
    # Both portfolios liquidate at the same final observed bid depth estimate.
    # The tape's sell estimate walks ~250 USDT; inventory is 0–200 USDT.
    if not np.isfinite(tape.sell[-1]):
        raise ValueError('Final bid depth cannot price inventory')
    price = tape.sell[-1] * (1-slip_bps/10000)
    value = qty*price
    taker_fee = 10/10000
    strategy_liquidation = holdings*value*(1-taker_fee)
    benchmark_liquidation = initial*value*(1-taker_fee)
    liquidation_difference = (holdings-initial)*value*taker_fee
    inventory_value = (holdings-initial)*value
    pnl = cash + strategy_liquidation - benchmark_liquidation
    dd = max(dd,peak-pnl)
    minutes = (horizon-int(ts[0]))/60000
    return {'incrementalNet':float(pnl),'gross':float(gross+inventory_value),
            'makerFeesPaid':float(fees),'liquidationFeeDelta':float(liquidation_difference),
            'incrementalPnlBeforeFinalFee':float(cash+inventory_value),
            'strategyLiquidation':float(strategy_liquidation),'benchmarkLiquidation':float(benchmark_liquidation),
            'maxDrawdown':float(dd),
            'buys':count[0],'sells':count[1],'cycles':min(count),
            'cyclesPerMinute':min(count)/minutes,'orders':posts,'rejections':rejects,
            'fillsAcrossGaps':gaps,'rejectedWindows':rejected_windows,'inventoryUnitsAtEnd':holdings,'minutes':minutes}


def study(db, end_test):
    windows = [load(db,5,end,start) for start,end in (
        (381351,END_TRAIN),(END_TRAIN,END_VALIDATION),(END_VALIDATION,end_test))]
    grid = [Quote(*x) for x in product((0,1,2,4,8),(300,1000,3000),(0,2,5),(0,2))]
    output = {}
    for fee in (10,2,0):
        training = [(rule,replay(windows[0],rule,fee)) for rule in grid]
        def score(row):
            return row['incrementalNet'] - .25*row['maxDrawdown'] - row['fillsAcrossGaps']*.20
        eligible = [(rule,row) for rule,row in training if row['cycles'] >= 5]
        # Validation is an additional gate, and the final block is never used to select.
        rule, train = max(eligible or training,key=lambda item:score(item[1]))
        validation = replay(windows[1],rule,fee)
        test = replay(windows[2],rule,fee)
        stress = replay(windows[2],rule,fee,500,2)
        qualify = (min(score(row) for row in (train,validation,test,stress)) > 0 and
                   min(row['cyclesPerMinute'] for row in (validation,test,stress)) >= 10 and
                   test['fillsAcrossGaps'] == stress['fillsAcrossGaps'] == 0)
        max_train_cycles = max(row['cyclesPerMinute'] for _,row in training)
        output[str(fee)] = {'rule':asdict(rule),'train':train,'maxTrainCyclesPerMinute':max_train_cycles,'validation':validation,
                            'test':test,'stress':stress,'qualified':qualify}
    return {'rulesTested':len(grid),'bounds':[381351,END_TRAIN,END_VALIDATION,end_test],
            'results':output}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',type=Path,default=Path('data/live.sqlite'))
    parser.add_argument('--end-seq',type=int,default=END_TEST)
    parser.add_argument('--out',type=Path,default=Path('data/two-sided.json'))
    args = parser.parse_args()
    db = sqlite3.connect(args.db.resolve().as_uri()+'?mode=ro',uri=True)
    try:
        last = db.execute('select max(seq) from market where session=5').fetchone()[0]
        if last is None or not END_VALIDATION < args.end_seq <= last:
            parser.error('invalid capture boundary for session 5')
        result = study(db,args.end_seq)
    finally:
        db.close()
    raw = json.dumps(result,indent=2,allow_nan=False)
    args.out.parent.mkdir(exist_ok=True,parents=True)
    tmp = args.out.with_suffix('.tmp')
    tmp.write_text(raw,encoding='utf8')
    tmp.replace(args.out)
    print(raw)


if __name__ == '__main__':
    main()
