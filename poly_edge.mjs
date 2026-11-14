import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {publishJson} from './json_status.mjs';
import {replayExecution} from './poly_clob.mjs';

const PERIOD = 300_000;
const DAY = 86_400_000;
const feeStress = (cost, legs, p) => cost+legs*p.shares*p.stressPerLeg;
const clamp = (x,low,high) => Math.max(low,Math.min(x,high));

export function openingResidual(raw, start, time, sigma) {
  if (!Array.isArray(raw?.candles) || !Number.isFinite(sigma) || !Number.isSafeInteger(raw.featureTime) ||
      raw.featureTime>time || time>=start+PERIOD || raw.market?.ends!==start+PERIOD) return null;
  const bars = new Map(raw.candles.map(c=>[c[0],c]));
  function mean(end) {
    let sum = 0;
    for (let t=end-60_000;t<end;t+=1000) {
      const candle = bars.get(t);
      if (candle?.[6]!==t+999 || !(Number(candle[4])>0) || !Number.isFinite(Number(candle[4]))) return null;
      sum += Number(candle[4]);
    }
    return sum/60;
  }
  const opening = mean(start);
  const latest = mean(Math.floor(raw.featureTime/1000)*1000);
  if (!opening || !latest) return null;
  return Math.log(latest/opening)/(Math.max(.000035,sigma)*Math.sqrt((start+PERIOD-time)/1000));
}

export function plan(signal, observed, policy) {
  const initial = observed?.initial;
  if (!initial) return null;
  const books = initial.map(o=>o.quote);
  const market = signal.trial.prob.market;
  const z = openingResidual(signal.raw,signal.start,signal.time,signal.trial.features.sigma);
  const plans = {pair:null};
  if (books.every(Boolean) && Math.abs(initial[0].source-initial[1].source)<=policy.pairSkewMs &&
      Math.abs(initial[0].recv-initial[1].recv)<=policy.pairSkewMs && feeStress(books[0].total+books[1].total,2,policy)<=
      policy.shares-policy.pairMargin*policy.shares) plans.pair={legs:2};
  if (!(market>0 && market<1)) return plans;
  function sideFor(prob) {
    const choices = [prob,1-prob].map((target,side)=>({target,side,legs:1,
      edge:books[side] ? target-feeStress(books[side].total,1,policy)/policy.shares : -Infinity}));
    return choices.sort((a,b)=>b.edge-a.edge)[0].edge >= policy.directionalEdge ? choices[0] : null;
  }
  plans.skew = sideFor(signal.trial.prob.skew);
  if (z===null || !Number.isFinite(z)) return plans;
  const prior = Math.log(market/(1-market));
  const residual = clamp(1.6*z-prior,-1.25,1.25);
  const prob = 1/(1+Math.exp(-(prior+.35*residual)));
  plans.opening = sideFor(prob);
  const direction = Math.sign(z);
  const f = signal.trial.features;
  plans.consensus = direction===Math.sign(f.momentum) && direction===Math.sign(market-.5) &&
    plans.opening?.side===(direction>0?0:1) ? plans.opening : null;
  return plans;
}

export function evaluate(selection, sample, winner, policy) {
  if (!selection) return {state:'skip',net:0,stress:0,fees:0,cost:0};
  const {side,legs,target} = selection;
  const observations = legs===2 ? sample?.pair : sample?.sides?.[side] && [sample.sides[side]];
  if (!observations) return {state:'unknown',net:null,stress:null,fees:0,cost:0};
  const quotes = observations.map(x=>x.quote);
  if (quotes.some(q=>!q)) return {state:'reject',net:0,stress:0,fees:0,cost:0};
  const cost = quotes.reduce((sum,q)=>sum+q.total,0);
  const stressed = feeStress(cost,legs,policy);
  const edge = legs===2 ? 1-policy.pairMargin : target-policy.directionalEdge;
  if (stressed>policy.shares*edge+1e-9) return {state:'reject',net:0,stress:0,fees:0,cost:0};
  const payout = (legs===2 || side===winner) ? policy.shares : 0;
  return {state:'fill',net:winner==null ? null : payout-cost,stress:winner==null ? null : payout-stressed,
    fees:quotes.reduce((sum,q)=>sum+q.fees,0),cost,
    oneLegLoss:legs===2 ? Math.max(...quotes.map(q=>feeStress(q.total,1,policy))) : 0};
}

