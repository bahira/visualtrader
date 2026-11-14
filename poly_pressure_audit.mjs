import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {parseArgs,promisify} from 'node:util';
import {results} from './poly_pressure.mjs';
import {publishJson} from './json_status.mjs';

const run = promisify(execFile);
const DIR = 'data/polymarket-v2';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN_BLOCKS = 10;
const THRESHOLDS = [.02,.04,.06,.08];
const STRESSES = [.005,.015];
const SWEEP_START = Date.parse('2026-11-14T21:00:00Z');

export function thresholdSweep(paired, policy) {
  const sweep = {};
  for (const {phase,row,record} of paired) {
    const group = sweep[phase] ??= {};
    for (const stress of STRESSES) for (const threshold of THRESHOLDS) {
      const metrics = results(record,row,{...policy,stressPerLeg:stress,directionalEdge:threshold});
      const scenario = group[`${Math.round(threshold*100)}/${stress*100}`] ??= {};
      for (const [latency,models] of Object.entries(metrics)) {
        const latencyGroup = scenario[latency] ??= {};
        for (const [name,value] of Object.entries(models)) {
          if (name==='book') continue;
          const item = latencyGroup[name] ??= {markets:0,fills:0,rejected:0,unknown:0,net:0,cost:0,bestFill:null,
            netWithoutBest:null,pessimisticNet:0,netFixedFillsExtraCent:0};
          item.markets++;
          if (value.status==='unknown') item.unknown++;
          if (value.status==='reject') item.rejected++;
          if (value.status==='fill') {
            item.fills++;
            item.net+=value.stress;
            item.netFixedFillsExtraCent+=value.stress-.01*policy.shares;
            item.cost+=value.cost;
            item.bestFill=Math.max(item.bestFill??-Infinity,value.stress);
          }
          item.netWithoutBest=item.fills>=2 ? item.net-item.bestFill : null;
          item.pessimisticNet=item.net-item.unknown*policy.shares*(1+stress);
        }
      }
    }
  }
  return sweep;
}

export function pairedInterval(blocks, repetitions=4000) {
  if (blocks.length<MIN_BLOCKS) return null;
  let seed = 54093;
  const samples = [];
  for (let trial=0;trial<repetitions;trial++) {
    let sum = 0, n = 0;
    for (let i=0;i<blocks.length;i++) {
      seed = (Math.imul(seed,1664525)+1013904223)>>>0;
      const block = blocks[Math.floor(seed/2**32*blocks.length)];
      sum+=block.sum;
      n+=block.n;
    }
    samples.push(sum/n);
  }
  samples.sort((a,b)=>a-b);
  return [samples[Math.floor(.025*repetitions)],samples[Math.floor(.975*repetitions)]];
}

function addBlock(blocks,key,delta) {
  const block = blocks[key] ??= {n:0,sum:0};
  block.n++;
  block.sum+=delta;
}

export function audit(paired, policy) {
  const analysis = {};
  const maxLoss = policy.shares*(1+policy.stressPerLeg);
  for (const row of paired) {
    const hour = Math.floor(row.start/HOUR)*HOUR;
    const day = Math.floor(row.start/DAY)*DAY;
    const phase = analysis[row.phase] ??= {};
    for (const [latency,models] of Object.entries(row.metrics)) {
      const group = phase[latency] ??= {};
      for (const [name,outcome] of Object.entries(models)) {
        if (name==='book') continue;
        const m = group[name] ??= {markets:0,unknown:0,fills:0,net:0,bestFill:null,worstFill:null,
          pairedBrier:0,pairedNet:0,pairedExecutions:0,forecastHours:{},forecastDays:{},
          pessimisticDays:{},fillsBySide:[0,0],netBySide:[0,0]};
        const delta = outcome.brier-models.book.brier;
        m.markets++;
        m.pairedBrier+=delta;
        addBlock(m.forecastHours,hour,delta);
        addBlock(m.forecastDays,day,delta);
        addBlock(m.pessimisticDays,day,outcome.stress??-maxLoss);
        if (outcome.stress!==null && models.book.stress!==null) {
          m.pairedNet+=outcome.stress-models.book.stress;
          m.pairedExecutions++;
        }
        if (outcome.status==='unknown') m.unknown++;
        if (outcome.status!=='fill') continue;
        m.fills++;
        m.net+=outcome.stress;
        m.bestFill=Math.max(m.bestFill??-Infinity,outcome.stress);
        m.worstFill=Math.min(m.worstFill??Infinity,outcome.stress);
        m.fillsBySide[outcome.side]++;
        m.netBySide[outcome.side]+=outcome.stress;
      }
    }
  }
  for (const phase of Object.values(analysis)) for (const group of Object.values(phase)) {
    for (const m of Object.values(group)) {
      const hours = Object.values(m.forecastHours), days = Object.values(m.forecastDays);
      m.pairedBrier/=m.markets;
      m.hours=hours.length;
      m.days=days.length;
      m.brierRangeByHour=pairedInterval(hours);
      m.brierRangeByDay=pairedInterval(days);
      m.pessimisticRangeByDay=pairedInterval(Object.values(m.pessimisticDays));
      m.pessimisticNet=m.net-m.unknown*maxLoss;
      m.netWithoutBest=m.fills>=2 ? m.net-m.bestFill : null;
      delete m.forecastHours;
      delete m.forecastDays;
      delete m.pessimisticDays;
    }
  }
  return analysis;
}

