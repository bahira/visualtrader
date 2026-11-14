import {createWriteStream, mkdirSync} from 'node:fs';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {host} from './engine.mjs';

import {LocalBook, reconcile} from './local_book.mjs';
export {reconcile};

const SNAPSHOT_URL = 'https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=1000';

async function record(seconds, output) {
  const writer = createWriteStream(output,{flags:'wx'});
  await once(writer,'open');
  const socket = new WebSocket(host + '/stream?streams=btcusdt@depth@100ms/btcusdt@trade/btcusdt@bookTicker');
  let error;
  const report = {depth:0, trade:0, bookTicker:0, sequenceGaps:0, last:null, queueOverruns:0};
  const started = Date.now();
  const lifetime = new AbortController();
  let book, syncing = false, buffered = [];
  const tickers = new Map(), tops = new Map();
  Object.assign(report,{snapshots:0, validBooks:0, invalidBooks:0,
    matchingUpdateIds:0, matchingQuotes:0, mismatchedQuotes:0});
  function save(stream,payload,recv) {
    writer.write(JSON.stringify({recv,stream,data:payload})+'\n');
    if (writer.writableLength <= 8*1024*1024) return;
    report.queueOverruns++;
    throw new Error('Le disque ne suit pas le débit de capture');
  }

  function compare(top,ticker) {
    report.matchingUpdateIds++;
    const consistent = top.bid === Number(ticker.b) && top.ask === Number(ticker.a) &&
      top.bidQty === Number(ticker.B) && top.askQty === Number(ticker.A);
    report[consistent ? 'matchingQuotes' : 'mismatchedQuotes']++;
  }

  function track(map,id,value) {
    map.set(id,value);
    if (map.size > 3000) map.delete(map.keys().next().value);
  }

  function apply(delta) {
    switch (book.apply(delta)) {
      case 'gap': book = null; return false;
      case 'old': return true;
      default: {
        const top = book.best();
        report[top ? 'validBooks' : 'invalidBooks']++;
        if (top) {
          const ticker = tickers.get(top.id);
          if (ticker) compare(top,ticker);
          else track(tops,top.id,top);
        }
        return true;
      }
    }
  }

  async function synchronize() {
    if (syncing) return;
    syncing = true;
    try {
      while (!book && !lifetime.signal.aborted) {
        const response = await fetch(SNAPSHOT_URL,{
          signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(7000)])
        });
        if (!response.ok) throw new Error('Snapshot Binance HTTP '+response.status);
        const snapshot = await response.json();
        if (lifetime.signal.aborted) break;
        report.snapshots++;
        save('btcusdt@snapshot',snapshot,Date.now());
        book = new LocalBook(snapshot);
        const messages = buffered;
        buffered = [];
        for (let i=0;i<messages.length;i++) {
          if (apply(messages[i])) continue;
          buffered = messages.slice(i);
          break;
        }
        if (!book) await new Promise(resolve => setTimeout(resolve,300));
      }
    } catch (err) {
      if (!lifetime.signal.aborted) { error = err; done(); }
    } finally {
      syncing = false;
    }
  }
  let done;
  const end = new Promise(resolve => { done = resolve; });
  const timer = setTimeout(done,seconds*1000);
  writer.on('error',err => { error = err; done(); });
  try {
    socket.onerror = () => { error = new Error('Connexion Binance interrompue'); done(); };
    socket.onclose = () => {
      if (Date.now() - started < seconds * 1000) {
        error ??= new Error('Capture interrompue avant échéance');
      }
      done();
    };
    socket.onmessage = ({data}) => {
      try {
        const recv = Date.now();
        const {stream,data:payload} = JSON.parse(data);
        save(stream,payload,recv);
        if (stream === 'btcusdt@depth@100ms') {
          report.depth++;
          if (report.last !== null && reconcile(report.last,payload.U,payload.u) === 'gap') {
            report.sequenceGaps++;
          }
          report.last = Math.max(report.last ?? 0,payload.u);
          if (!book || !apply(payload)) {
            buffered.push(payload);
            if (buffered.length > 1000) throw new Error('Synchronisation du carnet trop lente');
            void synchronize();
          }
        } else if (stream === 'btcusdt@trade') report.trade++;
        else if (stream === 'btcusdt@bookTicker') {
          report.bookTicker++;
          const top = tops.get(payload.u);
          if (top) compare(top,payload);
          else track(tickers,payload.u,payload);
        }
      } catch (err) {
        error = err;
        done();
      }
    };
    await end;
  } finally {
    clearTimeout(timer);
    lifetime.abort();
    socket.onmessage = null;
    socket.close();
    if (!writer.destroyed) {
      const finished = once(writer,'finish');
      writer.end();
      await finished;
    }
  }
  if (error) throw error;
  if (!report.depth || !report.trade || !report.bookTicker || !report.validBooks) throw new Error('Flux incomplet');
  return {...report,durationSeconds:(Date.now()-started)/1000,output};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {values:{seconds}} = parseArgs({options:{seconds:{type:'string',default:'20'}}});
  const duration = Number(seconds);
  if (!Number.isInteger(duration) || duration < 5 || duration > 3600) throw new Error('--seconds : 5 à 3600');
  mkdirSync('data/depth',{recursive:true});
  const destination = resolve('data/depth',Date.now()+'.ndjson');
  const result = await record(duration,destination);
  // The capture is already flushed. Do not wait for the peer's close handshake.
  process.stdout.write(JSON.stringify(result,null,2)+'\n', () => process.exit(0));
}