// Deterministic moving blocks preserve adjacent-day dependence within each sampled block.
export function dailyRange(values, repetitions=2000) {
  if (values.length<10) return null;
  let seed = 18477;
  const averages = [];
  const length = values.length;
  for (let i=0;i<repetitions;i++) {
    let sum = 0;
    for (let j=0;j<length;j+=2) {
      seed = (Math.imul(seed,1664525)+1013904223)>>>0;
      const k = Math.floor(seed/2**32*length);
      sum += values[k]+(j+1<length ? values[(k+1)%length] : 0);
    }
    averages.push(sum/length);
  }
  averages.sort((a,b)=>a-b);
  return [averages[Math.floor(.025*repetitions)],averages[Math.floor(.975*repetitions)]];
}

const variants = ['pair','skew','opening','consensus'];
const empty = () => ({eligible:0,attempts:0,fills:0,rejected:0,unknown:0,net:0,stress:0,fees:0,cost:0,
  maxOneLegLoss:0,oneLegStress:0,pairedSkew:{markets:0,stressDelta:0},days:{}});

function summarize(trials, expected, policy, days, final) {
  const table = Object.fromEntries(policy.latenciesMs.map(l=>[l,Object.fromEntries(variants.map(v=>[v,empty()]))]));
  const crosses = {};
  for (const trial of trials) {
    if (trial.winner==null || !trial.plans) continue;
    const day = Math.floor(trial.start/DAY)*DAY;
    const {momentum,skew,sigma} = trial.features;
    const spreads = trial.observed.initial.map(q=>q.ask!=null && q.bid!=null ? q.ask-q.bid : null);
    const spread = spreads.some(q=>q===null) ? 'missing-spread' : Math.max(...spreads)>.020001 ? 'wide' : 'tight';
    for (let i=0;i<policy.latenciesMs.length;i++) {
      const latency = policy.latenciesMs[i];
      const sample = trial.observed.samples[i];
      const comparison = evaluate(trial.plans.skew,sample,trial.winner,policy);
      for (const [name,selection] of Object.entries(trial.plans)) {
        const m = table[latency][name];
        m.eligible++;
        const result = evaluate(selection,sample,trial.winner,policy);
        const d = m.days[day] ??= {net:0,stress:0,fills:0};
        if (selection) m.attempts++;
        if (result.state==='unknown') m.unknown++;
        if (result.state==='reject') m.rejected++;
        if (name!=='skew' && Object.hasOwn(trial.plans,'skew') && result.stress!==null && comparison.stress!==null) {
          m.pairedSkew.markets++;
          m.pairedSkew.stressDelta+=result.stress-comparison.stress;
        }
        if (latency===500 && selection) {
          const key = [name,selection.legs===2?'pair':selection.side===0?'up':'down',
            sigma>=.00005?'high-vol':'low-vol',momentum*skew>0?'aligned':'divergent',spread].join('/');
          const cohort = crosses[key] ??= {attempts:0,fills:0,rejected:0,unknown:0,net:0,stress:0,fees:0};
          cohort.attempts++;
          if (result.state==='reject') cohort.rejected++;
          if (result.state==='unknown') cohort.unknown++;
          if (result.state==='fill') {
            cohort.fills++;
            for (const field of ['net','stress','fees']) cohort[field]+=result[field];
          }
        }
        if (result.state!=='fill') continue;
        m.fills++;
        d.fills++;
        for (const key of ['net','stress','cost','fees']) m[key]+=result[key];
        m.maxOneLegLoss=Math.max(m.maxOneLegLoss,result.oneLegLoss);
        m.oneLegStress-=result.oneLegLoss;
        d.net+=result.net;
        d.stress+=result.stress;
      }
    }
  }
  for (const models of Object.values(table)) for (const m of Object.values(models)) {
    m.coverage = expected ? m.eligible/expected : null;
    m.executionCoverage = m.attempts ? 1-m.unknown/m.attempts : null;
    m.tradingDays = Object.values(m.days).filter(d=>d.fills).length;
    // Missing opportunities are priced as a maximum hypothetical loss in this sensitivity measure.
    m.pessimistic = m.stress-(expected-m.eligible+m.unknown)*policy.shares*(1+policy.stressPerLeg);
    m.daily = m.coverage>=policy.minCoverage && m.executionCoverage>=policy.minCoverage &&
      m.fills>=policy.minFills && m.tradingDays>=policy.minTradingDays && days.length>=10 ? {
        mean:days.reduce((a,d)=>a+(m.days[d]?.stress??0),0)/days.length,
        range:dailyRange(days.map(d=>m.days[d]?.stress??0)),days:days.length
      } : null;
  }
  const qualified = final ? ['opening','consensus'].filter(v=>policy.latenciesMs.every(l=>{
    const m = table[l][v];
    return m.daily?.range[0]>0 && m.pessimistic>0;
  })) : [];
  return {table,crosses,qualified};
}

