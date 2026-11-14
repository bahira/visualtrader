import unittest
from maker_study import flow_fill, stats


class MakerStudyTest(unittest.TestCase):
    def test_excludes_touch_prearrival_and_cancel_boundary(self):
        data = ([10,20,30,40,50,60],[99,99,100,99,98,99],[1,.1,10,.15,.2,10])
        self.assertEqual(flow_fill(*data,10,60,100,.4,True),50)
        self.assertIsNone(flow_fill(*data,10,50,100,.4,True))

    def test_applies_trade_through_in_both_directions(self):
        data = ([10,20,30],[100,101,102],[100,.1,.2])
        self.assertEqual(flow_fill(*data,0,40,100,.25,False),30)
        self.assertIsNone(flow_fill(*data,0,40,100,.25,True))

    def test_maker_and_taker_fees_and_gap_accounting(self):
        result = stats(([(250,251,True,False),(250,249,False,True)],3),2,10,1)
        self.assertAlmostEqual(result['fees'],.3992)
        self.assertAlmostEqual(result['pnl'],-.3992)
        self.assertAlmostEqual(result['cleanPnl'],.8998)
        self.assertAlmostEqual(result['makerPnl']+result['fallbackPnl'],result['pnl'])
        self.assertEqual(result['ambiguous'],1)


if __name__ == '__main__':
    unittest.main()
