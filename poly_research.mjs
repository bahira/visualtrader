import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {replayClob} from './poly_clob.mjs';
import {parseArgs} from 'node:util';
import {publishJson} from './json_status.mjs';

const policyBytes = readFileSync(new URL('./docs/poly-forward-policy.json',import.meta.url));
const policy = JSON.parse(policyBytes);
const digest = createHash('sha256').update(policyBytes).digest('hex');
const publishedStart = Date.parse(policy.startUtc);
const clip = (x,a,b) => Math.max(a,Math.min(b,x));
const logit = x => Math.log(clip(x,.001,.999)/(1-clip(x,.001,.999)));
const sigmoid = x => 1/(1+Math.exp(-x));

export function forecasts(row, raw) {
  const {prob,features:f} = row;
  const base = prob.market;
  if (!(base>0 && base<1)) return null;
  const out = {book:base,anchor:prob.anchor,momentum:prob.momentum,skew:prob.skew};
  if (!raw?.featureTime || !raw.candles || !raw.market || !Number.isFinite(f.anchor) || f.anchor<=0) return out;
  const bars = raw.candles.filter(c=>c[6]<raw.featureTime).slice(-60);
  if (bars.length!==60 || bars.some((c,i)=>i && c[0]-bars[i-1][0]!==1000)) return out;
  const mean = bars.reduce((sum,c)=>sum+Number(c[4]),0)/60;
  if (!Number.isFinite(mean) || mean<=0) return out;
  const remaining = (raw.market.ends-row.initial.time)/1000;
  if (remaining<=0) return out;
  const scale = Math.max(.000035,f.sigma)*Math.sqrt(Math.max(1,remaining));
  const z = Math.log(mean/f.anchor)/scale;
  const prior = logit(base);
  const vote = clip(1.6*z-prior,-2,2);
  out.twapProxy = sigmoid(prior+.35*vote);
  // Damp momentum when the latest window disagrees with the slow average.
  const drift = Math.sign(z)===Math.sign(f.momentum) ? clip(f.momentum/scale,-.5,.5) : 0;
  out.twapDrift = sigmoid(prior+.35*vote+.3*drift);
  return out;
}

export function choose(p, quotes, shares, threshold) {
  return quotes.map((q,side)=>({side,p:side===0?p:1-p,
    edge:q ? (side===0?p:1-p)-q.total/shares : -Infinity}))
    .filter(x=>x.edge>=threshold).sort((a,b)=>b.edge-a.edge)[0] ?? null;
}

function empty() {
  return {forecasts:0,brier:null,brierSum:0,pairedBookBrierDelta:null,bookDeltaSum:0,
    attempts:0,unknown:0,fills:0,pnl:0,bookPnl:0,paired:0,pairedNet:0,utcDays:{}};
}

function grade(rows, clob, cache, known) {
  const data = Object.fromEntries(policy.latenciesMs.map(l=>[l,{}]));
  const observations = clob.prepare('SELECT MIN(recv) AS first FROM frames WHERE slug=? AND type=\'data\'');
  const tail = clob.prepare('SELECT recv AS last FROM frames ORDER BY seq DESC LIMIT 1').get()?.last;
  for (const row of rows) {
    if ((tail ?? 0) < row.start+138_000 && !known.has(row.slug)) continue;
    const trial = JSON.parse(row.trial);
    const raw = row.raw ? JSON.parse(row.raw) : null;
    const probs = forecasts(trial,raw);
    const coverage = known.get(row.slug) ?? observations.get(row.slug).first;
    if (coverage != null && coverage<=row.time) known.set(row.slug,coverage);
    if (!probs || coverage == null || coverage>row.time) continue;
    const day = new Date(row.start).toISOString().slice(0,10);
    const up = Number(row.winner===0);
    for (const latency of policy.latenciesMs) {
      const result = data[latency];
      function fill(selection) {
        if (!selection) return {known:true,filled:false,pnl:0};
        const key = row.slug+'|'+row.time+'|'+selection.side+'|'+latency;
        if (!cache.has(key)) cache.set(key,replayClob(clob,row.slug,row.time,selection.side,
          latency,policy.shares,row.start+138_000));
        const obs = cache.get(key);
        if (!obs) return {known:false,filled:false,pnl:0};
        const filled = obs.quote && selection.p-obs.quote.total/policy.shares>=policy.edgePerShare;
        return {known:true,filled:!!filled,pnl:filled ?
          Number(row.winner===selection.side)*policy.shares-obs.quote.total : 0};
      }
      const baseline = fill(choose(probs.book,trial.initial.quotes,policy.shares,policy.edgePerShare));
      for (const [name,p] of Object.entries(probs)) {
        const selection = choose(p,trial.initial.quotes,policy.shares,policy.edgePerShare);
        const order = fill(selection);
        // Freeze execution evidence even if the official payout has yet to arrive.
        if (row.winner==null) continue;
        const m = result[name] ??= empty();
        m.forecasts++;
        m.brierSum += (p-up)**2;
        m.bookDeltaSum += (p-up)**2-(probs.book-up)**2;
        const d = m.utcDays[day] ??= {markets:0,fills:0,pnl:0,pairedNet:0};
        d.markets++;
        m.attempts += Number(!!selection);
        m.unknown += Number(!order.known);
        m.fills += Number(order.filled);
        d.fills += Number(order.filled);
        m.pnl += order.pnl;
        d.pnl += order.pnl;
        if (baseline.known && order.known) {
          m.paired++;
          m.bookPnl += baseline.pnl;
          m.pairedNet += order.pnl-baseline.pnl;
          d.pairedNet += order.pnl-baseline.pnl;
        }
      }
    }
  }
  for (const models of Object.values(data)) for (const m of Object.values(models)) {
    m.brier = m.brierSum/m.forecasts;
    m.pairedBookBrierDelta = m.bookDeltaSum/m.forecasts;
    delete m.brierSum;
    delete m.bookDeltaSum;
    m.executionCoverage = m.attempts ? (m.attempts-m.unknown)/m.attempts : null;
  }
  return data;
}

