export function reconcile(last, first, final) {
  if (final <= last) return 'old';
  return first > last + 1 ? 'gap' : 'apply';
}

export class LocalBook {
  constructor(snapshot) {
    this.id = snapshot.lastUpdateId;
    this.bids = new Map();
    this.asks = new Map();
    this.updateLevels(this.bids,snapshot.bids);
    this.updateLevels(this.asks,snapshot.asks);
  }

  updateLevels(side, levels) {
    for (const [price,quantity] of levels) {
      const p = Number(price), q = Number(quantity);
      if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(q) || q < 0) {
        throw new Error('Niveau de carnet invalide');
      }
      if (q === 0) side.delete(p);
      else side.set(p,q);
    }
  }

  apply(event) {
    if (this.id === null) return 'gap';
    const status = reconcile(this.id,event.U,event.u);
    if (status === 'gap') this.id = null;
    if (status !== 'apply') return status;
    this.updateLevels(this.bids,event.b);
    this.updateLevels(this.asks,event.a);
    this.id = event.u;
    return status;
  }

  depth(limit) {
    if (this.id === null) return null;
    const bids = [...this.bids].sort((a,b) => b[0]-a[0]).slice(0,limit);
    const asks = [...this.asks].sort((a,b) => a[0]-b[0]).slice(0,limit);
    if (!bids.length || !asks.length || bids[0][0] >= asks[0][0]) return null;
    return {lastUpdateId:this.id,bids,asks};
  }

  best() {
    if (this.id === null) return null;
    let bid = 0, ask = Infinity;
    for (const price of this.bids.keys()) if (price > bid) bid = price;
    for (const price of this.asks.keys()) if (price < ask) ask = price;
    if (!bid || !Number.isFinite(ask) || bid >= ask) return null;
    return {id:this.id,bid,ask,bidQty:this.bids.get(bid),askQty:this.asks.get(ask)};
  }
}
