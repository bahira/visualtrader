import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {LocalBook} from './local_book.mjs';

export async function reconstruct(input, db, session=1) {
  db.exec('CREATE TABLE IF NOT EXISTS market(seq INTEGER PRIMARY KEY, session INTEGER, recv INTEGER, json TEXT)');
  if (db.prepare('SELECT 1 FROM market WHERE session=? LIMIT 1').get(session)) {
    throw new Error('Session déjà présente dans la base de sortie');
  }
  const insert = db.prepare('INSERT INTO market(session,recv,json) VALUES(?,?,?)');
  let book, buffered = [];
  const counts = {depth:0, trades:0, gaps:0, snapshots:0};
  function append(recv, stream, data) {
    insert.run(session,recv,JSON.stringify({stream,data}));
  }
  const lines = createInterface({input:createReadStream(input),crlfDelay:Infinity});
  db.exec('BEGIN');
  try {
    for await (const line of lines) {
      if (!line) continue;
      const {recv,stream,data} = JSON.parse(line);
      if (stream === 'btcusdt@snapshot') {
        append(recv,'btcusdt@researchGap',{});
        book = new LocalBook(data);
        counts.snapshots++;
        let bridged = false;
        for (const delta of buffered) {
          const status = book.apply(delta);
          if (status === 'gap') { book = null; counts.gaps++; break; }
          bridged ||= status === 'apply';
        }
        buffered = [];
        const top = bridged && book?.depth(20);
        if (top) {
          append(recv,'btcusdt@depth20@100ms',top);
          counts.depth++;
        }
      } else if (stream === 'btcusdt@depth@100ms') {
        const status = book?.apply(data);
        if (status === 'gap') {
          book = null;
          counts.gaps++;
          append(recv,'btcusdt@researchGap',{});
        }
        if (!book) {
          buffered.push(data);
          if (buffered.length > 1000) buffered.shift();
        } else if (status === 'apply') {
          const top = book.depth(20);
          if (top) { append(recv,'btcusdt@depth20@100ms',top); counts.depth++; }
        }
      } else if (stream === 'btcusdt@trade') {
        append(recv,stream,data);
        counts.trades++;
      }
    }
    if (!counts.depth) throw new Error('Aucun carnet réconcilié');
    db.exec('COMMIT');
    return counts;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    lines.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, ,input, output, id='1'] = process.argv;
  const session = Number(id);
  if (!input || !output || !Number.isSafeInteger(session) || session <= 0) {
    throw new Error('node depth_replay.mjs capture.ndjson output.sqlite [session]');
  }
  const database = new DatabaseSync(output);
  try {
    console.log(JSON.stringify(await reconstruct(input,database,session),null,2));
  } finally {
    database.close();
  }
}
