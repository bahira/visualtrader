import {DatabaseSync} from 'node:sqlite';
import {replayClob} from './poly_clob.mjs';

const paper = new DatabaseSync('data/polymarket-v2/paper.sqlite',{readOnly:true});
const clob = new DatabaseSync('data/polymarket-clob/events.sqlite',{readOnly:true});
const report = {matchedMarkets:0,settledMarkets:0,models:{}};
try {
  const captured = clob.prepare('SELECT MIN(recv) AS start FROM frames WHERE slug=? AND type=\'data\'');
  for (const row of paper.prepare('SELECT start,slug,time,record,winner FROM trials ORDER BY start').iterate()) {
    const coverage = captured.get(row.slug).start;
    if (coverage == null || coverage > row.time) continue;
    const trial = JSON.parse(row.record);
    report.matchedMarkets++;
    if (row.winner !== null) report.settledMarkets++;
    for (const [model,reason] of Object.entries(trial.reasons ?? {})) {
      const stats = report.models[model] ??= {eligible:0,restFills:0,clobFills:0,unknown:0,paired:0,netDelta:0,sensitivity:{}};
      if (reason.side == null || !(reason.signalEdge>=.04)) continue;
      stats.eligible++;
      const rest = trial.fills[model];
      if (rest) stats.restFills++;
      for (const latency of [250,500,1000]) {
        const counts = stats.sensitivity[latency] ??= {fills:0,unknown:0,settled:0,net:0};
        const observed = replayClob(clob,row.slug,row.time,reason.side,latency,10,row.start+138_000);
        if (!observed) {
          counts.unknown++;
          if (latency===500) stats.unknown++;
          continue;
        }
        const cost = observed.quote?.total;
        const fills = cost != null && reason.prob-(cost/10)>=.04;
        if (fills) {
          counts.fills++;
          if (row.winner!==null) { counts.settled++; counts.net+=Number(row.winner===reason.side)*10-cost; }
        }
        if (latency!==500) continue;
        if (fills) stats.clobFills++;
        if (row.winner===null) continue;
        stats.paired++;
        const payout = Number(row.winner===reason.side)*10;
        stats.netDelta += (fills?payout-cost:0)-(rest?payout-rest.total:0);
      }
    }
  }
} finally { paper.close(); clob.close(); }
console.log(JSON.stringify(report,null,2));
