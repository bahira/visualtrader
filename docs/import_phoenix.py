"""Import only aggregate statistics from a local Freqtrade backtest archive."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
from zipfile import ZipFile


def summarize(path):
    with ZipFile(path) as archive:
        member = archive.getinfo(path.stem + '.json')
        if member.file_size > 100_000_000:
            raise ValueError('Archive de résultats trop volumineuse')
        raw = archive.read(member)
    result = json.loads(raw)['strategy']['ErrfPhoenix']
    trades = result['trades']
    return {
        'archive': path.name,
        'sha256': sha256(raw).hexdigest(),
        'timeframe': result['timeframe'],
        'start': result['backtest_start'],
        'end': result['backtest_end'],
        'profit': result['profit_total'],
        'drawdown': result['max_drawdown_account'],
        'cycles': result['total_trades'],
        'wins': result['winrate'],
        'profitFactor': result['profit_factor'],
        'funding': sum(trade.get('funding_fees') or 0 for trade in trades),
        'leverage': sorted({trade['leverage'] for trade in trades}),
        'periods': [{'period': period, 'net': net} for period, net in result['daily_profit']],
        'pairs': [{'name': row['key'], 'cycles': row['trades'], 'net': row['profit_total_abs']}
                  for row in result['results_per_pair'] if row['key'] != 'TOTAL'],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    args = parser.parse_args()
    data = summarize(args.archive)
    # Aggregate daily results into calendar years, without exporting the trade history.
    years = {}
    for row in data.pop('periods'):
        year = row['period'][-4:] if '/' in row['period'] else row['period'][:4]
        years[year] = years.get(year, 0) + row['net']
    data['years'] = years
    target = Path(__file__).resolve().parents[1] / 'data' / 'phoenix-archive.json'
    target.parent.mkdir(exist_ok=True)
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    temporary.replace(target)
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
