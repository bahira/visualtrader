import test from 'node:test';
import assert from 'node:assert/strict';
import {audit,pairedInterval} from '../poly_pressure_audit.mjs';

test('resampling needs ten blocks and keeps the market-weighted paired difference',()=>{
  assert.equal(pairedInterval(Array(9).fill({n:1,sum:2})),null);
  const blocks = Array.from({length:10},(_,i)=>({n:i+1,sum:2*(i+1)}));
  assert.deepEqual(pairedInterval(blocks),[2,2]);
});

test('a missing fill is bounded separately and an isolated gain is exposed',()=>{
  const book = {brier:.2,status:'pass',stress:0};
  const model = (stress,side)=>({brier:.1,status:stress==null?'unknown':'fill',stress,side});
  const rows = [model(4,0),model(-2,1),model(null)].map((outcome,i)=>({phase:'prior',start:i*3_600_000,
    metrics:{250:{book,impulse:outcome}}}));
  const m = audit(rows,{shares:10,stressPerLeg:.005}).prior[250].impulse;
  assert.equal(m.net,2);
  assert.equal(m.netWithoutBest,-2);
  assert.equal(m.pairedNet,2);
  assert.equal(m.pairedExecutions,2);
  assert.ok(Math.abs(m.pessimisticNet-(-8.05))<1e-9);
  assert.equal(m.hours,3);
  assert.equal(m.days,1);
  assert.deepEqual(m.fillsBySide,[1,1]);
  assert.deepEqual(m.netBySide,[4,-2]);
  assert.equal(m.brierRangeByDay,null);
});
