import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {Books} from './poly_clob.mjs';
import {quote} from './polymarket_paper.mjs';
import {publishJson} from './json_status.mjs';

const run = promisify(execFile);
const horizons = [250,1000,5000,15000];
const grace = 1000;
const sizes = [5,10,25,50,100];

export function bidProceeds(bids, shares, rate) {
  let remaining = shares, notional = 0, fees = 0;
  for (const [price,available] of [...bids].sort((a,b)=>b[0]-a[0])) {
    const size = Math.min(remaining,available);
    notional+=size*price;
    fees+=size*rate*price*(1-price);
    remaining-=size;
    if (remaining<=1e-8) {
      fees=Math.round(fees*1e5)/1e5;
      return {notional,fees,net:notional-fees};
    }
  }
  return null;
}

export function replayExits(market, frames, entries, shares, stressPerLeg, edge) {
  const waiting = entries.flatMap(entry=>horizons.map(delay=>({
    entry,delay,target:entry.recv+delay,state:'unknown'
  }))).sort((a,b)=>a.target-b.target);
  if (!waiting.length) return [];
  const books = new Books(market);
  const cutoff = Math.min(...entries.map(entry=>entry.recv));
  const fillsAt = new Map();
  for (const entry of entries) {
    if (!fillsAt.has(entry.recv)) fillsAt.set(entry.recv,[]);
    fillsAt.get(entry.recv).push(entry);
  }
  const capacity = new Map();
  let head = 0, previous = 0;
  for (const frame of frames) {
    // The entry evidence was produced in an uninterrupted epoch. Leave later exits unknown.
    if (frame.recv<previous || frame.recv>=market.ends) break;
    previous=frame.recv;
    while (head<waiting.length && frame.recv>waiting[head].target+grace) head++;
    if (head===waiting.length) break;
    if (frame.type==='reset') {
      if (frame.recv>=cutoff) break;
      books.reset();
      continue;
    }
    const updated = new Set();
    for (const event of JSON.parse(frame.data)) for (const token of books.apply(event)) updated.add(token);
    for (const entry of fillsAt.get(frame.recv)??[]) {
      if (capacity.has(entry) || !Number.isFinite(entry.target) || !Number.isFinite(edge)) continue;
      const token = market.tokens[entry.side];
      if (!updated.has(token)) continue;
      const raw = books.raw(token);
      if (!raw || raw.timestamp!==entry.source) continue;
      const reference = quote(raw,token,market.condition,shares,market.rate,frame.recv);
      if (!reference || Math.abs(reference.total-entry.quote.total)>1e-8) continue;
      capacity.set(entry,sizes.map(size=>{
        if (size<market.minimum) return {size,state:'below-minimum'};
        const buy = quote(raw,token,market.condition,size,market.rate,frame.recv);
        if (!buy) return {size,state:'entry-depth'};
        if (entry.target-buy.total/size-stressPerLeg<edge-1e-9) return {size,state:'entry-edge',cost:buy.total};
        return {size,state:'entry-priced',cost:buy.total};
      }));
    }
    for (let i=head;i<waiting.length && waiting[i].target<=frame.recv;i++) {
      const item = waiting[i];
      if (item.state!=='unknown' || frame.recv>item.target+grace) continue;
      const token = market.tokens[item.entry.side];
      if (!updated.has(token)) continue;
      const book = books.books.get(token);
      if (!book || book.timestamp<item.target || book.timestamp>frame.recv+1500) continue;
      const valid = books.raw(token);
      if (!valid) continue;
      const proceeds = bidProceeds(book.bids,shares,market.rate);
      const observed = {recv:frame.recv,source:book.timestamp,bid:valid.bestBid};
      item.liquidity = capacity.get(item.entry)?.map(point=>{
        if (point.state!=='entry-priced') return point;
        const sale = bidProceeds(book.bids,point.size,market.rate);
        return sale ? {...point,state:'priced',exitNet:sale.net,
          stressedNet:sale.net-point.cost-2*stressPerLeg*point.size} : {...point,state:'exit-depth'};
      });
      Object.assign(item,observed,proceeds ? {state:'priced',proceeds,
        net:proceeds.net-item.entry.quote.total,stressedNet:proceeds.net-item.entry.quote.total-2*stressPerLeg*shares} :
        {state:'insufficient-depth'});
    }
    while (head<waiting.length && waiting[head].state!=='unknown') head++;
    if (head===waiting.length) break;
  }
  return waiting.map(({entry,delay,target,state,...exit})=>({model:entry.model,latency:entry.latency,
    side:entry.side,delay,target,state,entryRecv:entry.recv,entryCost:entry.quote.total,
    ...exit,liquidity:exit.liquidity ?? capacity.get(entry)?.map(point=>point.state==='entry-priced' ?
      {...point,state:'exit-unknown'} : point) ?? null}));
}

