import {Portfolio, bps} from './engine.mjs';

export const fastPolicy = {
  slotMs:5_000, minimumHoldMs:1_000, timeoutMs:2_600, stake:250, target:10,
};

export class FastPaper {
  constructor(config, saved, log, rules = fastPolicy, label = 'Rapide') {
    this.rules = rules;
    this.wallet = new Portfolio({...config, stake:this.rules.stake, cooldownMs:0, depthSizing:true}, label, saved?.wallet);
    this.log = log;
    this.closedNotional = saved?.closedNotional ?? 0;
    this.entryNotional = saved?.entryNotional ?? 0;
    this.slot = saved?.slot ?? -1;
    this.entries = saved?.entries ?? 0;
    this.rejections = saved?.rejections ?? 0;
    this.rejectReasons = saved?.rejectReasons ?? {};
    this.firstMinute = saved?.firstMinute ?? null;
    this.minute = saved?.minute ?? null;
    this.minuteCycles = saved?.minuteCycles ?? 0;
    this.qualifiedMinutes = saved?.qualifiedMinutes ?? 0;
    this.recent = saved?.recent ?? [];
  }
  checkpoint() {
    const {rules, log, wallet, ...saved} = this;
    return {...saved, wallet:wallet.checkpoint()};
  }
  advance(now) {
    const minute = Math.floor(now / 60_000);
    if (this.firstMinute === null) this.firstMinute = minute + 1;
    if (this.minute === minute) return;
    if (this.minute !== null && this.minute >= this.firstMinute && this.minuteCycles >= this.rules.target) {
      this.qualifiedMinutes++;
    }
    this.minute = minute;
    this.minuteCycles = 0;
  }
  record(row, time) {
    const full = {...row, wallet:this.wallet.id, strategy:this.wallet.id, time};
    this.log(row.type, full);
    if (row.type === 'reject') {
      this.rejections++;
      this.rejectReasons[row.reason] = (this.rejectReasons[row.reason] ?? 0) + 1;
    }
    if (row.type !== 'fill') return;
    const notional = row.qty * row.price;
    if (row.side === 'BUY') {
      this.entries++;
      this.entryNotional = notional;
    } else {
      this.minuteCycles++;
      this.closedNotional += this.entryNotional + notional;
      this.entryNotional = 0;
    }
    this.recent.unshift(full);
    if (this.recent.length > 40) this.recent.pop();
  }
  suspend(time, reason, includingExits = false) {
    const order = this.wallet.pending;
    if (!order || (!includingExits && order.side !== 'BUY')) return;
    this.wallet.pending = null;
    this.record({type:'reject', side:order.side, signalTime:order.time, reason},time);
  }
  tick(book, time, paused) {
    this.advance(time);
    const wallet = this.wallet;
    const fill = wallet.execute(book, time);
    if (fill) this.record(fill,time);
    wallet.mark(book);
    const [bid,bidQty] = book.bids[0], [ask,askQty] = book.asks[0];
    const mid = (bid + ask) / 2;
    const slot = Math.floor(time / this.rules.slotMs);
    if (wallet.pending) return;
    const position = wallet.position;
    let side, reason;
    if (position) {
      const age = time - position.time;
      const feeRate = wallet.p.feeBps / 10_000;
      const netAtBid = bid * (1 - wallet.p.slipBps / 10_000) * (1 - feeRate) -
        position.price - position.fee / position.qty;
      if (age >= this.rules.timeoutMs) reason = 'Durée maximale';
      else if (age >= this.rules.minimumHoldMs && netAtBid > 0) reason = 'Bid indicatif au-dessus des coûts';
      if (!reason) return;
      side = 'SELL';
    } else {
      if (paused || slot <= this.slot || wallet.cash < this.rules.stake ||
        bps(ask,bid) > wallet.p.maxSpreadBps) return;
      // Give quote imbalance up to 800 ms to choose an entry inside each cadence slot.
      const offset = time % this.rules.slotMs;
      if (offset > 1_650 || (offset < 800 && bidQty < askQty)) return;
      this.slot = slot;
      side = 'BUY';
      reason = offset < 800 ? 'Déséquilibre au bid' : 'Entrée de cadence';
    }
    if (wallet.intent(side,time,reason,mid)) {
      this.log('signal', {wallet:wallet.id, strategy:this.wallet.id, time, side, reason, mid});
    }
  }
  summary(book, now) {
    const minute = Math.floor(now / 60_000);
    const fullMinutes = this.firstMinute === null ? 0 : Math.max(0, minute - this.firstMinute);
    const extra = this.minute !== null && this.minute >= this.firstMinute &&
      this.minute < minute && this.minuteCycles >= this.rules.target ? 1 : 0;
    let fills60 = 0, cycles60 = 0;
    for (const fill of this.recent) {
      if (fill.time <= now - 60_000) break;
      fills60++;
      if (fill.side === 'SELL') cycles60++;
    }
    return {wallet:this.wallet.summary(book), target:this.rules.target, fills60, cycles60, fullMinutes,
      qualifiedMinutes:this.qualifiedMinutes + extra, entries:this.entries, rejections:this.rejections,
      recent:this.recent, rejectReasons:this.rejectReasons};
  }
}
