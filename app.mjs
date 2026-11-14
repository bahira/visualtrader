import {mkdirSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {parseArgs} from 'node:util';
import {Engine, bps, decode, policy} from './engine.mjs';
import {connect, history, synthetic} from './market.mjs';

const {values:args} = parseArgs({options:{
  mode:{type:'string',default:'live'}, port:{type:'string',default:'8787'},
  speed:{type:'string',default:'1'}, seconds:{type:'string',default:'7200'},
  'fee-bps':{type:'string',default:'10'}, 'slip-bps':{type:'string',default:'1'},
  'latency-ms':{type:'string',default:'250'}, session:{type:'string'}, db:{type:'string'},
  batch:{type:'boolean',default:false}, help:{type:'boolean',default:false}
}});
if (args.help) {
  console.log('node app.mjs --mode live|demo|replay [--port 8787] [--fee-bps 10] [--slip-bps 1] [--latency-ms 250] [--db path] [--speed 1] [--session id] [--seconds 7200] [--batch]');
  process.exit();
}
function number(value, min, max, integer = false) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error('Valeur invalide ' + value);
  }
  return n;
}
const mode = args.mode;
if (!['live','demo','replay'].includes(mode)) throw new Error('Mode invalide');
if (mode === 'demo' && args.db) throw new Error('--db est réservé à live et replay');
if (args.batch && mode === 'live') throw new Error('--batch est réservé à demo et replay');
const port = number(args.port, 1024, 65535, true);
const speed = number(args.speed, 0.1, 10_000);
const duration = number(args.seconds, 1, 86_400, true);
const config = {...policy, feeBps:number(args['fee-bps'],0,100),
  slipBps:number(args['slip-bps'],0,100), latencyMs:number(args['latency-ms'],0,2_000)};
const root = fileURLToPath(new URL('.', import.meta.url));
const directory = resolve(root,'data');
mkdirSync(directory, {recursive:true});
const livePath = resolve(directory, 'live.sqlite');
const destination = mode === 'live' ? resolve(args.db ?? livePath) : ':memory:';
const lock = mode === 'live' ? new DatabaseSync(destination + '.lock') : null;
// Acquire the single-writer lease before touching the ledger.
lock?.exec('BEGIN EXCLUSIVE');
const db = new DatabaseSync(destination);
db.exec(`
  PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
  CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, mode TEXT, started INTEGER, config TEXT);
  CREATE TABLE IF NOT EXISTS market(seq INTEGER PRIMARY KEY, session INTEGER, recv INTEGER, json TEXT);
  CREATE INDEX IF NOT EXISTS market_session_seq ON market(session,seq);
  CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY, session INTEGER, kind TEXT, json TEXT);
  CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, json TEXT);
`);
const configText = JSON.stringify(config);
const saved = mode === 'live' ? db.prepare("SELECT json FROM state WHERE key='live'").get() : null;
const prior = saved ? JSON.parse(saved.json) : null;
if (prior && prior.config !== configText) throw new Error('Configuration modifiée. Utiliser --db avec un nouveau fichier.');
const opened = Date.now();
const session = Number(db.prepare('INSERT INTO sessions(mode,started,config) VALUES(?,?,?)').run(mode, opened, configText).lastInsertRowid);
const putMarket = db.prepare('INSERT INTO market(session,recv,json) VALUES(?,?,?)');
const putAudit = db.prepare('INSERT INTO audit(session,kind,json) VALUES(?,?,?)');
const putState = db.prepare("INSERT INTO state VALUES('live',?) ON CONFLICT(key) DO UPDATE SET json=excluded.json");
let capture = [], activity = [], dirty = false;
let marketTime = opened, connection = 'connecting', detail = 'Initialisation', minuteHistory = [];
let historyState = 'En attente', historyError = '';
const engine = new Engine({config, saved:prior?.engine, log:(kind, row) => {
  activity.push([kind,JSON.stringify(row)]);
  dirty ||= kind !== 'signal';
}});
function flush() {
  if (!capture.length && !activity.length && !dirty) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [recv, json] of capture) putMarket.run(session,recv,json);
    for (const [kind, json] of activity) putAudit.run(session,kind,json);
    if (dirty && mode === 'live') putState.run(JSON.stringify({config:configText, engine:engine.checkpoint()}));
    db.exec('COMMIT');
    capture = [];
    activity = [];
    dirty = false;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function ingest(json, recv, record) {
  const message = JSON.parse(json);
  marketTime = Math.max(marketTime, recv);
  if (record) capture.push([recv,json]);
  const event = decode(message);
  engine.handle(event, marketTime);
  if (event?.kind === 'candle' && event.closed) dirty = true;
  if (capture.length >= 10_000) flush();
}
function status(next, description) {
  connection = next;
  detail = description;
  if (next === 'offline') engine.connectionLost(Date.now());
  engine.log('connection', {time:Date.now(), status:next, reason:description});
}
let stop = () => {}, playback, refresh;
function state() {
  const now = mode === 'live' ? Date.now() : marketTime;
  const book = engine.fresh(now) ? engine.book : null;
  const wallet = engine.active.summary(book);
  const latest = engine.candles.at(-1);
  return {mode, session, now, status:connection === 'waiting' && book ? 'live' : connection,
    detail, opened, config, marketReady:!!book, historyState, historyError,
    recent:{candle:engine.last.candle ?? null, book:engine.last.book ?? null, lagMs:latest?.exchange == null
      ? null : Math.max(0,(engine.last.candleReceived ?? latest.exchange) - latest.exchange)},
    price:engine.tape[0]?.price ?? latest?.c ?? null,
    spread:book ? bps(book.asks[0][0],book.bids[0][0]) : null,
    counts:engine.count, chart:engine.candles, current:engine.current, minuteHistory,
    tape:engine.tape.slice(0,18), book:book && {bids:book.bids.slice(0,7), asks:book.asks.slice(0,7)},
    wallet, equity:engine.equity, fills:engine.fills, strategy:engine.strategy,
    context:engine.context, nomination:engine.nomination, waiting:engine.waiting, paused:engine.paused,
    window:engine.window, covered:engine.covered, review:engine.audit,
    candidates:engine.shadows.map(s => s.summary(book))};
}
const files = Object.fromEntries([['/','index.html','text/html; charset=utf-8'],
  ['/app.css','app.css','text/css'],['/ui.js','ui.js','text/javascript']].map(([url,file,type]) =>
  [url,{body:readFileSync(resolve(root,'public',file)),type}]));
