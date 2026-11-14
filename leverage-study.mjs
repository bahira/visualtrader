import {DatabaseSync} from 'node:sqlite';
import {parseArgs} from 'node:util';
import {Engine, decode, policy} from './engine.mjs';
import {FastPaper, fastPolicy} from './fast-paper.mjs';

const {values: args} = parseArgs({options:{
  db:{type:'string',default:'data/live.sqlite'}, session:{type:'string',default:'3'},
  'end-seq':{type:'string'}, 'interest-bps-hour':{type:'string',default:'0'},
}});
const session = Number(args.session);
const interestBps = Number(args['interest-bps-hour']);
if (!Number.isSafeInteger(session) || session <= 0 || !Number.isFinite(interestBps) || interestBps < 0) {
  throw new Error('Session ou intérêt invalide');
}
const db = new DatabaseSync(args.db,{readOnly:true});
const lastSeq = args['end-seq'] === undefined
  ? db.prepare('SELECT MAX(seq) AS seq FROM market WHERE session=?').get(session).seq
  : Number(args['end-seq']);
if (!Number.isSafeInteger(lastSeq) || lastSeq <= 0) throw new Error('Capture absente ou borne invalide');
const scenarios = [1,2,3,5,10].map(multiplier => {
  const size = fastPolicy.stake * multiplier;
  let borrow = null;
  const scenario = {multiplier, size, interest:0, minMarkReturn:null};
  const onFill = (kind, row) => {
    if (kind !== 'fill') return;
    if (row.side === 'BUY') {
      const notional = row.qty * row.price;
      borrow = {principal:notional * (1 - 1 / multiplier), time:row.time};
    } else if (borrow) {
      scenario.interest += borrow.principal * interestBps / 10_000 * (row.time - borrow.time) / 3_600_000;
      borrow = null;
    }
  };
  scenario.fast = new FastPaper(policy,undefined,onFill,{...fastPolicy,stake:size});
  return scenario;
});
const engine = new Engine();
let began, end, bookCount = 0;
const start = performance.now();
for (const {recv,json} of db.prepare('SELECT recv,json FROM market WHERE session=? AND seq<=? ORDER BY seq').iterate(session,lastSeq)) {
  began ??= recv;
  end = Math.max(end ?? recv,recv);
  const event = decode(JSON.parse(json));
  const old = engine.book;
  const gaps = engine.count.gaps;
  // Keep the source freshness and gap handling shared with the live engine.
  if (event?.kind !== 'trade') engine.handle(event,end);
  if (event?.kind === 'book' && old !== engine.book) {
    const fresh = engine.fresh(end);
    bookCount++;
    for (const row of scenarios) {
      if (fresh) {
        row.fast.tick(engine.book,end,false);
        const wallet = row.fast.wallet;
        if (!wallet.position) continue;
        const mark = wallet.equity(engine.book);
        if (mark === null) continue;
        const openReturn = (mark - wallet.cash -
          (wallet.position.qty * wallet.position.price + wallet.position.fee)) / fastPolicy.stake;
        row.minMarkReturn = Math.min(row.minMarkReturn ?? 0,openReturn);
      } else row.fast.suspend(end,'Flux insuffisant',true);
    }
  } else if (engine.count.gaps > gaps || (event?.kind === 'candle' && event.closed && !engine.fresh(end))) {
    for (const row of scenarios) row.fast.suspend(end,'Flux insuffisant',true);
  }
}
db.close();
if (!bookCount) throw new Error('Aucun snapshot de carnet dans la capture');
const base = scenarios[0].fast.wallet;
const results = scenarios.map(({multiplier,size,interest,minMarkReturn,fast}) => {
  const {wallet,target,qualifiedMinutes,fullMinutes,rejections} = fast.summary(engine.fresh(end) ? engine.book : null,end);
  return {multiplier, simulatedEntryBudget:size, closedCycles:wallet.trades, wins:wallet.wins,
    qualifiedMinutes, fullMinutes, target, rejections, grossRealized:wallet.gross, feesAccrued:wallet.fees,
    borrowInterestProxyClosed:interest, netRealized:wallet.net-interest, worstOpenMarkPctOfInitialMargin:minMarkReturn === null ? null : minMarkReturn*100,
    grossBreakEvenFeeBpsPerSide:fast.closedNotional ? wallet.gross / fast.closedNotional * 10_000 : null,
    fixedExposureNetPerCycle:base.trades ? base.net / base.trades : null,
    fixedExposureReturnOnMarginPctPerCycle:base.trades ? base.net / base.trades / (fastPolicy.stake / multiplier) * 100 : null};
});
console.log(JSON.stringify({session,endSeq:lastSeq,bookCount,captureMinutes:(end-began)/60_000,
  elapsedMs:performance.now()-start, interestBpsPerHour:interestBps, feeBps:policy.feeBps, slipBps:policy.slipBps, results},null,2));
