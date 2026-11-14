import test from 'node:test';
import assert from 'node:assert/strict';
import {nearTouch,replayPressure,results,signals} from '../poly_pressure.mjs';

const market = {condition:'c',tokens:['u','d']};
function snapshot(recv,source=recv) {
  const data = [['u',90,10],['d',10,90]].map(([asset_id,bid,ask])=>({event_type:'book',market:'c',asset_id,
    timestamp:source,bids:[{price:.49,size:bid}],asks:[{price:.51,size:ask}]}));
  return {recv,type:'data',data:JSON.stringify(data)};
}

test('pressure weights only near-touch depth in a valid uncrossed book',()=>{
  const book = {bids:new Map([[.49,80],[.48,20],[.20,10000]]),asks:new Map([[.51,10]])};
  assert.equal(nearTouch(book),.8);
  book.asks.set(.49,1);
  assert.equal(nearTouch(book),null);
});

test('samples use both clocks and persistent pressure requires the same connection epoch',()=>{
  const frames = [snapshot(4900),snapshot(9900)];
  assert.deepEqual(replayPressure(market,[...frames,snapshot(10000)],10000),{pressure:.8,persistence:.8});
  assert.deepEqual(replayPressure(market,[frames[0],{recv:6000,type:'reset'},frames[1]],10000),
    {pressure:.8,persistence:null});
  assert.equal(replayPressure(market,[frames[0],snapshot(9900,10000)],10000),null);
});

test('isolated and combined scores are paired; missing execution stays unknown',()=>{
  const p = signals(.5,.8,.8,.8);
  assert.equal(p.book,.5);
  assert.ok(p.combined>p.depth && p.depth>p.impulse);
  const quote={total:5,average:.5};
  const observed = {initial:[{quote},{quote}],samples:[{barrier:1250,sides:[null,{quote}]}]};
  const result = results({features:{pressure:.8,persistence:.8},impulse:.8},
    {time:1000,winner:0,observed},{shares:10,stressPerLeg:.005,directionalEdge:.04})[250];
  assert.equal(result.book.status,'pass');
  assert.equal(result.combined.status,'unknown');
  assert.equal(result.combined.stress,null);
  assert.ok(result.combined.brier<result.impulse.brier);
});
