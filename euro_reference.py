"""Reference EUR conversion for the presentation layer."""

from datetime import date
from math import isfinite
from urllib.request import urlopen
from xml.etree import ElementTree

SOURCE = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'
REFERENCE = (date(2026, 11, 13), 1.1052)


def parse_reference(payload):
    try:
        tree = ElementTree.fromstring(payload)
    except ElementTree.ParseError as error:
        raise ValueError('Invalid EUR/USD reference XML') from error
    for day in tree.iter():
        if 'time' not in day.attrib:
            continue
        for currency in day:
            if currency.get('currency') == 'USD':
                rate = float(currency.get('rate', 'nan'))
                if isfinite(rate) and rate > 0:
                    return date.fromisoformat(day.attrib['time']), rate
    raise ValueError('EUR/USD reference missing')


def read_reference():
    with urlopen(SOURCE, timeout=5) as response:
        return parse_reference(response.read(64_000))


def euro_values(daily_usdc, usd_per_eur):
    daily = daily_usdc / usd_per_eur
    return daily / 24, daily, daily * 30


def format_euro(value):
    return f'{value:+.2f}'.replace('-', '−').replace('.', ',') + ' €'
