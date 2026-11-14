import {execFile as execute} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {parseArgs, promisify} from 'node:util';
import {Books} from './poly_clob.mjs';
import {publishJson} from './json_status.mjs';

const execFile = promisify(execute);
const DIR = 'data/polymarket-v2';
const START = Date.parse('2026-11-14T20:45:00Z');

export function nearTouch(book) {
  const bid = Math.max(...book.bids.keys()), ask = Math.min(...book.asks.keys());
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid>=ask) return null;
  function depth(levels, best) {
    let value = 0;
    for (const [price,size] of levels) {
      const distance = Math.abs(price-best);
      if (distance<=.02000001) value+=size/(1+distance/.01);
    }
    return value;
  }
  const buy = depth(book.bids,bid), sell = depth(book.asks,ask);
  return buy+sell>0 ? (buy-sell)/(buy+sell) : null;
}

export function replayPressure(market, frames, cutoff) {
  const books = new Books(market);
  const seen = new Map();
  const targets = [cutoff-5000,cutoff];
  const points = [];
  let last = 0, epoch = 0;
  function snapshot(t) {
    const values = market.tokens.map(token=>{
      const book = books.books.get(token);
      if (!book || t-(seen.get(token)??0)>1000 || t-book.timestamp>1000 || book.timestamp>=t) return null;
      return nearTouch(book);
    });
    points.push(values.some(v=>v===null) ? null : {value:(values[0]-values[1])/2,epoch});
  }
  for (const row of frames) {
    if (row.recv<last) return null;
    last = row.recv;
    while (points.length<2 && row.recv>=targets[points.length]) snapshot(targets[points.length]);
    if (points.length===2) break;
    if (row.type==='reset') {
      books.reset();
      seen.clear();
      epoch++;
      continue;
    }
    for (const event of JSON.parse(row.data)) {
      for (const token of books.apply(event)) seen.set(token,row.recv);
    }
  }
  while (points.length<2) snapshot(targets[points.length]);
  const [old,current] = points;
  if (!current) return null;
  return {pressure:current.value,persistence:old?.epoch===current.epoch ? (old.value+current.value)/2 : null};
}

export function signals(base, pressure, persistence, impulse) {
  const logit = Math.log(base/(1-base));
  const factors = {book:0,depth:.6*pressure,persistentDepth:.6*persistence,impulse:.35*impulse,
    combined:.6*persistence+.35*impulse};
  return Object.fromEntries(Object.entries(factors).map(([name,score])=>[name,1/(1+Math.exp(-logit-score))]));
}

export function results(record, row, policy) {
  const f = record.features;
  if (!row.observed?.initial?.every(o=>o.quote) || f?.persistence==null || record.impulse==null) return null;
  const observed = row.observed;
  const quotes = observed.initial.map(o=>o.quote);
  const base = quotes[0].average/(quotes[0].average+quotes[1].average);
  return Object.fromEntries(observed.samples.map(sample=>{
    const values = {};
    for (const [name,p] of Object.entries(signals(base,f.pressure,f.persistence,record.impulse))) {
      const edge = q=>q.total/policy.shares+policy.stressPerLeg+policy.directionalEdge;
      const side = p-edge(quotes[0])>=1-p-edge(quotes[1]) ? 0 : 1;
      const prob = side===0 ? p : 1-p;
      const brier = row.winner==null ? null : (p-Number(row.winner===0))**2;
      const selection = {brier,status:'pass',stress:0,p};
      if (prob>=edge(quotes[side])) {
        const entry = sample.sides[side];
        if (!entry) Object.assign(selection,{status:'unknown',stress:null});
        else if (!entry.quote || prob<edge(entry.quote)) selection.status='reject';
        else Object.assign(selection,{status:'fill',side,cost:entry.quote.total,
          stress:row.winner==null ? null : policy.shares*(Number(side===row.winner)-policy.stressPerLeg)-entry.quote.total});
      }
      values[name]=selection;
    }
    return [sample.barrier-row.time,values];
  }));
}

function accumulate(table, metrics) {
  for (const [latency,models] of Object.entries(metrics)) {
    const group = table[latency] ??= {};
    for (const [name,result] of Object.entries(models)) {
      const m = group[name] ??= {n:0,brier:0,deltaBrier:0,fills:0,rejected:0,unknown:0,net:0};
      m.n++;
      m.brier+=(result.brier-m.brier)/m.n;
      m.deltaBrier+=(result.brier-models.book.brier-m.deltaBrier)/m.n;
      if (result.status==='fill') {m.fills++;m.net+=result.stress;}
      if (result.status==='unknown') m.unknown++;
      if (result.status==='reject') m.rejected++;
    }
  }
}

