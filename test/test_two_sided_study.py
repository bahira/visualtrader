import unittest
import numpy as np
from microstructure import Tape
from two_sided_study import Quote, queue_fill, replay, tick


class TwoSidedStudyTest(unittest.TestCase):
    def test_touch_volume_must_consume_visible_queue_first(self):
        prints = ([100,200,300,400], [100,100,100,99.99], [5,.21,.20,.30])
        self.assertIsNone(queue_fill(*prints,100,400,100,.30,1,.25))
        self.assertEqual(queue_fill(*prints,100,401,100,.30,1,.25),400)
        self.assertEqual(queue_fill(*prints,100,400,100,.15,1,.25),300)

    def test_tick_rounds_outward(self):
        self.assertAlmostEqual(tick(100.013,1),100.01)
        self.assertAlmostEqual(tick(100.013,-1),100.02)

    def test_trades_both_sides_with_unchanged_benchmark_inventory(self):
        t = np.arange(0,6000,100)
        n = len(t)
        sells = np.array([[400,99.98,2,1],[450,99.98,2,1]])
        buys = np.array([[500,100.02,2,0],[550,100.02,2,0]])
        tape = Tape(t,np.zeros((n,10)),np.full(n,100.),np.full(n,100.01),
                    np.full(n,99.99),np.zeros(n),np.full(n,99.99),sells[:,:2],
                    np.concatenate((sells,buys)),np.full(n,100.01))
        result = replay(tape,Quote(0,300,0,0))
        self.assertEqual((result['buys'],result['sells'],result['cycles']),(1,1,1))
        self.assertEqual(result['inventoryUnitsAtEnd'],1)
        self.assertAlmostEqual(result['incrementalNet'],-.18)
        self.assertAlmostEqual(result['makerFeesPaid'],.2)
        self.assertEqual(result['liquidationFeeDelta'],0)


if __name__ == '__main__':
    unittest.main()
