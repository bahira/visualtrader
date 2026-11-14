export const streams = 'btcusdt@kline_1s/btcusdt@trade/btcusdt@depth20@100ms';
export const host = 'wss://stream.binance.com:443';
export const policy = {
  cash: 10_000, stake: 1_000, feeBps: 10, slipBps: 1, latencyMs: 250,
  maxSpreadBps: 5, staleMs: 2_500, maxOrderMs: 3_000,
  windowMs: 900_000, minTrades: 5, minCoverage: 0.98, minEdgeBps: 1,
  cooldownMs: 15_000, stopBps: 32, targetBps: 65, maxHoldMs: 300_000,
};
export const strategies = [7, 15, 25].flatMap(fast => [45, 99].flatMap(slow =>
  [3, 8].map(edge => ({ id: 'M' + fast + '/' + slow + ' · ' + edge, fast, slow, edge }))));
const mean = values => values.reduce((sum, n) => sum + n, 0) / values.length;
export const bps = (a, b) => (a / b - 1) * 10_000;

export function decode(message) {
  const {stream, data: d} = message;
  if (stream === 'btcusdt@kline_1s' && d.k?.i === '1s') {
    const k = d.k;
    return { kind: 'candle', t: k.t, exchange: d.E, o: +k.o, h: +k.h, l: +k.l,
      c: +k.c, v: +k.v, n: k.n, closed: k.x };
  }
  if (stream === 'btcusdt@trade') {
    return { kind: 'trade', t: d.T, exchange: d.E, id: d.t, price: +d.p, size: +d.q, sell: d.m };
  }
  if (stream === 'btcusdt@depth20@100ms' && d.bids?.length && d.asks?.length) {
    return { kind: 'book', id: d.lastUpdateId, bids: d.bids.map(row => row.map(Number)),
      asks: d.asks.map(row => row.map(Number)) };
  }
  return null;
}

export function walk(levels, quantity) {
  let remaining = quantity;
  let notional = 0;
  for (const [price, size] of levels) {
    const used = Math.min(remaining, size);
    notional += used * price;
    remaining -= used;
    if (remaining <= 1e-12) return notional / quantity;
  }
  return null;
}

function quantityForBudget(levels, notional) {
  let total = 0;
  for (const [price, size] of levels) {
    const quantity = Math.min(size, notional / price);
    total += quantity;
    notional -= quantity * price;
    if (notional < 1e-8) return total;
  }
  return null;
}

