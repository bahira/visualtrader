import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcile} from '../depth_capture.mjs';

test('depth intervals accept overlap, ignore duplicates and flag missing sequence IDs', () => {
  assert.equal(reconcile(100,99,100),'old');
  assert.equal(reconcile(100,99,101),'apply');
  assert.equal(reconcile(100,101,102),'apply');
  assert.equal(reconcile(100,102,104),'gap');
});
import {LocalBook} from '../local_book.mjs';

test('local depth applies absolute sizes, removes zeroes and refuses a crossed or gapped book', () => {
  const book = new LocalBook({lastUpdateId:10,bids:[[100,5],[98,2]],asks:[[101,4],[103,1]]});
  assert.equal(book.apply({U:9,u:10,b:[[100,9]],a:[]}),'old');
  assert.equal(book.apply({U:10,u:11,b:[[100,0],[99,3]],a:[[102,2]]}),'apply');
  assert.deepEqual(book.best(),{id:11,bid:99,ask:101,bidQty:3,askQty:4});
  assert.deepEqual(book.depth(2),{lastUpdateId:11,bids:[[99,3],[98,2]],asks:[[101,4],[102,2]]});
  assert.equal(book.apply({U:13,u:14,b:[],a:[]}),'gap');
  assert.equal(book.best(),null);
  assert.equal(book.apply({U:12,u:12,b:[],a:[]}),'gap');
  const crossed = new LocalBook({lastUpdateId:10,bids:[[102,1]],asks:[[101,2]]});
  assert.equal(crossed.best(),null);
});
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {reconstruct} from '../depth_replay.mjs';

test('offline replay never backdates a REST snapshot and marks a dropped sequence', async () => {
  const folder = await mkdtemp(join(tmpdir(),'visualtrader-depth-'));
  const file = join(folder,'capture.ndjson');
  const records = [
    [100,'depth@100ms',{U:10,u:11,b:[[99,3]],a:[]}],
    [120,'snapshot',{lastUpdateId:10,bids:[[100,1]],asks:[[101,2]]}],
    [200,'depth@100ms',{U:12,u:12,b:[[100,0]],a:[]}],
    [300,'depth@100ms',{U:14,u:14,b:[],a:[]}],
    [350,'trade',{m:true,p:'99',q:'2'}],
    [400,'snapshot',{lastUpdateId:14,bids:[[98,1]],asks:[[103,2]]}],
    [500,'depth@100ms',{U:15,u:15,b:[],a:[]}],
  ];
  await writeFile(file,records.map(([recv,stream,data]) =>
    JSON.stringify({recv,stream:'btcusdt@'+stream,data})).join('\n'));
  const db = new DatabaseSync(':memory:');
  try {
    const counts = await reconstruct(file,db);
    assert.deepEqual(counts,{depth:3,trades:1,gaps:1,snapshots:2});
    const rows = db.prepare('SELECT recv,json FROM market ORDER BY seq').all()
      .map(({recv,json}) => [recv,JSON.parse(json).stream]);
    assert.deepEqual(rows,[
      [120,'btcusdt@researchGap'],[120,'btcusdt@depth20@100ms'],[200,'btcusdt@depth20@100ms'],
      [300,'btcusdt@researchGap'],[350,'btcusdt@trade'],[400,'btcusdt@researchGap'],
      [500,'btcusdt@depth20@100ms'],
    ]);
    await assert.rejects(reconstruct(file,db), /Session déjà présente/);
  } finally {
    db.close();
    const {unlink,rmdir} = await import('node:fs/promises');
    await unlink(file);
    await rmdir(folder);
  }
});
