import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {publishJson} from './json_status.mjs';
import {parseArgs} from 'node:util';

const GAMMA = 'https://gamma-api.polymarket.com/markets/slug/';
const BOOK = 'https://clob.polymarket.com/book?token_id=';
const BINANCE = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=330';
const PERIOD = 300_000;
const LATENCY = 500;
const SHARES = 10;
const EDGE = .04;
const MODELS = ['anchor','momentum','skew','market'];
const POLICY = 'v2:120s:500ms:fresh-source:10shares:4c:market-logit-blend';

async function get(url) {
  const response = await fetch(url,{signal:AbortSignal.timeout(6500)});
  if (!response.ok) throw new Error(new URL(url).hostname + ' HTTP ' + response.status);
  return response.json();
}
const array = value => Array.isArray(value) ? value : JSON.parse(value);
const feeFor = (price,rate) => rate*price*(1-price);

export function market(input, start) {
  const ends = Date.parse(input.endDate);
  if (Date.parse(input.eventStartTime) !== start || ends !== start+PERIOD ||
      !String(input.resolutionSource).startsWith('https://data.chain.link/streams/btc-usd-twap-60s-streams') ||
      !String(input.description).includes('time-weighted average price (TWAP)')) return null;
  const outcomes = array(input.outcomes), tokens = array(input.clobTokenIds);
  if (outcomes.join('/') !== 'Up/Down' || tokens.length !== 2 || tokens.some(token => !/^\d+$/.test(token))) return null;
  const rate = input.feesEnabled ? Number(input.feeSchedule?.rate) : 0;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1 ||
      (input.feesEnabled && input.feeSchedule?.exponent !== 1)) return null;
  return {slug:input.slug, condition:input.conditionId, tokens, rate, ends,
    accepting:input.acceptingOrders === true && input.closed === false};
}

export function winner(input, condition) {
  if (input.conditionId !== condition || input.closed !== true ||
      input.umaResolutionStatus !== 'resolved' || array(input.outcomes).join('/') !== 'Up/Down') return null;
  const prices = array(input.outcomePrices).map(Number);
  if (prices[0] === 1 && prices[1] === 0) return 0;
  if (prices[0] === 0 && prices[1] === 1) return 1;
  return null;
}

export function features(candles,start,now) {
  const bars = candles.filter(row => row[6] < now);
  const opening = bars.find(row => row[0] === start);
  const tail = bars.slice(-31);
  if (!opening || tail.length !== 31 || now-tail.at(-1)[6] > 4000 ||
      tail.some((row,i) => i && row[0]-tail[i-1][0] !== 1000)) return null;
  let up = 0, down = 0;
  for (let i=1;i<tail.length;i++) {
    const change = Math.log(Number(tail[i][4])/Number(tail[i-1][4]));
    if (change > 0) up += change**2;
    else down += change**2;
  }
  const price = Number(tail.at(-1)[4]);
  const momentum = Math.log(price/Number(tail[0][4]));
  const anchor = Number(opening[1]);
  if (![price,momentum,anchor,up,down].every(Number.isFinite) || price<=0 || anchor<=0) return null;
  return {price,anchor,momentum,skew:up+down ? (up-down)/(up+down) : 0,
    distance:Math.log(price/anchor), sigma:Math.sqrt((up+down)/30), sample:tail.at(-1)[6]};
}

export function estimate(f,seconds) {
  const scale = Math.max(.000035,f.sigma)*Math.sqrt(Math.max(seconds,1));
  // Fixed heuristic, with and without the extra factors for attribution.
  const baseline = f.distance/scale;
  const momentum = Math.max(-.7,Math.min(.7,f.momentum/(scale*2)));
  const agree = f.momentum*f.skew > 0;
  const probability = z => Math.max(.02,Math.min(.98,1/(1+Math.exp(-1.6*z))));
  return {anchor:probability(baseline),momentum:probability(baseline+momentum),
    skew:probability(baseline+momentum+(agree ? .45*f.skew : 0))};
}

export function quote(raw, token, condition, shares, rate, now) {
  const age = now-Number(raw.timestamp);
  if (raw.asset_id !== token || raw.market !== condition || !Number.isFinite(age) ||
      age < -1500 || age > 4000 || !(Number(raw.min_order_size) <= shares)) return null;
  let remaining = shares, notional = 0, fees = 0;
  for (const ask of [...raw.asks].sort((a,b)=>Number(a.price)-Number(b.price))) {
    const price = Number(ask.price), size = Number(ask.size);
    if (!(price>0 && price<1 && size>0 && Number.isFinite(size))) continue;
    const filled = Math.min(remaining,size);
    notional += filled*price;
    fees += filled*feeFor(price,rate);
    remaining -= filled;
    if (remaining <= 1e-8) {
      fees = Math.round(fees * 1e5) / 1e5;
      return {notional,fees,total:notional+fees,average:notional/shares,age};
    }
  }
  return null;
}