const api = createServer((req,res) => {
  const authority = '127.0.0.1:' + port;
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
  if (req.headers.host !== authority) { res.writeHead(403).end(); return; }
  const json = body => res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(body));
  if (req.method === 'GET') {
    if (req.url === '/api/state') { json(state()); return; }
    if (req.url === '/health') { json({mode,session,status:state().status,marketReady:!!engine.fresh(mode === 'live' ? Date.now() : marketTime), counts:engine.count}); return; }
    if (req.url === '/api/audit') {
      flush();
      // A bounded copy keeps the write connection free during downloads.
      const rows = db.prepare('SELECT kind,json FROM audit WHERE session=? ORDER BY seq DESC LIMIT 10000').all(session).reverse();
      res.writeHead(200,{'Content-Type':'application/x-ndjson','Content-Disposition':'attachment; filename=visualtrader-audit.ndjson'});
      res.end(rows.map(({kind,json}) => JSON.stringify({kind,...JSON.parse(json)})).join('\n') + '\n');
      return;
    }
    const file = Object.hasOwn(files, req.url) ? files[req.url] : null;
    if (file) { res.writeHead(200,{'Content-Type':file.type}).end(file.body); return; }
  }
  if (req.method === 'POST' && (req.url === '/api/pause' || req.url === '/api/resume')) {
    if (req.headers.origin !== 'http://' + authority || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403).end();
      return;
    }
    engine.pause(req.url === '/api/pause', mode === 'live' ? Date.now() : marketTime);
    flush();
    json({paused:engine.paused});
    return;
  }
  res.writeHead(404).end();
});

let replayDb;
let feed;
if (mode === 'demo') {
  const start = Math.floor(opened / 1_000) * 1_000 - duration * 1_000;
  marketTime = start;
  feed = (function* () {
    for (const [time, message] of synthetic(start,duration)) yield {recv:time,json:JSON.stringify(message)};
  })();
} else if (mode === 'replay') {
  replayDb = new DatabaseSync(resolve(args.db ?? livePath),{readOnly:true});
  const source = args.session ? number(args.session,1,Number.MAX_SAFE_INTEGER,true)
    : replayDb.prepare('SELECT session FROM market ORDER BY seq DESC LIMIT 1').get()?.session;
  if (!source || !replayDb.prepare('SELECT 1 FROM market WHERE session=? LIMIT 1').get(source)) {
    throw new Error('Session live introuvable');
  }
  feed = replayDb.prepare('SELECT recv,json FROM market WHERE session=? ORDER BY seq').iterate(source);
  marketTime = 0;
}
function finishFeed() {
  flush();
  connection = 'complete';
  detail = 'Lecture terminée';
}
if (args.batch) {
  const start = performance.now();
  for (const row of feed) {
    ingest(row.json,row.recv,false);
    if (activity.length >= 10_000) flush();
  }
  finishFeed();
  const {wallet,candidates,counts,review,strategy} = state();
  console.log(JSON.stringify({mode, elapsedMs:performance.now()-start, counts, strategy, wallet, candidates,
    reviews:review.length, promotions:review.filter(r => r.promoted).length},null,2));
  replayDb?.close();
  db.close();
} else {
  api.listen(port,'127.0.0.1',() => {
    console.log('VisualTrader ' + mode + ' · http://127.0.0.1:' + port + ' · session ' + session);
    if (mode === 'live') {
      stop = connect((json,recv) => ingest(json,recv,true),status);
      const load = async () => {
        try {
          minuteHistory = await history('1m',960);
          historyState = 'Historique Binance 1 min';
          historyError = '';
        } catch (error) {
          historyState = minuteHistory.length ? 'Historique en cache' : 'Historique indisponible';
          historyError = error.cause?.code ?? error.message;
        }
      };
      void load();
      refresh = setInterval(load,60_000);
    } else {
      connection = mode;
      detail = mode === 'demo' ? 'Marché synthétique' : 'Capture Binance';
      let next = feed.next();
      const base = next.value?.recv ?? opened;
      const start = performance.now();
      playback = setInterval(() => {
        const limit = base + (performance.now() - start) * speed;
        let count = 0;
        while (!next.done && next.value.recv <= limit && count++ < 5_000) {
          ingest(next.value.json,next.value.recv,false);
          next = feed.next();
        }
        if (next.done) { clearInterval(playback); finishFeed(); }
      },20);
    }
  });
  const writer = setInterval(flush,250);
  function shutdown() {
    stop();
    clearInterval(playback);
    clearInterval(refresh);
    clearInterval(writer);
    flush();
    feed?.return();
    replayDb?.close();
    lock?.close();
    db.close();
    api.close();
  }
  process.once('SIGINT',shutdown);
  process.once('SIGTERM',shutdown);
}