export class Portfolio {
  constructor(p, id, saved) {
    this.p = p;
    this.id = id;
    this.cash = p.cash;
    this.position = null;
    this.pending = null;
    this.trades = this.wins = this.fees = this.net = this.gross = this.drag = this.drawdown = 0;
    this.peak = p.cash;
    this.cooldown = 0;
    this.profit = this.loss = 0;
    this.best = this.worst = 0;
    if (saved) Object.assign(this, saved);
  }
  checkpoint() {
    const {p, pending, ...saved} = this;
    return saved;
  }
  intent(side, time, reason, mid) {
    if (this.pending) return false;
    this.pending = {side, time, reason, mid};
    return true;
  }
  execute(book, time) {
    const order = this.pending;
    if (!order || time <= order.time || time < order.time + this.p.latencyMs) return;
    const {side, mid, reason} = order;
    const reject = why => {
      this.pending = null;
      return {type:'reject', side, reason:why, signalTime:order.time};
    };
    if (time - order.time > this.p.maxOrderMs) return reject('Ordre expiré');
    const buy = side === 'BUY';
    const bestAsk = book.asks[0][0];
    const bestBid = book.bids[0][0];
    if (buy && bps(bestAsk, bestBid) > this.p.maxSpreadBps) return reject('Spread trop large');
    const feeRate = this.p.feeBps / 10_000;
    const slip = this.p.slipBps / 10_000;
    const budget = Math.min(this.p.stake, this.cash);
    const buyNotional = budget / (1 + feeRate) / (1 + slip);
    let qty = this.position?.qty;
    if (buy) {
      const available = this.p.depthSizing ? quantityForBudget(book.asks,buyNotional) : buyNotional / bestAsk;
      if (available === null) return reject('Profondeur insuffisante');
      // Round down to satoshis before consuming the visible liquidity.
      qty = Math.floor(available * 1e8) / 1e8;
    }
    if (qty <= 0) return reject('Capital insuffisant');
    const vwap = walk(buy ? book.asks : book.bids, qty);
    if (vwap === null) return reject('Profondeur insuffisante');
    const price = vwap * (buy ? 1 + slip : 1 - slip);
    const value = qty * price;
    const fee = value * feeRate;
    if (buy && value + fee > budget + 1e-8) return reject('Profondeur hors budget');
    this.pending = null;
    this.fees += fee;
    const drag = (buy ? price - mid : mid - price) * qty;
    this.drag += drag;
    let net = null, gross = null;
    if (buy) {
      this.cash -= value + fee;
      this.position = {qty, price, fee, time, mid};
    } else {
      const entry = this.position;
      gross = (price - entry.price) * qty;
      net = gross - (entry.fee + fee);
      this.gross += gross;
      this.net += net;
      this.profit += Math.max(0, net);
      this.loss += Math.max(0, -net);
      this.best = Math.max(this.best, net);
      this.worst = Math.min(this.worst, net);
      this.trades++;
      this.wins += Number(net > 0);
      this.cash += value - fee;
      this.position = null;
      this.cooldown = time + this.p.cooldownMs;
    }
    return {type:'fill', side, reason, qty, price, fee, vwap, drag, net, gross,
      spreadBps:bps(bestAsk,bestBid), signalTime:order.time, latencyMs:time-order.time, depthId:book.id};
  }
  equity(book) {
    if (!this.position) return this.cash;
    if (!book) return null;
    const mark = walk(book.bids, this.position.qty);
    return mark === null ? null : this.cash + mark * this.position.qty *
      (1 - this.p.slipBps / 10_000) * (1 - this.p.feeBps / 10_000);
  }
  mark(book) {
    const equity = this.equity(book);
    if (equity === null) return;
    this.peak = Math.max(this.peak, equity);
    this.drawdown = Math.max(this.drawdown, this.peak - equity);
  }
  summary(book) {
    const equity = this.equity(book);
    const score = equity === null ? null : ((equity - this.p.cash) - 0.5 * this.drawdown) / this.p.cash * 10_000;
    return {id:this.id, cash:this.cash, position:this.position, equity, score, trades:this.trades,
      wins:this.wins, best:this.best, worst:this.worst, profit:this.profit, loss:this.loss,
      averageNet:this.trades ? this.net / this.trades : null,
      profitFactor:this.loss ? this.profit / this.loss : null, fees:this.fees, drag:this.drag, gross:this.gross, net:this.net, drawdown:this.drawdown};
  }
}

export function evaluate(results, nomination, incumbent, coverage, p) {
  if (coverage < p.minCoverage) return {reason:'Couverture du flux insuffisante', pass:false};
  if (!nomination) return {reason:'Fenêtre de sélection terminée', pass:false};
  const candidate = results.find(row => row.id === nomination);
  const baseline = results.find(row => row.id === incumbent);
  if (candidate.score === null || candidate.trades < p.minTrades) {
    return {reason:'Échantillon de validation insuffisant', pass:false};
  }
  if (candidate.score < Math.max(0, baseline?.score ?? 0) + p.minEdgeBps) {
    return {reason:'Avantage net insuffisant face au cash et à la stratégie active', pass:false};
  }
  return {reason:'Avantage net confirmé sur la fenêtre suivante', pass:true};
}