function rules(prob,quotes) {
  return quotes.map((q,side)=>({side,prob:side===0?prob:1-prob,
    edge:q ? (side===0?prob:1-prob)-q.total/SHARES : -Infinity}))
    .filter(row=>row.edge>=EDGE).sort((a,b)=>b.edge-a.edge)[0];
}

export function freshExecution(fill, initial, execution) {
  return Boolean(fill && execution.time >= initial.time+LATENCY && execution.time-fill.age >= initial.time+LATENCY);
}

export function blend(proxy, benchmark) {
  const logit = p => Math.log(p/(1-p));
  return 1/(1+Math.exp(-(.5*logit(proxy)+.5*logit(benchmark))));
}

export function evaluateExecution(prob,initial,attempts,deadline) {
  const decisions = Object.fromEntries(MODELS.slice(0,3).map(name=>[name,rules(prob[name],initial.quotes)]));
  const fills = {}, reasons = {};
  for (const [name,choice] of Object.entries(decisions)) {
    if (!choice) {
      const sides = initial.quotes.map((q,side)=>({side,prob:side===0?prob[name]:1-prob[name],
        cost:q.total/SHARES}));
      sides.sort((a,b)=>(b.prob-b.cost)-(a.prob-a.cost));
      const best = sides[0];
      reasons[name] = {...best,signalEdge:best.prob-best.cost,reason:'Avantage sous le seuil'};
      continue;
    }
    const observed = attempts.find(book=>book.time < deadline &&
      freshExecution(book.quotes[choice.side],initial,book));
    const fill = observed?.quotes[choice.side];
    const edge = fill ? choice.prob-fill.total/SHARES : null;
    reasons[name] = {side:choice.side,prob:choice.prob,signalEdge:choice.edge,cost:initial.quotes[choice.side].total/SHARES,fillEdge:edge,
      delayMs:observed ? observed.time-initial.time : null,
      reason:edge === null ? 'Aucun carnet post-latence' : edge < EDGE ? 'Avantage disparu' : 'Fill simulé'};
    if (edge !== null && edge >= EDGE) fills[name] = {...fill,side:choice.side,time:observed.time};
  }
  return {fills,reasons};
}

export function replayEvidence(evidence) {
  const {market:m,candles,initial,attempts} = evidence;
  const restored = book => ({time:book.time,quotes:book.raw.map((raw,i)=>
    quote(raw,m.tokens[i],m.condition,SHARES,m.rate,book.time))});
  const start = m.ends-PERIOD;
  // Legacy v2 stored the derived features but omitted the exact feature evaluation time.
  // New rows store it explicitly so a just-closed candle cannot leak into the replay.
  const f = features(candles,start,evidence.featureTime);
  const first = restored(initial);
  if (!f || !first.quotes.every(Boolean)) throw new Error('Incomplete decision evidence');
  const prob = estimate(f,(m.ends-first.time)/1000);
  prob.market = first.quotes[0].average/(first.quotes[0].average+first.quotes[1].average);
  for (const name of MODELS.slice(0,3)) prob[name] = blend(prob[name],prob.market);
  return {features:f,prob,initial:first,...evaluateExecution(prob,first,attempts.map(restored),start+138_000)};
}

async function books(m) {
  const raw = await Promise.all(m.tokens.map(token=>get(BOOK+token)));
  const now = Date.now();
  return {time:now, raw, quotes:raw.map((book,i)=>quote(book,m.tokens[i],m.condition,SHARES,m.rate,now))};
}

