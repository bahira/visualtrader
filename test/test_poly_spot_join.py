import unittest

from poly_spot_join import benchmark, join


class JoinTests(unittest.TestCase):
    def test_features_use_both_clocks(self):
        trades = [(21000+i*1000, 21000+i*1000, 1, 1) for i in range(25)]
        trades += [(49999, 50000, 500, -1), (50000, 49999, 500, -1)]
        row, = join([{'time': 50000}], trades)
        self.assertEqual(row['flow'], {'trades': 25, 'activeSeconds': 25, 'imbalance': 1.0, 'acceleration': None})

    def test_thin_tape_leaves_feature_unknown(self):
        row, = join([{'time': 50000}], [(49900, 49800, 1, 1)])
        self.assertIsNone(row['flow']['imbalance'])

    def test_benchmark_scores_isolated_and_combined_on_same_market(self):
        quote = {'quote': {'total': 5, 'average': .5}}
        row = {'time': 1000, 'winner': 0, 'phase': 'prior', 'flow': {'imbalance': 1, 'acceleration': 1},
               'observed': {'initial': [quote, quote], 'samples': [{'barrier': 1500, 'sides': [quote, None]}]}}
        result = benchmark([row], 10, .04, .005)['prior'][500]
        self.assertLess(result['combined']['brier'],result['flow']['brier'])
        self.assertEqual(result['book']['fills'],0)
        self.assertEqual(result['combined']['fills'],1)
