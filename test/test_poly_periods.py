import json
import sqlite3
import unittest

from poly_periods import HORIZONS, MARKET_MS, rolling_periods


class RollingPeriodsTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE trials(start INTEGER PRIMARY KEY, winner INTEGER, record TEXT)')
        self.now = 31*HORIZONS['day']

    def trial(self, close_offset, winner, fill):
        record = {'fills': {'skew':fill} if fill else {}}
        self.db.execute('INSERT INTO trials VALUES(?,?,?)',
                        (self.now+close_offset-MARKET_MS,winner,json.dumps(record)))

    def test_close_windows_have_half_open_boundaries_and_keep_pending_separate(self):
        self.trial(-HORIZONS['hour'],0,{'side':0,'total':6})
        self.trial(-MARKET_MS,1,{'side':0,'total':3.25})
        self.trial(0,None,{'side':0,'total':2})
        self.trial(MARKET_MS,0,{'side':0,'total':1})
        report = rolling_periods(self.db,self.now)
        self.assertEqual(report['hour'],{'net':-3.25,'fills':1,'pendingFills':1,
                                        'markets':2,'resolved':1,'expected':12})
        self.assertEqual(report['day']['net'],.75)
        self.assertEqual(report['month']['fills'],2)

    def test_empty_window_is_unknown_and_abstention_has_zero_observed_profit(self):
        self.assertIsNone(rolling_periods(self.db,self.now)['hour']['net'])
        self.trial(0,1,None)
        self.assertEqual(rolling_periods(self.db,self.now)['hour']['net'],0)
