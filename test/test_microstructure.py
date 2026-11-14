import unittest
import numpy as np

from microstructure import Tape, Window, imbalance, ofi, opportunities, passive, walk


def sample(trades=(), gap=False):
    time = np.arange(0,8000,100)
    span = np.zeros(len(time),dtype=int)
    if gap:
        span[10:] = 1
    return Tape(time,np.zeros((len(time),10)),np.full(len(time),100.),
                np.full(len(time),100.01),np.full(len(time),99.99),
                span,np.full(len(time),99.99),np.array(trades,dtype=float).reshape(-1,2))


class MicrostructureTest(unittest.TestCase):
    def test_visible_depth_and_book_flow(self):
        self.assertEqual(walk([(100,1),(102,2)],2),101)
        self.assertTrue(np.isnan(walk([(100,1)],2)))
        self.assertAlmostEqual(imbalance(3,1),.5)
        self.assertEqual(ofi((99,2,101,3),(100,4,101,1)),6)
        force = Window(500)
        force.push(0,2,2)
        force.push(400,-1,1)
        self.assertAlmostEqual(force.ratio(450),1/3)
        self.assertEqual(force.ratio(500),-1)

    def test_crosses_book_after_delay_and_rejects_gaps(self):
        cost, gross, exits = opportunities(sample(),500,(250,10,1))
        self.assertLess(cost[0],-22)
        self.assertEqual(gross[0],0)
        self.assertEqual(exits[0],11)
        cost, _, _ = opportunities(sample(gap=True),500,(250,10,1))
        self.assertTrue(np.isnan(cost[0]))

    def test_passive_requires_trade_below_limit_after_arrival(self):
        signals = np.zeros(80,dtype=bool)
        signals[0] = True
        row = passive(sample([(200,99.98),(400,99.99)]),signals)
        self.assertEqual(row['posted'],1)
        self.assertEqual(row['cycles'],0)
        row = passive(sample([(400,99.98)]),signals)
        self.assertEqual(row['cycles'],1)
        self.assertLess(row['netUsdt'],0)
        row = passive(sample([(400,99.98)],gap=True),signals)
        self.assertEqual(row['unpricedExits'],1)


if __name__ == '__main__':
    unittest.main()
