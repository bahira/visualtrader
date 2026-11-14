"""Join Polymarket decisions with observable Binance spot flow."""

import argparse
from collections import deque
from datetime import datetime, timezone
import hashlib
import json
from math import exp, log
from pathlib import Path
import sqlite3
import subprocess
import sys
import time


def join(trials, trades):
    tape = iter(trades)
    current = next(tape, None)
    window = deque()
    for trial in trials:
        cutoff = trial['time']
        start = cutoff - 30_000
        while current is not None and current[0] < cutoff:
            if current[0] >= start:
                window.append(current)
            current = next(tape, None)
        while window and window[0][0] < start:
            window.popleft()
        known = [r for r in window if start <= r[1] < cutoff]
        seconds = len({r[1] // 1000 for r in known})
        volume = sum(r[2] for r in known)
        imbalance = sum(r[2] * r[3] for r in known) / volume if seconds >= 25 and volume > 0 else None
        recent = [r for r in known if r[1]>=cutoff-10_000]
        recent_volume = sum(r[2] for r in recent)
        acceleration = (sum(r[2]*r[3] for r in recent)/recent_volume-imbalance
                        if imbalance is not None and recent_volume>0 and len({r[1]//1000 for r in recent})>=8 else None)
        yield dict(trial, flow={'trades': len(known), 'activeSeconds': seconds,
                               'imbalance': imbalance, 'acceleration': acceleration})


def trade_rows(db, start, end):
    sql = '''SELECT recv, json FROM market WHERE recv>=? AND recv<?
        AND session IN (SELECT id FROM sessions WHERE mode='live')
        AND json LIKE '%btcusdt@trade%' ORDER BY recv, seq'''
    seen = set()
    ids = deque()
    for recv, value in db.execute(sql, (start, end)):
        packet = json.loads(value)
        if packet.get('stream') != 'btcusdt@trade':
            continue
        trade = packet['data']
        while ids and recv - ids[0][0] > 60_000:
            _, expired = ids.popleft()
            seen.remove(expired)
        key = trade['t']
        if key in seen:
            continue
        seen.add(key)
        ids.append((recv, key))
        yield recv, trade['T'], float(trade['q']), -1 if trade['m'] else 1


def compare(rows):
    results = {}
    for row in rows:
        value = row['flow']['imbalance']
        if row['winner'] is None or value is None:
            continue
        band = 'buy' if value >= .20 else 'sell' if value <= -.20 else 'balanced'
        category = {'markets': 0, 'up': 0, 'skewFills': 0, 'skewNet': 0.0, 'skewUnknown': 0}
        cohort = results.setdefault(row['phase'], {}).setdefault(band, category)
        cohort['markets'] += 1
        cohort['up'] += int(row['winner'] == 0)
        result = ((row.get('outcomes') or {}).get('skew') or {}).get('500', {})
        if result.get('state') == 'unknown':
            cohort['skewUnknown'] += 1
        if result.get('state') == 'fill':
            cohort['skewFills'] += 1
            cohort['skewNet'] += result['net']
    return results


def benchmark(rows, shares, threshold, stress):
    """Compare models on the same eligible markets with the archived execution evidence."""
    phases = {}
    for row in rows:
        observed = row.get('observed') or {}
        initial = observed.get('initial')
        flow = row['flow']
        if (row['winner'] is None or flow['acceleration'] is None or not initial or
                any(item['quote'] is None for item in initial)):
            continue
        costs = [item['quote']['total']/shares for item in initial]
        base = initial[0]['quote']['average']/sum(item['quote']['average'] for item in initial)
        prior = log(base/(1-base))
        imbalance = flow['imbalance']
        impulse = max(-1, min(1, flow['acceleration']))
        for sample in observed['samples']:
            delay = sample['barrier']-row['time']
            stats = phases.setdefault(row['phase'], {}).setdefault(delay, {})
            signals = {'book': prior, 'flow': prior + .45*imbalance,
                       'impulse': prior + .35*impulse, 'combined': prior + .45*imbalance + .35*impulse}
            for name, score in signals.items():
                m = stats.setdefault(name, {'markets': 0, 'brierSum': 0.0, 'attempts': 0, 'unknown': 0,
                                            'fills': 0, 'stressNet': 0.0})
                p = 1/(1+exp(-score))
                m['markets'] += 1
                m['brierSum'] += (p-int(row['winner']==0))**2
                prob = [p, 1-p]
                side = max(range(2),key=lambda i: prob[i]-costs[i])
                if prob[side]-costs[side]-stress<threshold:
                    continue
                m['attempts'] += 1
                execution = sample['sides'][side]
                if execution is None:
                    m['unknown'] += 1
                    continue
                quote = execution['quote']
                if quote and prob[side]-quote['total']/shares-stress>=threshold:
                    m['fills'] += 1
                    m['stressNet'] += shares*(int(row['winner']==side)-stress)-quote['total']
    for delays in phases.values():
        for models in delays.values():
            for m in models.values():
                m['brier'] = m.pop('brierSum')/m['markets']
    return phases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spot', type=Path, default=Path('data/live.sqlite'))
    parser.add_argument('--policy', type=Path, default=Path('docs/poly-edge-policy.json'))
    parser.add_argument('--rows', action='store_true', help='Write joined NDJSON')
    parser.add_argument('--watch', type=Path, help='Refresh a local JSON report every five minutes')
    args = parser.parse_args()
    if args.watch and args.rows:
        parser.error('--rows requires a one-off export')
    policy_bytes = args.policy.read_bytes()
    policy = json.loads(policy_bytes)
    digest = hashlib.sha256(Path(__file__).read_bytes() + policy_bytes).hexdigest()
    # A separate pre-registered cutoff applies to the new flow experiment.
    flow_start = datetime.fromisoformat(policy.get('flowStartUtc','2026-11-14T20:20:00+00:00')).timestamp()*1000
    registered = time.time()*1000
    if args.watch:
        try:
            prior = json.loads(args.watch.read_text(encoding='utf-8-sig'))
            if prior.get('digest')==digest:
                registered = min(registered,prior['registeredMs'])
        except (FileNotFoundError,ValueError,KeyError):
            pass

    def cycle(lines):
        trials = sorted((json.loads(line) for line in lines if line.strip()), key=lambda trial: trial['time'])
        if not trials:
            raise ValueError('Pipe the NDJSON from poly_edge.mjs --export into this command')
        for row in trials:
            row['phase'] = ('prior' if row['start']<flow_start or registered>=flow_start else 'forward')
        db = sqlite3.connect(args.spot.resolve().as_uri() + '?mode=ro', uri=True, timeout=3)
        try:
            rows = join(trials, trade_rows(db,trials[0]['time']-30_000,trials[-1]['time']))
            if args.rows:
                for row in rows:
                    print(json.dumps(row))
                return None
            rows = list(rows)
            return {'checked':datetime.now(timezone.utc).isoformat(),'digest':digest,'registeredMs':registered,
                    'prospective':registered<flow_start and bool(args.watch),
                    'sourceDigest':trials[0]['digest'],'rows':len(rows),
                    'coverage':sum(r['flow']['imbalance'] is not None for r in rows),'cohorts':compare(rows),
                    'benchmark':benchmark(rows,policy['shares'],policy['directionalEdge'],policy['stressPerLeg'])}
        finally:
            db.close()

    if not args.watch:
        result = cycle(sys.stdin)
        if result is not None:
            print(json.dumps(result,indent=2))
        return
    while True:
        try:
            export = subprocess.run(['node','poly_edge.mjs','--export','--policy',str(args.policy)],
                                    capture_output=True,text=True,encoding='utf8',timeout=60,check=True)
            result = cycle(export.stdout.splitlines())
            temporary = args.watch.with_suffix('.tmp')
            temporary.write_text(json.dumps(result,indent=2),encoding='utf8')
            for retry in range(5):
                try:
                    temporary.replace(args.watch)
                    break
                except PermissionError:
                    if retry==4:
                        raise
                    time.sleep(.05*(retry+1))
        except (OSError,ValueError,sqlite3.Error,subprocess.SubprocessError) as error:
            print(str(error),file=sys.stderr,flush=True)
        time.sleep(300)


if __name__ == '__main__':
    main()
