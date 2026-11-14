"""Read rolling Quant Skew results from the paper ledger."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import time

MARKET_MS = 300_000
HORIZONS = {'hour': 3_600_000, 'day': 86_400_000, 'month': 30*86_400_000}
SHARES = 10  # Fixed size of the Quant Skew paper ledger.


def rolling_periods(db, now):
    """Group trades by scheduled close in (now - horizon, now]."""
    first = now - HORIZONS['month'] - MARKET_MS
    last = now - MARKET_MS
    rows = db.execute('''SELECT start, winner, json_extract(record,'$.fills.skew.side'),
        json_extract(record,'$.fills.skew.total') FROM trials
        WHERE start>? AND start<=? ORDER BY start''', (first, last)).fetchall()
    report = {}
    for name, duration in HORIZONS.items():
        boundary = now-duration
        bucket = [row for row in rows if row[0]+MARKET_MS>boundary]
        expected = now//MARKET_MS-boundary//MARKET_MS
        net = 0.0
        trades = pending = resolved = 0
        for _, winner, side, cost in bucket:
            resolved += winner is not None
            if side is None:
                continue
            if winner is None:
                pending += 1
                continue
            trades += 1
            net += (SHARES if side==winner else 0)-cost
        report[name] = {'net':net if resolved else None, 'fills':trades, 'pendingFills':pending,
                        'markets':len(bucket), 'resolved':resolved, 'expected':expected}
    return report


def read_periods(path, now):
    source = path.resolve().as_uri()+'?mode=ro'
    db = sqlite3.connect(source,uri=True,timeout=.05)
    try:
        return rolling_periods(db,now)
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',type=Path,default=Path('data/polymarket-v2/paper.sqlite'))
    args = parser.parse_args()
    now = time.time_ns()//1_000_000
    result = {'checked':datetime.fromtimestamp(now/1000,timezone.utc).isoformat(),
              'periods':read_periods(args.db,now)}
    print(json.dumps(result,indent=2))


if __name__=='__main__':
    main()