async function main() {
  const {values:args} = parseArgs({options:{watch:{type:'boolean'}}});
  const storage = new DatabaseSync('data/polymarket-v2/research.sqlite');
  storage.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS observations(policy TEXT,key TEXT,json TEXT,PRIMARY KEY(policy,key));
    CREATE TABLE IF NOT EXISTS covered(slug TEXT PRIMARY KEY,recv INTEGER NOT NULL);`);
  const prior = storage.prepare('SELECT key,json FROM observations WHERE policy=?');
  const cover = storage.prepare('INSERT OR IGNORE INTO covered VALUES(?,?)');
  const save = storage.prepare('INSERT OR IGNORE INTO observations VALUES(?,?,?)');
  const interval = 60_000;
  let running = true;
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{running=false;});
  async function cycle() {
    const paper = new DatabaseSync('data/polymarket-v2/paper.sqlite',{readOnly:true});
    const clob = new DatabaseSync('data/polymarket-clob/events.sqlite',{readOnly:true});
    try {
      const rows = paper.prepare(`SELECT trials.start,slug,time,winner,trials.record AS trial,evidence.record AS raw
        FROM trials LEFT JOIN evidence USING(start) ORDER BY trials.start`).all();
      const cache = new Map(prior.all(digest).map(row=>[row.key,JSON.parse(row.json)]));
      const known = new Map(storage.prepare('SELECT slug,recv FROM covered').all().map(row=>[row.slug,row.recv]));
      const old = cache.size;
      const exploratory = grade(rows.filter(r=>r.start<publishedStart),clob,cache,known);
      const forward = grade(rows.filter(r=>r.start>=publishedStart),clob,cache,known);
      storage.exec('BEGIN');
      try {
        for (const [key,value] of [...cache].slice(old)) save.run(digest,key,JSON.stringify(value));
        for (const [slug,recv] of known) cover.run(slug,recv);
        storage.exec('COMMIT');
      } catch (error) { storage.exec('ROLLBACK'); throw error; }
      const qualified = Object.keys(forward[500]).filter(name=>name!=='book' && policy.latenciesMs.every(l=>{
        const m = forward[l][name];
        return m && m.forecasts >= policy.minMarkets && Object.keys(m.utcDays).length>=policy.minUtcDays &&
          m.fills >= policy.minFills && m.executionCoverage >= policy.minExecutionCoverage && m.pnl>0 && m.pairedNet>0 &&
          m.pairedBookBrierDelta<0 && Object.values(m.utcDays).every(d=>d.pnl>=0) &&
          Object.values(m.utcDays).filter(d=>d.fills>0).length>=policy.minUtcDays;
      }));
      const report = {checked:new Date().toISOString(),policy,policySha256:digest,
        readTrials:rows.length,distinctClobReplays:cache.size,coveredMarkets:known.size,
        forwardTrials:rows.filter(r=>r.start>=publishedStart).length,
        verdict:qualified.length?'paper-candidate':'not-validated',qualified,prior:exploratory,forward};
      await publishJson('data/polymarket-v2/research.json',report);
      if (!args.watch) console.log(JSON.stringify(report,null,2));
    } finally {paper.close(); clob.close();}
  }
  try {
    do {
      try { await cycle(); }
      catch (error) {
        if (!args.watch) throw error;
        console.error(error.message);
      }
      if (args.watch && running) await new Promise(r=>setTimeout(r,interval));
    } while (args.watch && running);
  } finally {storage.close();}
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