function readPolicy(path) {
  const bytes = readFileSync(path);
  const p = JSON.parse(bytes);
  const start = Date.parse(p.startUtc), end = Date.parse(p.endUtc);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start%PERIOD || end%PERIOD || end<=start ||
      JSON.stringify(p.latenciesMs)!=='[250,500,1000]' || ![p.shares,p.pairSkewMs,p.minFills,p.minTradingDays].every(x=>Number.isSafeInteger(x) && x>0) ||
      ![p.directionalEdge,p.pairMargin,p.stressPerLeg,p.minCoverage].every(x=>x>0 && x<1)) {
    throw new Error('Invalid experiment policy');
  }
  const hash = createHash('sha256').update(bytes);
  for (const file of ['poly_edge.mjs','poly_clob.mjs','polymarket_paper.mjs']) {
    hash.update(readFileSync(new URL(file,import.meta.url)));
  }
  return {policy:p,start,end,digest:hash.digest('hex')};
}

async function main() {
  const {values:args} = parseArgs({options:{watch:{type:'boolean'},export:{type:'boolean'},
    policy:{type:'string',default:'docs/poly-edge-policy.json'},
    paper:{type:'string',default:'data/polymarket-v2/paper.sqlite'},
    clob:{type:'string',default:'data/polymarket-clob/events.sqlite'},
    output:{type:'string',default:'data/polymarket-v2/edge'}}});
  const {policy,start,end,digest} = readPolicy(args.policy);
  const output = resolve(args.output);
  const storage = new DatabaseSync(output+'.sqlite',{readOnly:!!args.export});
  if (args.export) {
    const paper = new DatabaseSync(args.paper,{readOnly:true});
    try {
      const result = paper.prepare('SELECT winner FROM trials WHERE start=? AND slug=?');
      const stored = storage.prepare('SELECT record FROM evidence WHERE policy=? ORDER BY start');
      for (const row of stored.iterate(digest)) {
        const entry = JSON.parse(row.record);
        const winner = result.get(entry.start,entry.slug)?.winner??null;
        const outcomes = entry.plans && Object.fromEntries(Object.entries(entry.plans).map(([name,selection])=>[
          name,Object.fromEntries(policy.latenciesMs.map((latency,i)=>[latency,evaluate(selection,
            entry.observed.samples[i],winner,policy)]))]));
        process.stdout.write(JSON.stringify({digest,phase:entry.start<start?'prior':'forward',...entry,winner,outcomes})+'\n');
      }
    } finally {paper.close();storage.close();}
    return;
  }
  const lock = new DatabaseSync(output+'.lock.sqlite');
  lock.exec('BEGIN EXCLUSIVE');
  storage.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS evidence(policy TEXT,start INTEGER,record TEXT,PRIMARY KEY(policy,start));
    CREATE TABLE IF NOT EXISTS registrations(policy TEXT PRIMARY KEY,registered INTEGER NOT NULL);`);
  storage.prepare('INSERT OR IGNORE INTO registrations VALUES(?,?)').run(digest,Date.now());
  const {registered} = storage.prepare('SELECT registered FROM registrations WHERE policy=?').get(digest);
  const save = storage.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?)');
  const stored = storage.prepare('SELECT start,record FROM evidence WHERE policy=?');
  let timer, wake, running = true;
  for (const sig of ['SIGINT','SIGTERM']) process.on(sig,()=>{running=false;clearTimeout(timer);wake?.();});
  async function cycle() {
    const paper = new DatabaseSync(args.paper,{readOnly:true});
    const clob = new DatabaseSync(args.clob,{readOnly:true});
    try {
      paper.exec('PRAGMA busy_timeout=2000');
      clob.exec('PRAGMA busy_timeout=2000');
      const seeds = paper.prepare(`SELECT start,slug,time,winner FROM trials WHERE start>=? AND start<? ORDER BY start`)
        .all(start-2*DAY,end);
      const source = paper.prepare(`SELECT trials.record AS trial,evidence.record AS raw
        FROM trials LEFT JOIN evidence USING(start) WHERE trials.start=?`);
      const archived = new Map(stored.all(digest).map(r=>[r.start,JSON.parse(r.record)]));
      const now = Date.now();
      const began = performance.now();
      const market = clob.prepare('SELECT info FROM markets WHERE slug=?');
      const frames = clob.prepare('SELECT recv,type,data FROM frames WHERE slug=? AND recv<? ORDER BY seq');
      const tail = clob.prepare('SELECT recv FROM frames ORDER BY seq DESC LIMIT 1').get()?.recv??0;
      const collected = [];
      for (const r of seeds) {
        let entry = archived.get(r.start);
        const deadline = Math.min(r.start+138_000,r.time+policy.latenciesMs.at(-1)+4001);
        if (!entry && deadline<now && (tail>=deadline || now-deadline>120_000)) {
          const meta = market.get(r.slug);
          const observed = meta && replayExecution(JSON.parse(meta.info),frames.iterate(r.slug,deadline),r.time,
            policy.latenciesMs,policy.shares,deadline,policy.pairSkewMs);
          const raw = source.get(r.start);
          const trial = JSON.parse(raw.trial);
          const plans = plan({...r,trial,raw:raw.raw&&JSON.parse(raw.raw)},observed,policy);
          entry = {start:r.start,slug:r.slug,time:r.time,features:trial.features,plans,observed:observed??null};
          save.run(digest,r.start,JSON.stringify(entry));
        }
        if (entry) collected.push({...entry,winner:r.winner});
      }
      // Allow 15 minutes for resolution to keep still-active windows out of the denominator.
      const through = Math.max(start,Math.min(end,Math.floor((now-3*PERIOD)/PERIOD)*PERIOD));
      const forward = collected.filter(r=>r.start>=start && r.start<through);
      const history = collected.filter(r=>r.start<start);
      const days = [];
      for (let day=Math.ceil(start/DAY)*DAY; day+DAY<=through; day+=DAY) days.push(day);
      const expected = (through-start)/PERIOD;
      const prospective = registered<start;
      const result = summarize(forward,expected,policy,days,prospective && through===end);
      const prior = summarize(history,history.length,policy,[],false);
      const report = {checked:new Date(now).toISOString(),digest,policy,prospective,
        registeredUtc:new Date(registered).toISOString(),expected,through:new Date(through).toISOString(),
        replayed:forward.length,settled:forward.filter(r=>r.winner!=null).length,
        diagnostics:{missingTrials:expected-seeds.filter(r=>r.start>=start && r.start<through).length,
          missingBooks:forward.filter(r=>!r.plans).length,waitingSettlement:forward.filter(r=>r.winner==null).length,
          missingOpeningProxy:forward.filter(r=>r.plans && !Object.hasOwn(r.plans,'opening')).length},
        ...result,prior,cycleMs:Math.round(performance.now()-began),
        verdict:!prospective?'retrospective':result.qualified.length?'paper-candidate':through===end?'no-candidate':'collecting'};
      await publishJson(output+'.json',report,error=>console.warn('Edge status busy:',error.code));
      if (!args.watch) console.log(JSON.stringify(report,null,2));
    } finally {paper.close();clob.close();}
  }
  try {
    do {
      try {await cycle();} catch (error) {if (!args.watch) throw error; console.error(error.message);}
      if (running && args.watch) await new Promise(r=>{wake=r;timer=setTimeout(r,60_000);});
    } while (running && args.watch);
  } finally {lock.close();storage.close();}
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
