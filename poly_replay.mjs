import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import {replayEvidence} from './polymarket_paper.mjs';

const db = new DatabaseSync(process.argv[2] ?? 'data/polymarket-v2/paper.sqlite',{readOnly:true});
const report = {checked:0,legacy:0,mismatches:[],resolved:0,skewDecisionChanges:0,skewNetDelta:0};
try {
  for (const row of db.prepare('SELECT trials.start,trials.record AS trial,winner,evidence.record AS raw FROM trials LEFT JOIN evidence USING(start) ORDER BY start').iterate()) {
    const stored = JSON.parse(row.trial);
    if (row.winner !== null) {
      report.resolved++;
      const pnl = f => f ? (f.side===row.winner ? 10 : 0)-f.total : 0;
      report.skewNetDelta += pnl(stored.fills.skew)-pnl(stored.fills.momentum);
    }
    if (stored.fills.skew?.side !== stored.fills.momentum?.side) report.skewDecisionChanges++;
    const raw = JSON.parse(row.raw);
    if (!raw?.featureTime) { report.legacy++; continue; }
    report.checked++;
    try {
      const replay = replayEvidence(raw);
      for (const key of ['features','prob','fills','reasons']) {
        const original = key==='reasons' ? Object.fromEntries(Object.entries(stored[key]).map(
          ([name,value])=>[name,{...value,reason:value.reason.replace('Fill simul\u00c3\u00a9','Fill simul\u00e9')}])) : stored[key];
        if (!isDeepStrictEqual(replay[key],original)) report.mismatches.push({start:row.start,field:key});
      }
    } catch (error) { report.mismatches.push({start:row.start,error:error.message}); }
  }
} finally {
  db.close();
}
console.log(JSON.stringify(report,null,2));
process.exitCode = Number(report.mismatches.length > 0);