export class Engine {
  constructor({config = policy, saved, log = () => {}} = {}) {
    this.p = config;
    this.log = log;
    this.active = new Portfolio(config, 'Actif', saved?.active);
    this.strategy = saved?.strategy ?? null;
    this.paused = saved?.paused ?? false;
    this.audit = saved?.audit ?? [];
    this.fills = saved?.fills ?? [];
    this.equity = saved?.equity ?? [];
    this.candles = [];
    this.tape = [];
    this.flow = [];
    this.count = {candle:0, trade:0, book:0, gaps:0};
    this.last = {};
    this.context = null;
    this.book = null;
    this.nomination = null;
    this.waiting = null;
    this.nextWindow = null;
    this.resetShadows();
  }
  resetShadows() {
    this.shadows = strategies.map(s => new Portfolio(this.p, s.id));
    this.covered = 0;
    this.window = null;
  }
  checkpoint() {
    return {active:this.active.checkpoint(), strategy:this.strategy, paused:this.paused,
      fills:this.fills, audit:this.audit, equity:this.equity};
  }
  connectionLost(time) {
    this.book = null;
    this.last = {};
    this.current = null;
    this.flow = [];
    this.context = null;
    this.cancelPending(time, 'Flux interrompu');
  }
  cancelPending(time, reason) {
    for (const wallet of [this.active, ...this.shadows]) {
      if (!wallet.pending) continue;
      this.log('reject', {wallet:wallet.id, time, reason, side:wallet.pending.side});
      wallet.pending = null;
    }
  }
  fresh(time) {
    return this.book && [this.last.book, this.last.candle].every(t => t !== undefined && time - t <= this.p.staleMs);
  }
  handle(event, time) {
    if (!event) return;
    this.now = time;
    const {kind} = event;
    if (kind === 'trade') {
      if (this.last.tradeId >= event.id) return;
      this.last.tradeId = event.id;
      this.count.trade++;
      this.tape.unshift(event);
      this.tape.length = Math.min(this.tape.length, 35);
      this.flow.push(event);
      if (this.flow.length > 100_000) this.flow.splice(0, 50_000);
      return;
    }
    if (kind === 'book') {
      if (this.book?.id >= event.id || event.bids[0][0] >= event.asks[0][0]) return;
      this.book = event;
      this.last.book = time;
      this.count.book++;
      if (!this.fresh(time)) return this.cancelPending(time, 'Bougies indisponibles');
      if (this.context || this.active.position || this.active.pending || this.shadows.some(wallet => wallet.position || wallet.pending)) {
        for (const wallet of [this.active, ...this.shadows]) {
          const fill = wallet.execute(event, time);
          if (fill) {
            const record = {...fill, wallet:wallet.id, strategy:wallet === this.active ? this.strategy : wallet.id, time};
            this.log(fill.type, record);
            if (wallet === this.active && fill.type === 'fill') {
              this.fills.unshift(record);
              this.fills.length = Math.min(this.fills.length, 80);
            }
          }
          wallet.mark(event);
          this.exit(wallet, time);
        }
        this.promote(time);
      }
      return;
    }
    if (!event.closed) {
      this.current = event;
      return;
    }
    const previous = this.candles.at(-1);
    if (previous && event.t <= previous.t) return;
    const gap = previous && event.t - previous.t !== 1_000;
    if (gap) {
      this.count.gaps += (event.t - previous.t) / 1_000 - 1;
      this.context = null;
      this.cancelPending(time, 'Discontinuité dans les bougies');
    }
    this.candles.push(event);
    if (this.candles.length > 600) this.candles.shift();
    this.current = null;
    this.count.candle++;
    this.last.candleReceived = time;
    this.last.candle = Math.min(time, event.exchange ?? time);
    this.flow = this.flow.filter(trade => trade.t >= event.t - 4_000);
    const available = this.candles.length >= 99 && event.t - this.candles.at(-99).t === 98_000;
    const price = event.c;
    const totals = this.flow.reduce((totals, trade) => {
      if (trade.t >= event.t + 1000) return totals;
      totals.volume += trade.size;
      totals.signed += trade.size * (trade.sell ? -1 : 1);
      return totals;
    }, {volume:0, signed:0});
    this.context = available ? {imbalance:totals.volume ? totals.signed / totals.volume : 0,
      averages:Object.fromEntries([7,15,25,45,99].map(n => [n,mean(this.candles.slice(-n).map(c => c.c))])),
      price} : null;
    this.rotate(event.t, time, gap);
    if (this.fresh(time)) {
      this.exit(this.active, time);
      if (this.context) {
        this.covered++;
        for (const wallet of this.shadows) this.signal(wallet, wallet.id, time);
        if (!this.paused && !this.waiting) this.signal(this.active, this.strategy, time);
      }
    }
    this.equity.push({t:event.t, value:this.active.equity(this.fresh(time) ? this.book : null)});
    if (this.equity.length > 900) this.equity.shift();
  }
  exit(wallet, time) {
    if (!wallet.position || wallet.pending) return;
    const bid = this.book.bids[0][0], ask = this.book.asks[0][0];
    const move = bps(bid, wallet.position.price);
    let reason = null;
    if (move <= -this.p.stopBps) reason = 'Stop';
    else if (move >= this.p.targetBps) reason = 'Objectif';
    else if (time - wallet.position.time >= this.p.maxHoldMs) reason = 'Durée maximale';
    if (reason) this.intent(wallet, 'SELL', time, reason, (bid + ask) / 2);
  }
  signal(wallet, id, time) {
    const strategy = strategies.find(s => s.id === id);
    if (!strategy || wallet.pending) return;
    const {averages, imbalance, price} = this.context;
    const bid = this.book.bids[0][0], ask = this.book.asks[0][0];
    const mid = (bid + ask) / 2;
    const trend = bps(averages[strategy.fast], averages[strategy.slow]);
    if (wallet.position) {
      if (trend <= 0) this.intent(wallet, 'SELL', time, 'Inversion des moyennes', mid);
    } else if (time >= wallet.cooldown && wallet.cash >= this.p.stake &&
      trend >= strategy.edge && price >= averages[strategy.fast] && imbalance >= 0.1 &&
      bps(ask,bid) <= this.p.maxSpreadBps) {
      this.intent(wallet, 'BUY', time, 'Tendance et flux acheteur', mid);
    }
  }
  intent(wallet, side, time, reason, mid) {
    if (wallet.intent(side, time, reason, mid)) {
      this.log('signal', {wallet:wallet.id, strategy:wallet === this.active ? this.strategy : wallet.id,
        time, side, reason, mid, context:this.context});
    }
  }
  rotate(candleTime, time, gap) {
    if (this.window === null && this.context && this.fresh(time)) this.window = candleTime;
    if (this.window === null || candleTime - this.window < this.p.windowMs) return;
    const coverage = Math.min(1, this.covered / (this.p.windowMs / 1000));
    const mark = this.fresh(time) && !gap ? this.book : null;
    const results = this.shadows.map(s => s.summary(mark));
    const best = results.filter(r => r.score !== null && r.score >= this.p.minEdgeBps &&
      r.trades >= this.p.minTrades).sort((a,b) => b.score - a.score)[0];
    const nomination = this.nomination;
    const result = evaluate(results, nomination, this.strategy, coverage, this.p);
    this.nomination = coverage >= this.p.minCoverage ? best?.id ?? null : null;
    const incumbent = results.find(row => row.id === this.strategy);
    if (result.pass && nomination !== this.strategy) this.waiting = nomination;
    else if (coverage >= this.p.minCoverage && incumbent?.score < 0 && incumbent.trades >= this.p.minTrades) {
      this.waiting = 'Cash';
      result.reason += ' · retour au cash demandé';
    } else this.waiting = null;
    this.reflect({time, ...result, tested:nomination, next:this.nomination, coverage, results,
      incumbent:this.strategy, start:this.window, end:candleTime});
    this.resetShadows();
    this.window = candleTime;
    this.promote(time);
  }
  promote(time) {
    if (!this.waiting || this.active.position || this.active.pending) return;
    const selection = this.waiting;
    this.strategy = selection === 'Cash' ? null : selection;
    this.waiting = null;
    this.reflect({time, reason:selection === 'Cash' ? 'Retour au cash à plat' : 'Stratégie activée à plat',
      promoted:selection, pass:true});
  }
  reflect(report) {
    this.audit.unshift(report);
    if (this.audit.length > 30) this.audit.pop();
    this.log('review', report);
  }
  pause(paused, time) {
    this.paused = paused;
    if (paused && this.active.pending?.side === 'BUY') {
      this.log('reject', {wallet:'Actif', time, side:'BUY', reason:'Entrées suspendues'});
      this.active.pending = null;
    }
    this.log('control', {time, paused});
  }
}
