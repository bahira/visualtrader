import unittest
from pathlib import Path
import sys

import numpy as np
import pandas as pd

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from phoenix_research import BAR, MINUTE, Position, Rules, bar_signals, simulate, traverse


class PhoenixResearchTest(unittest.TestCase):
    def test_paths_differ_when_hard_stop_and_activation_are_both_touched(self):
        for side, expected in [(1, 97), (-1, 103)]:
            p = Position(side,1,100,0,100-3*side,100+.25*side,.1)
            self.assertEqual(traverse(p,100,104,96,100,high_first=side<0),(expected,'stop'))
            p = Position(side,1,100,0,100-3*side,100+.25*side,.1)
            fill, reason = traverse(p,100,104,96,100,high_first=side>0)
            self.assertAlmostEqual(fill, 100 + 3.9 * side)
            self.assertEqual(reason,'trail')

    def test_gap_fills_at_open(self):
        p = Position(1,1,100,0,97,100.25,.1)
        self.assertEqual(traverse(p,94,100,90,97,True),(94,'stop'))

    def test_signal_is_causal_and_short_filter_is_explicit(self):
        p = [100,103,100,104,90,92]
        df = pd.DataFrame({'close':p, 'high':[v+50 for v in p]})
        inputs = {'KERNEL_LEN':1,'KERNEL_ALPHA':2,'SHORT_LB':2,'SHORT_FILTER':.93}
        signals = bar_signals(df,inputs)
        self.assertEqual(signals.tolist(),[0,0,0,1,0,1])
        inputs['SHORT_FILTER'] = .1
        self.assertEqual(bar_signals(df,inputs).tolist(),[0,0,-1,1,-1,1])
        self.assertEqual(bar_signals(df.iloc[:-1],inputs).tolist(),[0,0,-1,1,-1])

    def test_next_open_and_funding_fee_ledger_reconcile(self):
        data = {'time':np.array([0,BAR,BAR+MINUTE]), 'bars':np.array([0,BAR,2*BAR]),
                'offsets':np.array([0,1,3]), 'ohlc':np.array([[100,100,100,100],
                [104,104,104,104],[104,104,104,104]]), 'funding':np.array([0,0,.01]),
                'signals':np.array([1,0]), 'close':np.array([100,104])}
        result = simulate(data,Rules(1,.001,.0025,.03),0,2*BAR,.001,0)
        self.assertEqual(result['trades'],1)
        self.assertAlmostEqual(result['fees'],2.08)
        self.assertAlmostEqual(result['funding'],-.1)
        self.assertAlmostEqual(result['equity'],997.82)


if __name__ == '__main__':
    unittest.main()
