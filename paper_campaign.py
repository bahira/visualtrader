"""Collect and replay independent public BTCUSDT paper blocks."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
SCENARIOS = ('test', 'queueScenario', 'stress')
FEES = ('10', '2', '0')


def save(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2, allow_nan=False), encoding='utf8')
    tmp.replace(path)


def call(*command, timeout):
    return json.loads(subprocess.run(command, cwd=ROOT, check=True, capture_output=True,
                                     encoding='utf8', timeout=timeout).stdout)


def aggregate(blocks):
    results = {}
    for fee in FEES:
        results[fee] = {}
        for scenario in SCENARIOS:
            days = {}
            for block in blocks:
                row = block['replay'][fee][scenario]
                day = days.setdefault(block['utcDay'], {'pnl':0., 'cycles':0, 'minutes':0.})
                day['pnl'] += row['incrementalNet']
                day['cycles'] += row['cycles']
                day['minutes'] += row['minutes']
            total = sum(day['pnl'] for day in days.values())
            cycles = sum(day['cycles'] for day in days.values())
            minutes = sum(day['minutes'] for day in days.values())
            results[fee][scenario] = {'net':total, 'cycles':cycles, 'minutes':minutes,
                'cyclesPerMinute':cycles/minutes if minutes else 0, 'days':days}
    return results


def verdict(blocks, results, planned):
    if len(blocks) < planned or planned < 24:
        return 'insufficient'
    for row in results['10'].values():
        if len(row['days']) < 3 or row['minutes'] < 200:
            return 'insufficient'
        if (row['net'] <= 0 or row['cyclesPerMinute'] < 10 or
                any(day['pnl'] <= 0 for day in row['days'].values())):
            return 'rejected'
    return 'passed_paper_only'


def run(directory, frozen, blocks, spacing, seconds):
    directory.mkdir(parents=True, exist_ok=False)
    frozen_bytes = frozen.read_bytes()
    rules = json.loads(frozen_bytes)
    if not all(fee in rules['results'] for fee in FEES):
        raise ValueError('Missing frozen fee scenarios')
    frozen_copy = directory / 'frozen.json'
    frozen_copy.write_bytes(frozen_bytes)
    report = {'status':'running', 'verdict':'insufficient', 'blocks':[], 'failures':[],
              'plannedBlocks':blocks, 'spacingSeconds':spacing, 'captureSeconds':seconds,
              'frozenSha256':hashlib.sha256(frozen_bytes).hexdigest()}
    destination = directory / 'status.json'
    save(destination,report)
    start = time.monotonic()
    for index in range(1,blocks+1):
        delay = start+(index-1)*spacing-time.monotonic()
        if delay > 0:
            time.sleep(delay)
        report['currentBlock'] = index
        save(destination,report)
        utc = datetime.now(timezone.utc)
        database = directory / f'block-{index:02}.sqlite'
        replay_file = directory / f'block-{index:02}.json'
        try:
            if shutil.disk_usage(directory).free < 2*1024**3:
                raise RuntimeError('Less than 2 GiB of free disk space')
            capture = call('node','depth_capture.mjs','--seconds',str(seconds),timeout=seconds+45)
            raw = Path(capture['output'])
            retained = directory / f'block-{index:02}.ndjson'
            raw.replace(retained)
            rebuilt = call('node','depth_replay.mjs',str(retained),str(database),timeout=180)
            if (capture['sequenceGaps'] or capture['mismatchedQuotes'] or capture['invalidBooks'] or
                    rebuilt['gaps'] or rebuilt['snapshots'] != 1 or
                    rebuilt['depth'] != capture['validBooks'] or capture['matchingQuotes'] == 0 or
                    rebuilt['depth'] < seconds*8):
                raise RuntimeError('Incomplete or inconsistent capture')
            replay = call(sys.executable,'-B','two_sided_study.py','--db',str(database),
                          '--frozen',str(frozen_copy),'--out',str(replay_file),timeout=180)
            block = replay['blocks']['1']['results']
            if any(block[fee][model]['fillsAcrossGaps'] for fee in FEES for model in SCENARIOS):
                raise RuntimeError('Simulated fills span a discontinuity')
            capture['output'] = retained.name
            report['blocks'].append({'index':index, 'utcDay':utc.date().isoformat(),
                'startedUtc':utc.isoformat(), 'capture':capture, 'rebuild':rebuilt, 'replay':block})
        except (RuntimeError, subprocess.SubprocessError, OSError, ValueError) as error:
            detail = getattr(error,'stderr',None)
            report['failures'].append({'index':index,'error':(detail or str(error))[-1800:]})
        report['summary'] = aggregate(report['blocks'])
        report['verdict'] = verdict(report['blocks'],report['summary'],blocks)
        save(destination,report)
    report['status'] = 'complete'
    save(destination,report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,required=True)
    parser.add_argument('--frozen',type=Path,default=ROOT/'data/two-sided.json')
    parser.add_argument('--blocks',type=int,default=24)
    parser.add_argument('--spacing',type=int,default=10800)
    parser.add_argument('--seconds',type=int,default=600)
    args = parser.parse_args()
    if not 1 <= args.blocks <= 72 or not 5 <= args.seconds <= 900 or args.spacing < args.seconds:
        parser.error('Use 1–72 blocks, 5–900 capture seconds, and spacing >= capture duration')
    report = run(args.directory.resolve(),args.frozen.resolve(),args.blocks,args.spacing,args.seconds)
    print(json.dumps({'status':report['status'], 'verdict':report['verdict'],
                      'validBlocks':len(report['blocks']), 'failures':report['failures']},indent=2))
    return 0 if report['blocks'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