async function main() {
  const {values:{watch}} = parseArgs({options:{watch:{type:'boolean'}}});
  const policy = JSON.parse(readFileSync('docs/poly-edge-policy.json'));
  const hash = createHash('sha256');
  for (const file of ['poly_pressure.mjs','poly_clob.mjs','poly_spot_join.py','docs/poly-edge-policy.json']) {
    hash.update(readFileSync(file));
  }
  const implementation = hash.digest('hex');
  const auditHash = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
  const state = new DatabaseSync(DIR+'/pressure-audit.sqlite');
  state.exec(`PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS registrations(protocol TEXT PRIMARY KEY,registered INTEGER NOT NULL);`);
  const register = state.prepare('INSERT OR IGNORE INTO registrations VALUES(?,?)');
  const first = state.prepare('SELECT registered FROM registrations WHERE protocol=?');
  let running = true, timer, wake, previous;
  for (const sig of ['SIGINT','SIGTERM']) process.on(sig,()=>{running=false;clearTimeout(timer);wake?.();});
  do {
    try {
      const before = readFileSync(DIR+'/pressure.json','utf8');
      if (before!==previous) {
        const source = JSON.parse(before);
        if (source.protocol.split('/')[0]!==implementation) throw new Error('Pressure implementation differs');
        const sweepProtocol = auditHash+'/'+source.protocol;
        register.run(sweepProtocol,Date.now());
        const {registered} = first.get(sweepProtocol);
        const prospective = source.prospective && registered<SWEEP_START;
        const childOptions = {maxBuffer:32*1024*1024,timeout:60000};
        const [pressure,edge] = await Promise.all([
          run(process.execPath,['poly_pressure.mjs','--export'],childOptions),
          run(process.execPath,['poly_edge.mjs','--export'],childOptions),
        ]);
        // If the writer published during export, retry the complete observation on the next cycle.
        if (before!==readFileSync(DIR+'/pressure.json','utf8')) throw new Error('Source report advanced during export');
        const parse = child=>child.stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
        const sourceDigest = source.protocol.split('/').at(-1);
        const outcomes = parse(edge);
        if (!outcomes.length || outcomes.some(row=>row.digest!==sourceDigest)) throw new Error('Source protocol differs');
        const cached = new Map(parse(pressure).map(row=>[row.slug,row]));
        const start = Date.parse(source.start);
        const paired = [];
        for (const row of outcomes) {
          const record = cached.get(row.slug);
          if (row.winner==null || record?.time!==row.time) continue;
          const metrics = results(record,row,policy);
          if (!metrics) continue;
          paired.push({start:row.start,phase:row.start<start?'prior':source.prospective?'forward':'retrospective',metrics,row,record});
        }
        const report = {checked:new Date().toISOString(),sourceChecked:source.checked,protocol:source.protocol,
          minBlocks:MIN_BLOCKS,analysis:audit(paired,policy),
          sweepPolicy:{protocol:sweepProtocol,registered:new Date(registered).toISOString(),
            start:new Date(SWEEP_START).toISOString(),prospective},
          sweep:thresholdSweep(paired.map(entry=>({...entry,phase:entry.start<SWEEP_START?'prior':
            prospective?'forward':'retrospective'})),policy)};
        await publishJson(DIR+'/pressure-audit.json',report);
        previous=before;
        if (!watch) console.log(JSON.stringify(report,null,2));
      }
    } catch (error) {
      if (!watch) throw error;
      console.error(error.message);
    }
    if (watch && running) await new Promise(resolve=>{wake=resolve;timer=setTimeout(resolve,60_000);});
  } while (watch && running);
  state.close();
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
