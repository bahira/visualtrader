import test from 'node:test';
import assert from 'node:assert/strict';
import {freshExecution, evaluateExecution, replayEvidence} from '../polymarket_paper.mjs';

test('decision only accepts post-latency source quotes and keeps the first eligible price',()=>{
  const initial = {time:1000,quotes:[{total:4},{total:6}]};
  const prob = {anchor:.63,momentum:.64,skew:.65};
  const stale = {time:1700,quotes:[{total:4,age:300},null]};
  const expensive = {time:1800,quotes:[{total:7,age:100},null]};
  const cheap = {time:1900,quotes:[{total:4,age:100},null]};
  assert.equal(freshExecution(stale.quotes[0],initial,stale),false);
  const r = evaluateExecution(prob,initial,[stale,expensive,cheap],2000);
  assert.equal(r.reasons.skew.reason,'Avantage disparu');
  assert.equal(r.fills.skew,undefined);
});

test('offline evidence reconstructs probabilities, fees and trade from raw inputs',()=>{
  const start=300_000;
  const m={ends:start+300_000,condition:'x',tokens:['1','2'],rate:.07};
  const candles=Array.from({length:121},(_,i)=>[start+i*1000,100+i*.001,0,0,100+i*.001,0,start+i*1000+999]);
  function book(time,age) {
    return {time,raw:m.tokens.map((token,i)=>({market:'x',asset_id:token,timestamp:time-age,
      min_order_size:5,asks:[{price:i===0?.4:.61,size:20}]}))};
  }
  const evidence={market:m,candles,featureTime:start+121_000,initial:book(start+121_100,50),
    attempts:[book(start+121_650,10)]};
  const first=replayEvidence(evidence);
  assert.equal(first.features.sample,start+120_999);
  assert.equal(first.fills.skew.side,0);
  assert.equal(first.fills.skew.fees,.168);
  assert.deepEqual(replayEvidence(JSON.parse(JSON.stringify(evidence))),first);
});
