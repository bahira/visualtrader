import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FastPaper} from '../fast-paper.mjs';
import {policy} from '../engine.mjs';

const book = {id:1,bids:[[64999.99,1]],asks:[[65000,1]]};
function drive(pocket, start, end, paused = false, depth = book) {
  for (let time = start; time < end; time += 100) pocket.tick(depth,time,paused);
}

test('fast paper delivers 12 cycles per healthy full minute and accounts for taker costs', () => {
  const events = [];
  const pocket = new FastPaper(policy,undefined,(kind,row) => events.push({kind,...row}));
  drive(pocket,60_000,180_000);
  const result = pocket.summary(book,180_000);
  assert.equal(result.cycles60,12);
  assert.equal(result.fills60,24);
  assert.equal(result.qualifiedMinutes,1);
  assert.equal(result.fullMinutes,1);
  assert.equal(result.wallet.trades,24);
  assert.equal(result.wallet.position,null);
  assert.equal(result.wallet.wins,0);
  const fees = events.filter(row => row.kind === 'fill').reduce((sum,row) => sum+row.fee,0);
  assert.ok(Math.abs(fees-result.wallet.fees) < 1e-8);
  assert.ok(Math.abs(result.wallet.cash - policy.cash - result.wallet.net) < 1e-8);
  assert.ok(result.wallet.net < -fees);
  assert.ok(events.filter(row => row.kind === 'fill').every(row => row.latencyMs >= policy.latencyMs));
});

test('depth sizing consumes multiple levels within the entry budget', () => {
  const pocket = new FastPaper(policy,undefined,() => {});
  const depth = {...book,asks:[[65000,.001],[65002,.01]]};
  drive(pocket,60_000,61_000,false,depth);
  assert.ok(pocket.wallet.position.price > 65002);
  assert.ok(pocket.wallet.cash >= policy.cash - pocket.rules.stake);
  assert.equal(pocket.rejections,0);
});

test('pause cancels entry, permits exit and avoids new cycles', () => {
  const pocket = new FastPaper(policy,undefined,() => {});
  drive(pocket,60_000,60_200);
  assert.equal(pocket.wallet.pending.side,'BUY');
  pocket.suspend(60_200,'pause');
  drive(pocket,60_200,65_000,true);
  assert.equal(pocket.entries,0);
  drive(pocket,65_000,65_600);
  assert.ok(pocket.wallet.position);
  drive(pocket,65_600,75_000,true);
  assert.equal(pocket.wallet.trades,1);
  assert.equal(pocket.entries,1);
});

test('restart preserves an open simulated position and skips elapsed minutes', () => {
  const started = new FastPaper(policy,undefined,() => {});
  drive(started,60_000,60_600);
  const restored = new FastPaper(policy,JSON.parse(JSON.stringify(started.checkpoint())),() => {});
  assert.equal(restored.wallet.pending,null);
  drive(restored,240_000,241_000,true);
  assert.equal(restored.wallet.trades,1);
  assert.equal(restored.entries,1);
  assert.equal(restored.summary(book,241_000).fullMinutes,2);
});

test('disconnected snapshot discards pending orders without adding simulated fills', () => {
  const pocket = new FastPaper(policy,undefined,() => {});
  drive(pocket,60_000,60_200);
  pocket.suspend(60_210,'disconnect',true);
  assert.equal(pocket.wallet.pending,null);
  assert.equal(pocket.rejections,1);
  assert.equal(pocket.summary(null,65_000).fills60,0);
});
