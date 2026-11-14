import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,statfsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {publishJson} from './json_status.mjs';
import {market,quote} from './polymarket_paper.mjs';

const DIR = 'data/polymarket-clob';
const PERIOD = 300_000;

export class Books {
  constructor(m) {
    this.market = m;
    this.reset();
  }
  reset() { this.books = new Map(); }
  apply(event) {
    const timestamp = Number(event.timestamp);
    if (event.market !== this.market.condition || !Number.isSafeInteger(timestamp) || timestamp <= 0) return [];
    const updated = [];
    const level = (row) => [Number(row.price),Number(row.size)];
    const valid = ([price,size]) => price > 0 && price < 1 && Number.isFinite(size) && size >= 0;
    if (event.event_type === 'book' && this.market.tokens.includes(event.asset_id)) {
      const id = event.asset_id;
      const asks = event.asks.map(level);
      const bids = event.bids.map(level);
      if (![...asks,...bids].every(valid)) { this.books.delete(id); return []; }
      if (timestamp < (this.books.get(id)?.timestamp ?? 0)) return [];
      this.books.set(id,{timestamp,asks:new Map(asks.filter(x=>x[1]>0)),bids:new Map(bids.filter(x=>x[1]>0))});
      updated.push(id);
    }
    if (event.event_type === 'price_change') {
      for (const item of event.price_changes) {
        const book = this.books.get(item.asset_id);
        if (!book || timestamp < book.timestamp) continue;
        const [price,size] = level(item);
        if (!valid([price,size]) || !['BUY','SELL'].includes(item.side)) {
          this.books.delete(item.asset_id);
          continue;
        }
        const side = item.side === 'BUY' ? book.bids : book.asks;
        if (size) side.set(price,size);
        else side.delete(price);
        book.timestamp = timestamp;
        updated.push(item.asset_id);
      }
    }
    return [...new Set(updated)];
  }
  raw(id) {
    const book = this.books.get(id);
    if (!book) return null;
    const lowest = Math.min(...book.asks.keys()), highest = Math.max(...book.bids.keys());
    if (highest >= lowest) return null;
    return {asset_id:id,market:this.market.condition,timestamp:book.timestamp,
      min_order_size:this.market.minimum,asks:[...book.asks].map(([price,size])=>({price,size})),
      bestBid:Number.isFinite(highest)?highest:null,bestAsk:Number.isFinite(lowest)?lowest:null};
  }
}

export function replayClob(db, slug, time, side, latency, shares=10, deadline=Infinity) {
  const row = db.prepare('SELECT info FROM markets WHERE slug=?').get(slug);
  if (!row) return null;
  const m = JSON.parse(row.info);
  const books = new Books(m);
  const id = m.tokens[side], barrier = time+latency;
  const end = Math.min(deadline,m.ends);
  if (barrier >= end) return null;
  let anchored = false;
  for (const row of db.prepare('SELECT recv,type,data FROM frames WHERE slug=? AND recv<=? ORDER BY seq')
    .iterate(slug,Math.min(barrier+4000,end-1))) {
    if (row.type==='reset') {
      if (row.recv > time) return null;
      books.reset();
      anchored = false;
      continue;
    }
    const events = JSON.parse(row.data);
    for (const event of events) {
      const updated = books.apply(event);
      if (row.recv <= time) {
        if (updated.includes(id)) anchored = Boolean(books.raw(id));
        continue;
      }
      if (!anchored || row.recv < barrier || !updated.includes(id)) continue;
      const raw = books.raw(id);
      if (!raw || raw.timestamp < barrier) continue;
      const result = quote(raw,id,m.condition,shares,m.rate,row.recv);
      // A first observed book with insufficient size is a rejection.
      return {recv:row.recv,source:raw.timestamp,bid:raw.bestBid,ask:raw.bestAsk,quote:result};
    }
  }
  return null;
}