async function main() {
  const {values:{directory}} = parseArgs({options:{directory:{type:'string',default:'data/polymarket-v2'}}});
  const dir = resolve(directory);
  mkdirSync(dir,{recursive:true});
  const lock = new DatabaseSync(resolve(dir,'collector.lock.sqlite'));
  lock.exec('BEGIN EXCLUSIVE');
  const db = new DatabaseSync(resolve(dir,'paper.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS trials(start INTEGER PRIMARY KEY,slug TEXT,condition TEXT,time INTEGER,record TEXT,winner INTEGER);
    CREATE TABLE IF NOT EXISTS coverage(start INTEGER PRIMARY KEY,state TEXT,detail TEXT);
    CREATE TABLE IF NOT EXISTS evidence(start INTEGER PRIMARY KEY, record TEXT);
    CREATE TABLE IF NOT EXISTS chart(start INTEGER,time INTEGER,skew REAL,market REAL,PRIMARY KEY(start,time));
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT);`);
  db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run('policy',POLICY);
  if (db.prepare("SELECT value FROM metadata WHERE key='policy'").get().value !== POLICY) {
    throw new Error('Policy changed. Use a new directory.');
  }
  let lastError = null, current = null, lastSettlement = 0, running = true, settling = false;
  const lastCovered = db.prepare('SELECT MAX(start) AS start FROM coverage').get().start;
  let coverageCursor = lastCovered == null ? null : lastCovered+PERIOD;
  const misses = db.prepare("SELECT start,detail FROM coverage WHERE state='missed' ORDER BY start DESC LIMIT 12");
  let failureReason = 'Worker indisponible pendant la fenêtre';
  const names = MODELS;
  const findTrial = db.prepare('SELECT record FROM trials WHERE start=?');
  const due = db.prepare('SELECT start,slug,condition FROM trials WHERE winner IS NULL AND start<=? ORDER BY start LIMIT 100');
  const settle = db.prepare('UPDATE trials SET winner=? WHERE start=? AND winner IS NULL');
  const journal = db.prepare('SELECT start,slug,time,record,winner FROM trials ORDER BY start DESC LIMIT 24');
  let preview = null, meta = null;
  const cover = db.prepare('INSERT OR REPLACE INTO coverage VALUES(?,?,?)');
  const plot = db.prepare('INSERT OR IGNORE INTO chart VALUES(?,?,?,?)');
  const chart = db.prepare('SELECT time,skew,market FROM chart WHERE start=? ORDER BY time');
  const archive = db.prepare('INSERT OR REPLACE INTO evidence VALUES(?,?)');
  const add = db.prepare('INSERT INTO trials(start,slug,condition,time,record) VALUES(?,?,?,?,?)');
  for (const sig of ['SIGINT','SIGTERM']) process.on(sig,()=>{running=false;});
  async function status() {
    const coverage = Object.fromEntries(db.prepare('SELECT state,count(*) AS n FROM coverage GROUP BY state').all().map(r=>[r.state,r.n]));
    const paired = {skewChanged:0,skewNet:0,compared:0};
    const summary = Object.fromEntries(names.map(name=>[name,{trades:0,settled:0,wins:0,fees:0,openCost:0,net:0,brier:null}]));
    let evaluated = 0, resolved = 0;
    for (const row of db.prepare('SELECT record,winner FROM trials').iterate()) {
      const trial = JSON.parse(row.record);
      evaluated++;
      if (trial.fills.skew?.side !== trial.fills.momentum?.side) paired.skewChanged++;
      if (row.winner !== null) {
        resolved++;
        paired.compared++;
        const pnl = fill => fill ? (fill.side===row.winner ? SHARES : 0)-fill.total : 0;
        paired.skewNet += pnl(trial.fills.skew)-pnl(trial.fills.momentum);
      }
      for (const name of names) {
        const result = summary[name];
        if (row.winner !== null && trial.prob[name] !== null) {
          result.brier = (result.brier ?? 0) + (trial.prob[name]-Number(row.winner===0))**2;
          result.samples = (result.samples ?? 0)+1;
        }
        const fill = trial.fills[name];
        if (!fill) continue;
        result.trades++;
        result.fees += fill.fees;
        if (row.winner === null) { result.openCost += fill.total; continue; }
        result.settled++;
        result.wins += Number(fill.side===row.winner);
        result.net += (fill.side===row.winner ? SHARES : 0)-fill.total;
      }
    }
    for (const result of Object.values(summary)) if (result.samples) result.brier /= result.samples;
    await publishJson(resolve(dir,'status.json'),{policy:POLICY,checked:new Date().toISOString(),
      current,lastError,evaluated,resolved,summary,coverage,paired,misses:misses.all(),
      history:current ? chart.all(Number(current.slug.split('-').at(-1))*1000) : [],
      journal:journal.all().map(({record,winner,...row})=>{
        const trial = JSON.parse(record);
        return {...row,winner,prob:trial.prob,fills:trial.fills,reasons:trial.reasons};
      })},error=>console.warn('Paper status busy:',error.code));
  }
  let settlementCursor = -1;
  async function resolveDue(now) {
    if (settling || now-lastSettlement < 20_000) return;
    settling = true;
    lastSettlement = now;
    try {
      const pending = due.all(now-PERIOD-30_000);
      const batch = [...pending.filter(row=>row.start>settlementCursor),
        ...pending.filter(row=>row.start<=settlementCursor)].slice(0,4);
      const values = await Promise.allSettled(batch.map(async row=>[row,winner(await get(GAMMA+row.slug),row.condition)]));
      if (!running) return;
      for (const answer of values) {
        if (answer.status !== 'fulfilled') continue;
        const [row,side] = answer.value;
        if (side !== null) settle.run(side,row.start);
      }
      if (batch.length) settlementCursor=batch.at(-1).start;
    } finally { settling = false; }
  }

  async function run() {
    const now = Date.now();
    const start = now-now%PERIOD;
    const slug = 'btc-updown-5m-'+start/1000;
    current = {slug,secondsToEnd:Math.ceil((start+PERIOD-now)/1000),state:'Attente du point de décision'};
    void resolveDue(now);
    coverageCursor ??= start;
    const eligible = now-start >= 138_000 ? start : start-PERIOD;
    while (coverageCursor <= eligible) {
      if (!findTrial.get(coverageCursor)) cover.run(coverageCursor,'missed',
        coverageCursor === start ? failureReason : 'Fenêtre sans décision');
      coverageCursor += PERIOD;
      failureReason = 'Worker indisponible pendant la fenêtre';
    }
    const saved = findTrial.get(start);
    const inWindow = now-start >= 120_000 && now-start < 138_000;
    const deciding = !saved && inWindow;
    if (saved) {
      const record = JSON.parse(saved.record);
      current.state = Object.keys(record.fills).length ? 'Trade simulé enregistré' : 'Abstention enregistrée';
      current.decision = record;
    } else if (now-start >= 138_000) {
      current.state = 'Fenêtre de décision passée';
    }
    if (preview?.slug === slug) Object.assign(current,preview.data);
    if (!deciding && preview?.slug === slug && now-preview.time < 4000) return;
    const refresh = deciding || meta?.slug !== slug || now-meta.time > 20_000 || !meta.market?.accepting;
    const [raw,candles] = await Promise.all([refresh ? get(GAMMA+slug) : null,get(BINANCE)]);
    if (raw) meta = {slug,time:Date.now(),market:market(raw,start)};
    const m = meta?.market;
    const featureTime = Date.now();
    const f = features(candles,start,featureTime);
    if (!m?.accepting || !f) {
      if (deciding) failureReason = current.state='Marché ou proxy BTC indisponible';
      return;
    }
    const initial = await books(m);
    const prob = estimate(f,(m.ends-initial.time)/1000);
    // Normalize two executable asks before fees as a simple market calibration benchmark.
    const complete = initial.quotes.every(Boolean);
    prob.market = complete
      ? initial.quotes[0].average/(initial.quotes[0].average+initial.quotes[1].average) : null;
    preview = {slug,time:initial.time,data:{features:f,prob:Object.fromEntries(names.map(name=>[name, name!=='market' && complete ? blend(prob[name],prob.market) : prob[name]])),quotes:initial.quotes,
      quoteTime:initial.time,ends:m.ends}};
    Object.assign(current,preview.data);
    if (initial.time < m.ends) plot.run(start,initial.time,preview.data.prob.skew,prob.market);
    if (!deciding || initial.time >= start+138_000) return;
    if (!complete) { failureReason = current.state='Carnet incomplet'; return; }
    for (const name of names.slice(0,3)) prob[name] = blend(prob[name],prob.market);
    const decisions = Object.fromEntries(names.slice(0,3).map(name=>[name,rules(prob[name],initial.quotes)]));
    let execution = null;
    const attempts = [];
    if (Object.values(decisions).some(Boolean)) {
      await new Promise(resolve=>setTimeout(resolve,LATENCY));
      const selected = [...new Set(Object.values(decisions).filter(Boolean).map(x=>x.side))];
      try {
        for (let i=0;i<4;i++) {
          if (Date.now() >= start+138_000) break;
          execution = await books(m);
          attempts.push(execution);
          if (selected.every(side=>freshExecution(execution.quotes[side],initial,execution))) break;
          await new Promise(resolve=>setTimeout(resolve,250));
        }
      } catch (error) { failureReason = error.message; }
    }
    const {fills,reasons} = evaluateExecution(prob,initial,attempts,start+138_000);
    const compact = book => book && {time:book.time,quotes:book.quotes};
    const record = {features:f,prob,initial:compact(initial),execution:compact(execution),fills,rate:m.rate,reasons};
    db.exec('BEGIN');
    try {
      add.run(start,slug,m.condition,initial.time,JSON.stringify(record));
      archive.run(start,JSON.stringify({market:m,candles,initial,attempts,featureTime}));
      cover.run(start,'evaluated','');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    Object.assign(current,{state:Object.keys(fills).length ? 'Trade simulé enregistré' : 'Abstention enregistrée',
      decision:record});
  }
  try {
    while (running) {
      lastError = null;
      try { await run(); } catch (error) { lastError=String(error.message); failureReason=lastError; }
      await status();
      await new Promise(resolve=>setTimeout(resolve,2500));
    }
  } finally {
    db.close();
    lock.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) await main();
