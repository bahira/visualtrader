"""Audit the Polymarket paper ledger without modifying it."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3

PERIOD = 300_000
SHARES = 10
MODELS = ('anchor', 'momentum', 'skew', 'market')


def audit(connection, now):
    rows = [(start, slug, decision, json.loads(record), winner)
            for start, slug, decision, record, winner in connection.execute(
                'SELECT start,slug,time,record,winner FROM trials WHERE time<=? ORDER BY start', (now,))]
    first = rows[0][0] if rows else None
    eligible_last = now - now % PERIOD
    if now - eligible_last < 138_000:
        eligible_last -= PERIOD
    absent = []
    if first is not None:
        seen = {row[0] for row in rows}
        absent = [start for start in range(first,eligible_last+1,PERIOD) if start not in seen]
    summary = {name:{'fills':0,'settled':0,'wins':0,'settledCost':0.,'openCost':0.,
                    'settledNet':0.,'fees':0.,'brierTotal':0.,'brierN':0} for name in MODELS}
    changes = {'momentumVsAnchor':0,'skewVsMomentum':0}
    paired = {'momentumVsAnchor':0.,'skewVsMomentum':0.}
    evidence = []
    for start,slug,decision,record,winner in rows:
        fills = record['fills']
        execution = record.get('execution')
        details = {'slug':slug,'decisionMsAfterOpen':decision-start,'winner':winner,
                   'signalAgeAtDecisionMs':decision-record['features']['sample'],
                   'snapshotDelayMs':execution['time']-decision if execution else None,'fills':{}}
        net_by_model = {}
        for name,model in summary.items():
            probability = record['prob'].get(name)
            if winner is not None and probability is not None:
                model['brierTotal'] += (probability-int(winner==0))**2
                model['brierN'] += 1
            fill = fills.get(name)
            net_by_model[name] = 0.
            if fill is None:
                continue
            side, total = fill['side'],fill['total']
            model['fills'] += 1
            model['fees'] += fill['fees']
            if winner is None:
                model['openCost'] += total
            else:
                model['settled'] += 1
                model['wins'] += int(side==winner)
                model['settledCost'] += total
                net = (SHARES if side==winner else 0)-total
                model['settledNet'] += net
                net_by_model[name] = net
            initial = record['initial']['quotes'][side]
            source_at_signal = record['initial']['time'] - initial['age']
            fill_time = fill.get('time', execution['time'] if execution else None)
            source_at_fill = fill_time - fill['age'] if fill_time is not None else None
            details['fills'][name] = {'side':side,'cost':total,'fees':fill['fees'],
                'bookAgeMs':fill['age'],'sourceBookAdvanced':source_at_fill > source_at_signal
                if source_at_fill is not None else None,'priceMovePerShare':(total-initial['total'])/SHARES,
                'estimatedEdgePerShare':(probability if side==0 else 1-probability)-total/SHARES}
        for key,base,extended in [('momentumVsAnchor','anchor','momentum'),('skewVsMomentum','momentum','skew')]:
            changes[key] += int((fills.get(base) or {}).get('side') !=
                                (fills.get(extended) or {}).get('side'))
            if winner is not None:
                paired[key] += net_by_model[extended]-net_by_model[base]
        evidence.append(details)
    for model in summary.values():
        total = model.pop('brierTotal')
        model['brier'] = total/model['brierN'] if model['brierN'] else None
    return {'asOfUtc':datetime.fromtimestamp(now/1000,timezone.utc).isoformat(),
            'evaluated':len(rows),'resolved':sum(row[4] is not None for row in rows),
            'missingMarketsSinceFirstEvaluation':absent,'models':summary,
            'decisionsChanged':changes,'incrementalSettledPnl':paired,'evidence':evidence}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',type=Path,default=Path('data/polymarket/paper.sqlite'))
    args = parser.parse_args()
    connection = sqlite3.connect(args.db.resolve().as_uri()+'?mode=ro',uri=True)
    try:
        now = int(datetime.now(timezone.utc).timestamp()*1000)
        print(json.dumps(audit(connection,now),indent=2,allow_nan=False))
    finally:
        connection.close()


if __name__ == '__main__':
    main()