async function main() {
  mkdirSync(DIR,{recursive:true});
  const lock = new DatabaseSync(resolve(DIR,'lock.sqlite'));
  lock.exec('BEGIN EXCLUSIVE');
  const db = new DatabaseSync(resolve(DIR,'events.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS markets(slug TEXT PRIMARY KEY,info TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS frames(seq INTEGER PRIMARY KEY,slug TEXT NOT NULL,recv INTEGER NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS frames_market_time ON frames(slug,recv);`);
  const addMarket = db.prepare('INSERT OR IGNORE INTO markets VALUES(?,?)');
  const put = db.prepare('INSERT INTO frames(slug,recv,type,data) VALUES(?,?,?,?)');
  let socket, books, current, last = 0, count = 0, total = 0, rejects = 0, running = true;
  const size = db.prepare('PRAGMA page_count');
  const freePages = db.prepare('PRAGMA freelist_count');
  const pageBytes = db.prepare('PRAGMA page_size').get().page_size;
  const limitBytes = 1024**3;
  const expired = db.prepare('SELECT slug FROM markets ORDER BY slug');
  const purge = db.prepare('DELETE FROM frames WHERE slug=?');
  const forget = db.prepare('DELETE FROM markets WHERE slug=?');
  let maintained = 0;
  let lastPing = 0, readyAt = 0, lastError = null, batch = [];
  function flush() {
    if (!batch.length) return;
    db.exec('BEGIN');
    try {
      for (const row of batch) put.run(...row);
      db.exec('COMMIT');
      batch = [];
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function stopSocket() {
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    socket.close();
    socket = null;
    books?.reset();
  }
  function connect(m) {
    stopSocket();
    current = m;
    books = new Books(m);
    count = 0;
    readyAt = Date.now();
    last = readyAt;
    lastPing = 0;
    batch.push([m.slug,last,'reset','[]']);
    socket = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
    socket.onopen = () => socket.send(JSON.stringify({type:'market',assets_ids:m.tokens,custom_feature_enabled:true}));
    socket.onclose = () => { socket = null; books.reset(); };
    socket.onerror = () => { lastError='WebSocket interrompu'; stopSocket(); };
    socket.onmessage = ({data}) => {
      last = Date.now();
      if (data==='PONG') return;
      let events;
      try {
        const frame = JSON.parse(data);
        events = Array.isArray(frame) ? frame : [frame];
        for (const event of events) books.apply(event);
      } catch {
        rejects++;
        lastError='Trame invalide : reprise sur snapshot';
        stopSocket();
        return;
      }
      count += events.length;
      total += events.length;
      batch.push([m.slug,last,'data',JSON.stringify(events)]);
      if (batch.length >= 1000) flush();
    };
  }
  for (const sig of ['SIGTERM','SIGINT']) process.on(sig,()=>{running=false;});
  try {
    while (running) {
      const now = Date.now();
      const start = now-now%PERIOD;
      const slug = 'btc-updown-5m-'+start/1000;
      if (current?.slug !== slug || !socket || now-last > 20_000) {
        try {
          const res = await fetch('https://gamma-api.polymarket.com/markets/slug/'+slug,{signal:AbortSignal.timeout(4000)});
          if (!res.ok) throw new Error('Gamma HTTP '+res.status);
          const raw = await res.json();
          const m = market(raw,start);
          if (!m?.accepting || !(Number(raw.orderMinSize)>0)) throw new Error('Marché non disponible');
          m.minimum = Number(raw.orderMinSize);
          addMarket.run(slug,JSON.stringify(m));
          connect(m);
        } catch (error) { lastError=error.message; }
      }
      if (socket?.readyState===WebSocket.OPEN && now-lastPing>=10_000) {
        socket.send('PING');
        lastPing = now;
      }
      flush();
      if (now-maintained >= 60_000) {
        maintained = now;
        const volume = statfsSync(DIR);
        if (volume.bavail*volume.bsize < 2*1024**3) throw new Error('Espace libre inférieur à 2 Gio');
        const cutoff = start-48*3600_000;
        for (const row of expired.all()) {
          if (row.slug === slug) continue;
          const used = (size.get().page_count-freePages.get().freelist_count)*pageBytes;
          if (Number(row.slug.split('-').at(-1))*1000 >= cutoff && used < limitBytes) break;
          db.exec('BEGIN');
          try { purge.run(row.slug); forget.run(row.slug); db.exec('COMMIT'); }
          catch (e) { db.exec('ROLLBACK'); throw e; }
        }
      }
      const quotes = current?.slug===slug ? current.tokens.map(token=>books?.raw(token)) : null;
      const fresh = current?.slug===slug && quotes?.every(q=>q && Math.abs(Date.now()-q.timestamp)<5000);
      if (fresh) lastError = null;
      await publishJson(resolve(DIR,'status.json'),{checked:Date.now(),slug,connected:socket?.readyState===WebSocket.OPEN,
        fresh:!!fresh,events:count,total,rejects,lastError,connectionStarted:readyAt,
        top:quotes?.map(q=>q&&({bid:q.bestBid,ask:q.bestAsk,source:q.timestamp}))}, error=>console.warn('CLOB status busy:',error.code));
      await new Promise(r=>setTimeout(r,1000));
    }
  } finally {
    stopSocket();
    flush();
    db.close();
    lock.close();
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
