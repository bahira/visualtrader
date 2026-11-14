import test from 'node:test';
import assert from 'node:assert/strict';
import {replayExecution} from '../poly_clob.mjs';
import {dailyRange,evaluate,openingResidual,plan} from '../poly_edge.mjs';

const market = {condition:'c',tokens:['u','d'],ends:10_000,minimum:5,rate:.07};
const snapshot=(asset_id,timestamp,price,size=20)=>({event_type:'book',market:'c',asset_id,timestamp,
  asks:[{price,size}],bids:[{price:price-.01,size:20}]});
const frame=(recv,...events)=>({recv,type:'data',data:JSON.stringify(events)});
const policy = {shares:10,pairMargin:.02,stressPerLeg:.005,directionalEdge:.04,pairSkewMs:100};

test('execution uses atomic frames, observes first rejection and respects synchrony and reconnects',()=>{
  const initial = frame(900,snapshot('u',900,.45),snapshot('d',900,.49));
  const first = frame(1255,snapshot('u',1254,.42,3),snapshot('d',1254,.45));
  const second = frame(1270,snapshot('u',1269,.43),snapshot('d',1269,.46));
  const run = (...rest)=>replayExecution(market,[initial,...rest],1000,[250],10,2500,100);
  const observed = run(first,second);
  assert.equal(observed.samples[0].sides[0].quote,null);
  assert.equal(observed.samples[0].pair[0].quote,null);
  assert.equal(run(frame(1290,snapshot('u',1289,.44)),frame(1440,snapshot('d',1439,.46))).samples[0].pair,null);
  assert.deepEqual(run({recv:1100,type:'reset'},second).samples[0].sides,[null,null]);
  const samePacket = frame(1290,snapshot('u',1288,.40),snapshot('d',1289,.46),snapshot('u',1289,.44));
  assert.equal(run(samePacket).samples[0].sides[0].ask,.44);
  assert.equal(replayExecution(market,[frame(1000,snapshot('u',999,.44),snapshot('d',999,.46)),second],
    1000,[250],10,2500,100).initial,null);
});

test('pair economics include both legs, both fees, one-leg loss, and observable execution',()=>{
  const obs = (total)=>({recv:900,source:900,quote:{total,fees:.1}});
  const initial = [obs(4.5),obs(4.9)];
  const trial = {prob:{market:.5,skew:.5},features:{sigma:.0001,momentum:0}};
  const selection = plan({trial},{initial},policy).pair;
  assert.equal(selection.legs,2);
  assert.equal(plan({trial},{initial:[initial[0],{...initial[1],source:799}]},policy).pair,null);
  assert.equal(evaluate(selection,{pair:null},0,policy).state,'unknown');
  assert.equal(evaluate(selection,{pair:[obs(4.9),obs(4.9)]},0,policy).state,'reject');
  const result = evaluate(selection,{pair:initial},0,policy);
  assert.equal(result.state,'fill');
  assert.ok(Math.abs(result.stress-.5)<1e-9);
  assert.equal(result.oneLegLoss,4.95);
  assert.deepEqual(result,evaluate(selection,{pair:initial},1,policy));
});

test('proxy uses two closed contiguous windows and never looks beyond decision time',()=>{
  const start = 100_000, time = 220_000;
  const candles = Array.from({length:241},(_,i)=>[1000*i,0,0,0,i>=160?101:100,0,i*1000+999]);
  const raw = {candles,featureTime:time,market:{ends:400_000}};
  const base = openingResidual(raw,start,time,.0001);
  assert.ok(base>0);
  candles[220][4]=9000;
  assert.equal(openingResidual(raw,start,time,.0001),base);
  assert.equal(openingResidual({...raw,candles:candles.filter(c=>c[0]!==70_000)},start,time,.0001),null);
  assert.equal(openingResidual({...raw,featureTime:time+1},start,time,.0001),null);
});

test('daily interval requires ten days and is deterministic',()=>{
  assert.equal(dailyRange(Array(9).fill(1)),null);
  assert.deepEqual(dailyRange(Array(10).fill(-2)),[-2,-2]);
  const days = [-5,0,0,0,0,0,1,2,2,3];
  assert.deepEqual(dailyRange(days),dailyRange(days));
  assert.ok(dailyRange(days)[0]<0);
});
