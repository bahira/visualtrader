import unittest
from paper_campaign import aggregate, verdict


class CampaignTest(unittest.TestCase):
    def blocks(self):
        result = {}
        for fee in ('10','2','0'):
            result[fee] = {model:{'incrementalNet':1,'cycles':101,'minutes':10}
                           for model in ('test','queueScenario','stress')}
        return [{'utcDay':f'2026-11-{14+i//8}','replay':result} for i in range(24)]

    def test_complete_positive_campaign(self):
        blocks = self.blocks()
        result = aggregate(blocks)
        self.assertEqual(len(result['10']['test']['days']),3)
        self.assertEqual(result['10']['test']['net'],24)
        self.assertEqual(verdict(blocks,result,24),'passed_paper_only')

    def test_partial_campaign_and_bad_stress_are_not_promoted(self):
        blocks = self.blocks()
        self.assertEqual(verdict(blocks[:-1],aggregate(blocks[:-1]),24),'insufficient')
        result = aggregate(blocks)
        result['10']['stress']['cyclesPerMinute'] = 9.9
        self.assertEqual(verdict(blocks,result,24),'rejected')

    def test_losing_day_rejects_even_with_positive_total(self):
        blocks = self.blocks()
        result = aggregate(blocks)
        result['10']['queueScenario']['days']['2026-11-15']['pnl'] = -1
        self.assertEqual(verdict(blocks,result,24),'rejected')


if __name__ == '__main__':
    unittest.main()