export function flowEntries(row, policy) {
  const initial = row.observed?.initial;
  const {imbalance,acceleration} = row.flow;
  if (imbalance==null || acceleration==null || !initial?.every(o=>o.quote)) return [];
  const [up,down] = initial.map(o=>o.quote.average);
  const prior = Math.log(up/down);
  const impulse = Math.max(-1,Math.min(1,acceleration));
  const models = {flow:.45*imbalance,impulse:.35*impulse,combined:.45*imbalance+.35*impulse};
  const cost = q=>q.total/policy.shares+policy.stressPerLeg;
  return Object.entries(models).flatMap(([model,signal])=>{
    const p = 1/(1+Math.exp(-(prior+signal)));
    const probs = [p,1-p];
    const side = probs[0]-cost(initial[0].quote)>=probs[1]-cost(initial[1].quote) ? 0 : 1;
    if (probs[side]-cost(initial[side].quote)<policy.directionalEdge) return [];
    return row.observed.samples.flatMap(sample=>{
      const entry = sample.sides[side];
      return entry?.quote && probs[side]-cost(entry.quote)>=policy.directionalEdge ?
        [{...entry,side,model,target:probs[side],latency:sample.barrier-row.time}] : [];
    });
  });
}

export function aggregate(rows) {
  const stats = {};
  for (const row of rows) for (const exit of row.exits) {
    const phase = stats[row.phase] ??= {};
    const latency = phase[exit.latency] ??= {};
    const model = latency[exit.model] ??= {};
    const mark = model[exit.delay] ??= {entries:0,priced:0,insufficient:0,unknown:0,net:0,stressedNet:0,mean:null};
    mark.entries++;
    if (exit.state==='unknown') mark.unknown++;
    if (exit.state==='insufficient-depth') mark.insufficient++;
    if (exit.state==='priced') {
      mark.priced++;
      mark.net+=exit.net;
      mark.stressedNet+=exit.stressedNet;
      mark.mean=mark.stressedNet/mark.priced;
    }
    mark.liquidity ??= Object.fromEntries(sizes.map(size=>[size,{priced:0,stressedNet:0,missing:0,rejections:{}}]));
    for (const size of sizes) {
      const stats = mark.liquidity[size];
      const point = exit.liquidity?.find(x=>x.size===size);
      if (point?.state==='priced') {
        stats.priced++;
        stats.stressedNet+=point.stressedNet;
      } else if (!point || point.state==='exit-unknown') {
        stats.missing++;
      } else {
        stats.rejections[point.state]=(stats.rejections[point.state]??0)+1;
      }
    }
  }
  return stats;
}

async function joinPending(rows) {
  if (!rows.length) return [];
  return new Promise((resolve,reject)=>{
    const python = process.env.VISUALTRADER_PYTHON ?? 'python';
    const child = execFile(python,['-B','poly_spot_join.py','--rows'],{maxBuffer:32*1024*1024},(error,out)=>{
      if (error) reject(error);
      else {
        try { resolve(out.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)); }
        catch (e) { reject(e); }
      }
    });
    child.stdin.on('error',reject);
    child.stdin.end(rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  });
}

