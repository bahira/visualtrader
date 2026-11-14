import test from 'node:test';
import assert from 'node:assert/strict';
import {forecasts,choose} from '../poly_research.mjs';

test('twap proxy is causal and refuses gapped source windows',()=>{
  const window=Array.from({length:61},(_,i)=>[1000*i,0,0,0,100+i/100,0,999+1000*i]);
  const row={features:{anchor:100,sigma:.0001,momentum:.0002},prob:{market:.55,anchor:.56,momentum:.57,skew:.58},initial:{time:60_000}};
  const raw={featureTime:60_000,market:{ends:240_000},candles:window};
  const first=forecasts(row,raw);
  assert.ok(first.twapDrift>first.twapProxy);
  window[60][4]=3000;
  assert.deepEqual(forecasts(row,raw),first);
  assert.equal(forecasts(row,{...raw,candles:window.filter((_,i)=>i!==40)}).twapProxy,undefined);
});

test('choose evaluates both outcomes using all-in cost per share',()=>{
  assert.equal(choose(.6,[{total:5.8},{total:4.2}],10,.04),null);
  assert.equal(choose(.4,[{total:4.5},{total:5.3}],10,.04).side,1);
});
