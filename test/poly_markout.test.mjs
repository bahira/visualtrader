import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aggregate,bidProceeds,flowEntries,replayExits} from '../poly_markout.mjs';

const market = {condition:'c',tokens:['u','d'],ends:100_000,rate:.07,minimum:5};
const snapshot = (timestamp,size)=>({event_type:'book',market:'c',asset_id:'u',timestamp,
  bids:[{price:.60,size}],asks:[{price:.65,size:20}]});
const frame = (recv,...events)=>({recv,type:'data',data:JSON.stringify(events)});
const entry = {model:'impulse',latency:250,side:0,recv:2000,quote:{total:5.40}};
const run = frames=>replayExits(market,frames,[entry],10,.005);

test('bid proceeds walk all levels and subtract rounded fee on exit',()=>{
  const exit = bidProceeds([[.5,9],[.6,3]],10,.07);
  assert.equal(exit.fees,.1729);
  assert.ok(Math.abs(exit.net-5.1271)<1e-9);
  assert.equal(bidProceeds([[.5,9]],10,.07),null);
});

test('first atomic executable observation wins and insufficient depth cannot be filled later',()=>{
  const exits = run([
    frame(1000,snapshot(1000,20)),frame(2251,snapshot(2240,20)),
    frame(2260,snapshot(2258,12),snapshot(2259,2)),frame(2270,snapshot(2269,20)),
    frame(3020,snapshot(3010,20)),frame(7020,snapshot(7010,20))
  ]);
  assert.equal(exits[0].state,'insufficient-depth');
  assert.equal(exits[0].recv,2260);
  assert.equal(exits[1].state,'priced');
  assert.ok(Math.abs(exits[1].stressedNet-.332)<1e-9);
  assert.equal(exits[3].state,'unknown');
  assert.equal(aggregate([{phase:'prior',exits}]).prior[250].impulse[15000].mean,null);
});

test('an exit after a reconnect or grace period remains unknown',()=>{
  assert.equal(run([frame(1000,snapshot(1000,20)),{recv:2100,type:'reset'},
    frame(2300,snapshot(2299,20))])[0].state,'unknown');
  assert.equal(run([frame(1000,snapshot(1000,20)),frame(3251,snapshot(3251,20))])[0].state,'unknown');
});

test('execution candidates apply the same per-leg threshold at signal and fill',()=>{
  const observed = {initial:[{quote:{total:5,average:.5}},{quote:{total:5,average:.5}}],
    samples:[{barrier:1000,sides:[{recv:1000,quote:{total:5}},null]},
             {barrier:1250,sides:[{recv:1250,quote:{total:5.5}},null]}]};
  const candidates = flowEntries({observed,time:750,flow:{imbalance:0,acceleration:1}},
    {directionalEdge:.04,stressPerLeg:.005,shares:10});
  assert.deepEqual(candidates.map(x=>[x.model,x.latency]),[['impulse',250],['combined',250]]);
});

test('capacity uses exact entry snapshot, full bid depth and the original edge rule',()=>{
  const buy = {...snapshot(2000,50),asks:[{price:.64,size:10},{price:.68,size:40}]};
  const original = {...entry,source:2000,target:.731,quote:{total:6.56128}};
  const exit = frame(2250,snapshot(2250,30));
  const before = [frame(2000,buy),exit];
  const result = replayExits(market,before,[original],10,.005,.04);
  const points = result[0].liquidity;
  assert.deepEqual(points.map(p=>p.state),['priced','priced','priced','entry-edge','entry-depth']);
  assert.ok(points[1].stressedNet<0);
  assert.equal(result[1].liquidity[1].state,'exit-unknown');
  assert.equal(replayExits(market,before,[{...original,target:.8}],10,.005,.04)[0].liquidity[3].state,'exit-depth');
  assert.equal(replayExits(market,before,[{...original,source:1999}],10,.005,.04)[0].liquidity,null);
  const summary = aggregate([{phase:'prior',exits:result}]);
  assert.equal(summary.prior[250].impulse[250].liquidity[50].rejections['entry-edge'],1);
});
