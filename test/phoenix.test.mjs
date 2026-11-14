import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PhoenixSpot, errfKernel, inflection} from '../phoenix.mjs';
import {policy} from '../engine.mjs';

test('Phoenix matches the source sech kernel weighting and inflection orientation', () => {
  const input = Array.from({length:25},(_,i) => 100+i*i);
  assert.ok(Math.abs(errfKernel(input) - 319.4690663449315) < 1e-9);
  assert.equal(inflection(10,9,10),'long');
  assert.equal(inflection(9,10,9),'short');
  assert.equal(inflection(9,10,11),null);
});
test('Phoenix handles only closed consecutive candles and blocks entries after a gap', () => {
  const p = new PhoenixSpot(policy,undefined,() => {});
  for (let i=0; i<55; ++i) p.candle({t:i*1000,c:100+(i-31)**2,closed:true});
  assert.equal(p.bias,'long');
  assert.equal(p.signals.long,1);
  p.candle({t:56_000,c:100,closed:false});
  assert.equal(p.summary(null,56_000).warmup,25);
  p.candle({t:57_000,c:100,closed:true});
  const book = {bids:[[99.99,4]],asks:[[100,4]]};
  p.tick(book,57_100,false);
  assert.equal(p.bias,null);
  assert.equal(p.fast.wallet.pending,null);
  assert.equal(p.summary(book,57_100).warmup,1);
});