async function main() {
  const {values:args} = parseArgs({options:{watch:{type:'boolean'},export:{type:'boolean'}}});
  const dir = 'data/polymarket-v2';
  const policy = JSON.parse(readFileSync('docs/poly-edge-policy.json'));
  const digest = createHash('sha256');
  for (const file of ['poly_markout.mjs','poly_spot_join.py','docs/poly-edge-policy.json']) digest.update(readFileSync(file));
  const implementation = digest.digest('hex');
  const db = new DatabaseSync(dir+'/markout.sqlite',{readOnly:!!args.export});
  if (args.export) {
    try {
      const {protocol} = JSON.parse(readFileSync(dir+'/markout.json'));
      for (const row of db.prepare('SELECT record FROM observations WHERE protocol=? ORDER BY start').iterate(protocol)) {
        process.stdout.write(row.record+'\n');
      }
    } finally {db.close();}
    return;
  }
  const lock = new DatabaseSync(dir+'/markout.lock.sqlite');
  lock.exec('BEGIN EXCLUSIVE');
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS observations(
    protocol TEXT,start INTEGER,record TEXT,PRIMARY KEY(protocol,start));`);
  const stash = db.prepare('INSERT OR IGNORE INTO observations VALUES(?,?,?)');
  const existing = db.prepare('SELECT start,record FROM observations WHERE protocol=?');
  let running = true, timer, wake;
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{running=false;clearTimeout(timer);wake?.();});
  try {
    do {
      try {
        const started = performance.now();
        const {stdout} = await run(process.execPath,['poly_edge.mjs','--export'],{maxBuffer:64*1024*1024});
        const rows = stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
        const source = rows[0]?.digest;
        if (!source || rows.some(row=>row.digest!==source)) throw new Error('No single source experiment');
        const protocol = implementation+'/'+source;
        const stored = new Map(existing.all(protocol).map(row=>[row.start,JSON.parse(row.record)]));
        const now = Date.now();
        const pending = rows.filter(row=>!stored.has(row.start) && row.observed?.initial &&
          now-row.time>180_000);
        const joined = await joinPending(pending);
        const clob = new DatabaseSync('data/polymarket-clob/events.sqlite',{readOnly:true});
        try {
          clob.exec('PRAGMA busy_timeout=3000');
          const tail = clob.prepare('SELECT recv FROM frames ORDER BY seq DESC LIMIT 1').get()?.recv??0;
          const market = clob.prepare('SELECT info FROM markets WHERE slug=?');
          const frames = clob.prepare('SELECT recv,type,data FROM frames WHERE slug=? AND recv<=? ORDER BY seq');
          for (const row of joined) {
            const entries = flowEntries(row,policy);
            for (const model of ['skew','opening','consensus']) {
              const side = row.plans?.[model]?.side;
              if (side==null) continue;
              for (const sample of row.observed.samples) {
                const latency = sample.barrier-row.time;
                const entry = sample.sides[side];
                if (row.outcomes[model][latency].state==='fill') entries.push({...entry,model,side,latency,
                  target:row.plans[model].target});
              }
            }
            const deadline = entries.length ? Math.max(...entries.map(e=>e.recv))+horizons.at(-1)+grace : 0;
            if (deadline>=now || (tail<deadline && now-deadline<120_000)) continue;
            const meta = entries.length && market.get(row.slug);
            const exits = replayExits(meta ? JSON.parse(meta.info) : {ends:Infinity},
              meta ? frames.iterate(row.slug,deadline) : [],entries,policy.shares,policy.stressPerLeg,policy.directionalEdge);
            const record = {protocol,start:row.start,slug:row.slug,
              phase:row.start<Date.parse(policy.flowStartUtc??'2026-11-14T20:20:00Z')?'prior':'after-cutoff',
              flowCovered:row.flow.acceleration!=null,exits};
            stash.run(protocol,row.start,JSON.stringify(record));
            stored.set(row.start,record);
          }
        } finally {clob.close();}
        const report = {checked:new Date().toISOString(),protocol,horizons,replayed:stored.size,
          windows:[...stored.values()].filter(row=>row.exits.length).length,
          timeMs:Math.round(performance.now()-started),table:aggregate(stored.values())};
        await publishJson(dir+'/markout.json',report);
        if (!args.watch) console.log(JSON.stringify(report,null,2));
      } catch (error) {
        if (!args.watch) throw error;
        console.error(error.message);
      }
      if (args.watch && running) await new Promise(r=>{wake=r;timer=setTimeout(r,300_000);});
    } while (args.watch && running);
  } finally {lock.close();db.close();}
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
