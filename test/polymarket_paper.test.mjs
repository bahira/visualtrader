import test from 'node:test';
import assert from 'node:assert/strict';
import {market,winner,features,estimate,quote} from '../polymarket_paper.mjs';

const start = 300_000;
const span = {eventStartTime:new Date(start).toISOString(),endDate:new Date(start+300_000).toISOString(),
  acceptingOrders:true,closed:false,outcomes:'["Up","Down"]',clobTokenIds:'["55","66"]',
  conditionId:'test',resolutionSource:'https://data.chain.link/streams/btc-usd-twap-60s-streams',
  description:'time-weighted average price (TWAP)',feesEnabled:true,feeSchedule:{exponent:1,rate:.07}};

test('feature uses only closed consecutive bars and detects signed semivariance',()=>{
  const candles = Array.from({length:35},(_,i)=>[start+i*1000,100+i,0,0,100+i,0,start+i*1000+999]);
  const f = features(candles,start,start+31_100);
  assert.equal(f.skew,1);
  assert.equal(f.sample,start+30_999);
  assert.ok(estimate(f,150).skew >= estimate(f,150).momentum);
  assert.equal(features(candles.filter((_,i)=>i!==10),start,start+31_100),null);
});

test('validates market contract and uses only confirmed oracle resolution',()=>{
  assert.equal(market(span,start).rate,.07);
  assert.equal(market({...span,resolutionSource:'elsewhere'},start),null);
  const closed={...span,closed:true,outcomePrices:'["0","1"]'};
  assert.equal(winner(closed,'test'),null);
  assert.equal(winner({...closed,umaResolutionStatus:'resolved'},'test'),1);
  assert.equal(winner({...closed,umaResolutionStatus:'resolved'},'other'),null);
});

test('sweeps asks, validates matching token and timestamp, and charges per price',()=>{
  const raw={market:'test',asset_id:'55',timestamp:4000,min_order_size:'5',
    asks:[{price:'.60',size:'7'},{price:'.50',size:'4'}]};
  const q=quote(raw,'55','test',10,.07,4300);
  assert.equal(q.notional,5.6);
  assert.equal(q.fees,.1708);
  assert.equal(quote(raw,'55','test',10,.07,9000),null);
  assert.equal(quote(raw,'66','test',10,.07,4300),null);
  assert.equal(quote(raw,'55','test',12,.07,4300),null);
});