async function joinSpot(rows) {
  if (!rows.length) return [];
  return new Promise((resolve,reject)=>{
    const child = execute(process.env.VISUALTRADER_PYTHON??'python',['-B','poly_spot_join.py','--rows'],
      {maxBuffer:32*1024*1024,timeout:90000},(error,out)=>{
        if (error) reject(error);
        else {
          try {resolve(out.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse));}
          catch (e) {reject(e);}
        }
      });
    child.stdin.on('error',reject);
    child.stdin.end(rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  });
}

async function main() {
  const {values:args} = parseArgs({options:{watch:{type:'boolean'},export:{type:'boolean'}}});
  const db = new DatabaseSync(DIR+'/pressure.sqlite',{readOnly:!!args.export});
  if (args.export) {
    const {protocol} = JSON.parse(readFileSync(DIR+'/pressure.json'));
    try {
      for (const row of db.prepare('SELECT record FROM pressure WHERE protocol=? ORDER BY start').iterate(protocol)) {
        process.stdout.write(row.record+'\n');
      }
    } finally {db.close();}
    return;
  }
  const policy = JSON.parse(readFileSync('docs/poly-edge-policy.json'));
  const implementation = createHash('sha256');
  for (const name of ['poly_pressure.mjs','poly_clob.mjs','poly_spot_join.py','docs/poly-edge-policy.json']) {
    implementation.update(readFileSync(name));
  }
  const hash = implementation.digest('hex');
  const lock = new DatabaseSync(DIR+'/pressure.lock.sqlite');
  lock.exec('BEGIN EXCLUSIVE');
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS pressure(protocol TEXT,start INTEGER,record TEXT,PRIMARY KEY(protocol,start));
    CREATE TABLE IF NOT EXISTS registrations(protocol TEXT PRIMARY KEY,registered INTEGER NOT NULL);`);
  const register = db.prepare('INSERT OR IGNORE INTO registrations VALUES(?,?)');
  const registration = db.prepare('SELECT registered FROM registrations WHERE protocol=?');
  const prior = db.prepare('SELECT start,record FROM pressure WHERE protocol=?');
  const save = db.prepare('INSERT INTO pressure VALUES(?,?,?)');
  let running = true, timer, wake;
  for (const sig of ['SIGINT','SIGTERM']) process.on(sig,()=>{running=false;clearTimeout(timer);wake?.();});
  try {
    do {
      try {
        const began = performance.now();
        const {stdout} = await execFile(process.execPath,['poly_edge.mjs','--export'],{maxBuffer:64*1024*1024});
        const rows = stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
        const source = rows[0]?.digest;
        if (!source || rows.some(row=>row.digest!==source)) throw new Error('Mixed or absent source experiment');
        const protocol = hash+'/'+source;
        const now = Date.now();
        register.run(protocol,now);
        const prospective = registration.get(protocol).registered<START;
        const cache = new Map(prior.all(protocol).map(row=>[row.start,JSON.parse(row.record)]));
        const pending = rows.filter(row=>now-row.time>60_000 && row.observed?.initial && !cache.has(row.start));
        if (pending.length) {
          const clob = new DatabaseSync('data/polymarket-clob/events.sqlite',{readOnly:true});
          try {
            clob.exec('PRAGMA busy_timeout=3000');
            const market = clob.prepare('SELECT info FROM markets WHERE slug=?');
            const frames = clob.prepare('SELECT recv,type,data FROM frames WHERE slug=? AND recv<? ORDER BY seq');
            for (const row of await joinSpot(pending)) {
              const meta = market.get(row.slug);
              const record = {start:row.start,slug:row.slug,time:row.time,bookAvailable:Boolean(meta),
                features:meta ? replayPressure(JSON.parse(meta.info),frames.iterate(row.slug,row.time),row.time) : null,
                impulse:row.flow.acceleration};
              save.run(protocol,row.start,JSON.stringify(record));
              cache.set(row.start,record);
            }
          } finally {clob.close();}
        }
        const report = {checked:new Date().toISOString(),protocol,start:new Date(START).toISOString(),prospective,
          sessions:{prior:{},forward:{},retrospective:{}},eligible:{prior:0,forward:0,retrospective:0},
          comparable:{prior:0,forward:0,retrospective:0},timeMs:0};
        for (const row of rows) {
          if (row.winner==null) continue;
          const phase = row.start<START ? 'prior' : prospective ? 'forward' : 'retrospective';
          report.eligible[phase]++;
          const record = cache.get(row.start);
          const metrics = record && results(record,row,policy);
          if (!metrics) continue;
          report.comparable[phase]++;
          accumulate(report.sessions[phase],metrics);
        }
        report.timeMs=Math.round(performance.now()-began);
        await publishJson(DIR+'/pressure.json',report);
        if (!args.watch) console.log(JSON.stringify(report,null,2));
      } catch (error) {
        if (!args.watch) throw error;
        console.error(error.message);
      }
      if (running && args.watch) await new Promise(r=>{wake=r;timer=setTimeout(r,300_000);});
    } while (running && args.watch);
  } finally {lock.close();db.close();}
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
