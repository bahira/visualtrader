import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine, Portfolio, decode, evaluate, policy, walk} from '../engine.mjs';
import {synthetic} from '../market.mjs';

const book = {kind:'book',id:40,bids:[[99,100]],asks:[[101,100]]};
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, actual + ' vs ' + expected);

test('walk prices every consumed level and rejects insufficient depth', () => {
  assert.equal(walk([[100,1],[103,3]],3),102);
  assert.equal(walk([[100,1],[103,3]],5),null);
});

test('delayed fills reconcile cash, taker fees, slippage, and realized P&L', () => {
  const p = {...policy, maxSpreadBps:250};
  const wallet = new Portfolio(p,'test');
  wallet.intent('BUY',10000,'signal',100);
  assert.equal(wallet.execute(book,10249),undefined);
  const buy = wallet.execute(book,10250);
  approx(buy.price,101 * 1.0001);
  approx(buy.fee,buy.qty * buy.price * .001);
  approx(wallet.cash,policy.cash - buy.qty * buy.price - buy.fee);
  assert.ok(wallet.equity(book) < policy.cash);
  wallet.intent('SELL',11000,'exit',100);
  const sell = wallet.execute(book,11250);
  approx(sell.price,99 * .9999);
  approx(wallet.fees,buy.fee + sell.fee);
  approx(wallet.cash,policy.cash + wallet.net);
  approx(sell.net,sell.gross - wallet.fees);
  assert.equal(wallet.trades,1);
  assert.equal(wallet.position,null);
});

test('wide, expired and illiquid orders cannot mutate the ledger', () => {
  for (const [p, depth, delay, reason] of [
    [policy,book,250,'Spread trop large'],
    [policy,book,4000,'Ordre expiré'],
    [{...policy,maxSpreadBps:250},{...book,asks:[[101,0.1]]},250,'Profondeur insuffisante'],
  ]) {
    const wallet = new Portfolio(p,'test');
    wallet.intent('BUY',10000,'signal',100);
    assert.equal(wallet.execute(depth,10000+delay).reason,reason);
    assert.equal(wallet.cash,policy.cash);
    assert.equal(wallet.pending,null);
  }
});

test('promotion requires held-out result, sufficient data and superiority to cash and incumbent', () => {
  const rows = [{id:'new',score:3,trades:5},{id:'old',score:4,trades:8}];
  assert.equal(evaluate(rows,null,'old',1,policy).pass,false);
  assert.equal(evaluate(rows,'new','old',1,policy).pass,false);
  assert.equal(evaluate(rows,'new',null,.9,policy).pass,false);
  assert.equal(evaluate(rows,'new',null,1,policy).pass,true);
  rows[0].trades = 4;
  assert.equal(evaluate(rows,'new',null,1,policy).pass,false);
});

test('feed gaps clear entries and never synthesize missing candles', () => {
  const config = {...policy,maxSpreadBps:250};
  const engine = new Engine({config});
  let time;
  for (const [recv,message] of synthetic(200000,110)) {
    time = recv;
    engine.handle(decode(message),recv);
  }
  assert.ok(engine.context);
  engine.active.intent('BUY',time,'test',100);
  const t = engine.candles.at(-1).t + 7000;
  engine.handle({kind:'candle',t,closed:true,c:100},time+7000);
  assert.equal(engine.count.gaps,6);
  assert.equal(engine.active.pending,null);
  assert.equal(engine.context,null);
  engine.connectionLost(time+7000);
  assert.equal(engine.book,null);
  assert.equal(engine.last.candle,undefined);
});

test('a restored position can exit before indicators warm up', () => {
  const started = 400_000;
  const original = new Engine();
  original.active.intent('BUY',started,'test',100);
  original.active.p = {...policy,maxSpreadBps:250};
  original.active.execute(book,started+250);
  const restored = new Engine({saved:original.checkpoint()});
  restored.handle({...book,id:41},started+1000);
  restored.handle({kind:'candle',t:started,closed:true,c:100},started+1000);
  assert.equal(restored.active.pending?.side,'SELL');
  restored.handle({...book,id:42},started+1400);
  assert.equal(restored.active.position,null);
  assert.equal(restored.active.trades,1);
});

test('pause cancels only new entries', () => {
  const engine = new Engine();
  engine.active.intent('BUY',1000,'test',100);
  engine.pause(true,1100);
  assert.equal(engine.active.pending,null);
  engine.active.intent('SELL',1200,'test',100);
  engine.pause(true,1300);
  assert.equal(engine.active.pending.side,'SELL');
});

test('synthetic replay delays active execution until after validation', () => {
  const records=[];
  const engine = new Engine({log:(kind,row) => records.push([kind,row])});
  for (const [recv,message] of synthetic(200000,3800)) engine.handle(decode(message),recv);
  const promotion = records.find(([kind,row]) => kind === 'review' && row.promoted);
  const first = records.find(([kind,row]) => kind === 'fill' && row.wallet === 'Actif');
  assert.ok(promotion && first);
  assert.ok(first[1].time > promotion[1].time);
  assert.ok(promotion[1].time >= 200000 + 2 * policy.windowMs);
  for (const [kind,row] of records) {
    if (kind === 'fill') assert.ok(row.latencyMs >= policy.latencyMs);
  }
  assert.ok(engine.active.trades > 0);
  assert.ok(engine.active.fees > 0);
});

test('delayed Binance candles invalidate trading freshness', () => {
  const engine = new Engine();
  engine.handle({...book,id:41},8000);
  engine.handle({kind:'candle',t:1000,exchange:1999,closed:true,c:100},8000);
  assert.equal(engine.fresh(8000),false);
});
