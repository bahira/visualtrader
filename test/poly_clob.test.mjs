import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Books,replayClob} from '../poly_clob.mjs';
const m={condition:'cond',slug:'market',tokens:['u','d'],ends:10000,rate:.07,minimum:5};
const snapshot={event_type:'book',market:'cond',asset_id:'u',timestamp:1100,
  asks:[{price:.51,size:20}],bids:[{price:.48,size:20}]};
const delta=(timestamp,size)=>({event_type:'price_change',market:'cond',timestamp,
  price_changes:[{asset_id:'u',side:'SELL',price:.51,size}]});

test('depth updates are absolute, reject old changes and require a snapshot after reset',()=>{
  const b=new Books(m);
  assert.deepEqual(b.apply(delta(1200,3)),[]);
  b.apply(snapshot);
  b.apply(delta(1300,7));
  b.apply(delta(1250,99));
  assert.deepEqual(b.raw('u').asks,[{price:.51,size:7}]);
  b.apply(delta(1400,0));
  assert.deepEqual(b.raw('u').asks,[]);
  b.reset();
  b.apply(delta(1500,99));
  assert.equal(b.raw('u'),null);
});

test('replay excludes pre-latency and reports the first insufficient book as a rejection',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE markets(slug,info); CREATE TABLE frames(seq INTEGER PRIMARY KEY,slug,recv,type,data)');
    db.prepare('INSERT INTO markets VALUES(?,?)').run(m.slug,JSON.stringify(m));
    const add=db.prepare('INSERT INTO frames(slug,recv,type,data) VALUES(?,?,?,?)');
    add.run(m.slug,1110,'data',JSON.stringify([snapshot]));
    add.run(m.slug,1520,'data',JSON.stringify([delta(1450,6)]));
    add.run(m.slug,1600,'data',JSON.stringify([delta(1560,6)]));
    add.run(m.slug,1700,'data',JSON.stringify([delta(1660,99)]));
    assert.deepEqual(replayClob(db,m.slug,1200,0,300),{recv:1600,source:1560,bid:.48,ask:.51,quote:null});
    assert.equal(replayClob(db,m.slug,1000,0,500),null);
    db.exec('DELETE FROM frames WHERE seq>1');
    add.run(m.slug,1250,'reset','[]');
    add.run(m.slug,1600,'data',JSON.stringify([{...snapshot,timestamp:1590}]));
    assert.equal(replayClob(db,m.slug,1200,0,300),null);
  } finally { db.close(); }
});
