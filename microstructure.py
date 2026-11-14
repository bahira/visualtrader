"""Walk-forward microstructure research on VisualTrader BTCUSDT recordings."""
import argparse
from collections import deque
from dataclasses import dataclass
import json
import math
from pathlib import Path
import sqlite3
import time

import numpy as np

STAKE = 250
HORIZONS = (500, 1000, 3000, 6000, 15000)
MAX_GAP = 450
BASE = (250, 10, 1)
STRESS = (500, 10, 2)
FEATURES = ('queue1', 'queue5', 'queue20', 'ofi500', 'tradeFlow500',
            'tradeFlow2000', 'micropriceBps', 'spreadBps', 'momentum500', 'momentum2000')


@dataclass
class Tape:
    time: np.ndarray
    features: np.ndarray
    mid: np.ndarray
    buy: np.ndarray
    sell: np.ndarray
    span: np.ndarray
    best_bid: np.ndarray
    sells: np.ndarray
    trades: np.ndarray | None = None
    best_ask: np.ndarray | None = None
    touch_size: np.ndarray | None = None


def walk(levels, amount):
    filled = value = 0.
    for price, size in levels:
        size = min(size, amount - filled)
        value += price * size
        filled += size
        if filled >= amount - 1e-12:
            return value / amount
    return math.nan


def imbalance(bid, ask):
    return (bid - ask) / (bid + ask) if bid + ask else 0.


def ofi(old, new):
    bp,bq,ap,aq = old
    nb,nq,na,ns = new
    return ((nq if nb >= bp else 0) - (bq if nb <= bp else 0) -
            (ns if na <= ap else 0) + (aq if na >= ap else 0))


class Window:
    def __init__(self, duration):
        self.duration = duration
        self.events = deque()
        self.net = self.total = 0.

    def push(self, timestamp, signed, total):
        self.events.append((timestamp, signed, total))
        self.net += signed
        self.total += total

    def ratio(self, now):
        while self.events and self.events[0][0] <= now - self.duration:
            _, signed, total = self.events.popleft()
            self.net -= signed
            self.total -= total
        return self.net / self.total if self.events and self.total > 0 else 0.


def load(db, session, last_seq, first_seq=0):
    def windows():
        return Window(500), Window(2000), Window(500)

    short, long, book_flow = windows()
    previous = previous_id = last_time = None
    start = span = 0
    quotes = deque()
    small = deque()
    rows = []
    sells = []
    trades = []
    now = 0
    for event_time, message in db.execute(
            'SELECT recv,json FROM market WHERE session=? AND seq>? AND seq<=? ORDER BY seq', (session,first_seq,last_seq)):
        now = max(now,event_time)
        msg = json.loads(message)
        stream, raw = msg['stream'], msg['data']
        if stream == 'btcusdt@researchGap':
            last_time = previous_id = None
            continue
        if stream == 'btcusdt@trade':
            size = float(raw['q'])
            value = -size if raw['m'] else size
            trades.append((now,float(raw['p']),size,int(raw['m'])))
            if raw['m']:
                sells.append((now,float(raw['p'])))
            short.push(now,value,size)
            long.push(now,value,size)
            continue
        if stream != 'btcusdt@depth20@100ms':
            continue
        if previous_id is not None and raw['lastUpdateId'] <= previous_id:
            continue
        bids, asks = ([[float(v) for v in level] for level in raw[field]] for field in ('bids','asks'))
        if not bids or not asks:
            continue
        bp,bq = bids[0]
        ap,aq = asks[0]
        if bp <= 0 or bp >= ap:
            continue
        if last_time is None or now - last_time > MAX_GAP:
            start, span = now, span + 1
            short, long, book_flow = windows()
            previous = None
            small.clear()
            quotes.clear()
        previous_id = raw['lastUpdateId']
        last_time = now
        current = bp,bq,ap,aq
        if previous:
            delta = ofi(previous,current)
            book_flow.push(now,delta,abs(delta))
        previous = current
        mid = (bp + ap)/2
        for q, duration in ((small,500),(quotes,2000)):
            while len(q) > 1 and q[1][0] <= now - duration:
                q.popleft()
        mom500 = (mid / small[0][1] - 1)*10000 if small else 0
        mom2000 = (mid / quotes[0][1] - 1)*10000 if quotes else 0
        small.append((now,mid))
        quotes.append((now,mid))
        spread = (ap-bp)/mid*10000
        ratios = [imbalance(sum(x[1] for x in bids[:i]),sum(x[1] for x in asks[:i])) for i in (1,5,20)]
        features = (*ratios, book_flow.ratio(now), short.ratio(now), long.ratio(now),
                    ratios[0]*spread/2, spread, mom500, mom2000)
        amount = STAKE/mid
        rows.append((now,features,mid,walk(asks,amount),walk(bids,amount),span,now-start,bp,ap,(bq,aq)))
    if not rows:
        raise ValueError(f'Session {session} sans carnet valide')
    ts, features, mids, asks, bids, spans, age, best_bid, best_ask, touch_size = zip(*rows)
    x = np.array(features)
    x[np.array(age) < 2_000] = np.nan
    return Tape(np.array(ts),x,np.array(mids),np.array(asks),np.array(bids),np.array(spans),np.array(best_bid),np.array(sells).reshape(-1,2),
                np.array(trades).reshape(-1,4),np.array(best_ask),np.array(touch_size))


def opportunities(tape, hold, costs):
    latency, fee, slip = costs
    t = tape.time
    i = np.arange(len(t))
    entry = np.searchsorted(t, t + max(1,latency))
    valid_entry = entry < len(t)
    entry = entry.clip(max=len(t)-1)
    exit_ = np.searchsorted(t, t[entry] + hold + latency)
    valid_exit = exit_ < len(t)
    exit_ = exit_.clip(max=len(t)-1)
    valid = (valid_entry & valid_exit & (tape.span[i] == tape.span[exit_]) &
             (t[entry] <= t+latency+MAX_GAP) & (t[exit_] <= t[entry]+hold+latency+MAX_GAP) &
             np.isfinite(tape.features).all(axis=1))
    buy = tape.buy[entry] * (1+slip/10000) * (1+fee/10000)
    sell = tape.sell[exit_] * (1-slip/10000) * (1-fee/10000)
    net = np.where(valid, (sell/buy-1)*10000, np.nan)
    frictionless = np.where(valid, (tape.mid[exit_]/tape.mid[entry]-1)*10000, np.nan)
    return net, frictionless, exit_


@dataclass
class Candidate:
    name: str
    hold: int
    threshold: float
    score: object


def model(train, hold):
    xx, yy = [], []
    for tape in train:
        _, target, _ = opportunities(tape,hold,BASE)
        ok = np.isfinite(target)
        xx.append(tape.features[ok])
        yy.append(target[ok])
    x, y = np.concatenate(xx), np.concatenate(yy)
    mean, std = x.mean(axis=0), np.maximum(x.std(axis=0),1e-6)
    design = np.clip((x-mean)/std,-8,8)
    intercept = float(y.mean())
    weights = np.linalg.solve(design.T @ design + np.eye(len(FEATURES))*len(y)*.01,
                              design.T @ (y-intercept))
    return lambda t: np.clip((t.features-mean)/std,-8,8) @ weights + intercept


def evaluate(candidate,tape,costs,prepared=None):
    predicted, net, gross, exits = (prepared if prepared is not None else
        (candidate.score(tape), *opportunities(tape,candidate.hold,costs)))
    picks = np.flatnonzero(np.isfinite(predicted) & (predicted >= candidate.threshold) &
                           (tape.time + candidate.hold + 2*costs[0] + 2*MAX_GAP < tape.time[-1]))
    samples = []
    censored = 0
    next_decision = -1
    for i in picks:
        if tape.time[i] <= next_decision:
            continue
        j = exits[i]
        next_decision = tape.time[j]
        if np.isfinite(net[i]):
            samples.append((net[i],gross[i]))
        else:
            censored += 1
    estimated = np.array(samples).reshape(-1,2)
    cumulative = np.concatenate(([0],np.cumsum(estimated[:,0]*STAKE/10000)))
    duration = (tape.time[-1]-tape.time[0])/60000
    return {'cycles':len(samples), 'censoredPaths':censored, 'cyclesPerMin':len(samples)/duration,
            'netUsdt':float(cumulative[-1]), 'maxDrawdownUsdt':float(max(np.maximum.accumulate(cumulative)-cumulative)),
            'positiveCycles':int((estimated[:,0]>0).sum()),
            'meanGrossBps':float(estimated[:,1].mean()) if len(samples) else None,
            'meanNetBps':float(estimated[:,0].mean()) if len(samples) else None}


def passive(tape, signal, horizon=3000, latency=250, maker_fee=10, taker_fee=10, slip=1):
    """Post at the observed bid. Require a later aggressive sell below our limit."""
    t = tape.time
    trade_times, trade_prices = tape.sells.T
    cash = running_peak = drawdown = 0.
    filled = posted = wins = invalid_exit = 0
    blocked = -1
    for i in np.flatnonzero(signal & np.isfinite(tape.features).all(axis=1)):
        if t[i] <= blocked:
            continue
        eta = t[i] + latency
        if eta + 1000 + horizon + latency + MAX_GAP >= t[-1]:
            break
        j = np.searchsorted(t,eta)
        if tape.span[i] != tape.span[j]:
            blocked = t[j]
            continue
        limit = tape.best_bid[i]
        # If the bid already moved through the requested limit, reject the post.
        if tape.best_bid[j] < limit:
            continue
        posted += 1
        deadline = t[j] + 1000
        lo, hi = np.searchsorted(trade_times,[t[j]+1,deadline],side='left')
        indices = np.flatnonzero(trade_prices[lo:hi] < limit)
        blocked = deadline
        if not len(indices):
            continue
        fill_time = trade_times[lo + indices[0]]
        exit_ = np.searchsorted(t, fill_time + horizon + latency)
        if exit_ == len(t) or tape.span[j] != tape.span[exit_] or not np.isfinite(tape.sell[exit_]):
            invalid_exit += 1
            blocked = t[min(exit_,len(t)-1)]
            continue
        filled += 1
        blocked = t[exit_]
        net = STAKE * (tape.sell[exit_] * (1-slip/10000) * (1-taker_fee/10000) /
                       (limit * (1+maker_fee/10000)) - 1)
        cash += net
        wins += int(net > 0)
        running_peak = max(cash,running_peak)
        drawdown = max(drawdown,running_peak-cash)
    return {'posted':posted,'cycles':filled,'wins':wins,'unpricedExits':invalid_exit,
            'netUsdt':cash,'maxDrawdownUsdt':drawdown}

def replay(db, train_ids, validation_id, test_ids, frozen=None):
    sessions = [*train_ids,validation_id,*test_ids]
    # Freeze all session bounds before reading features or fitting.
    bounds = {i:db.execute('SELECT MAX(seq) FROM market WHERE session=?',(i,)).fetchone()[0] for i in sessions}
    if frozen is not None:
        bounds = {i:min(bounds[i],frozen[i]) if bounds[i] else None for i in sessions}
    if not all(bounds.values()):
        raise ValueError('Une session demandÃƒÂ©e est absente')
    tapes = {i:load(db,i,bounds[i]) for i in sessions}
    train = [tapes[i] for i in train_ids]
    candidates = []
    for hold in HORIZONS:
        reg = model(train,hold)
        candidates.extend(Candidate('Ridge',hold,v,reg) for v in (.25,.5,1,2,4,8,15,22))
        for name,feature in (('Queue 1',0),('Queue 5',1),('Snapshot OFI',3),('Flux exÃƒÂ©cutÃƒÂ©',5)):
            candidates.extend(Candidate(name,hold,v,lambda tape, f=feature:tape.features[:,f])
                              for v in (.25,.5,.75,.9))
    validation = tapes[validation_id]
    outcomes = {hold:opportunities(validation,hold,BASE) for hold in HORIZONS}
    scores = {}
    def research_score(candidate):
        key = candidate.name,candidate.hold
        if key not in scores:
            # Threshold variants share both the model output and the fill vectors.
            scores[key] = candidate.score(validation)
        row = evaluate(candidate,validation,BASE,(scores[key],*outcomes[candidate.hold]))
        if row['cycles'] < 15:
            return -9e30
        return row['netUsdt'] - .25 * row['maxDrawdownUsdt'] - row['censoredPaths'] * STAKE * .0022
    chosen = max(candidates,key=research_score)
    selection = evaluate(chosen,validation,BASE)
    qualified = selection['cycles'] >= 15 and selection['censoredPaths'] == 0 and selection['netUsdt'] > 0 and evaluate(chosen,validation,STRESS)['netUsdt'] > 0
    baseline = Candidate('RÃƒÂ©gulier',3000,0,lambda tape:np.zeros(len(tape.time)))
    results = {}
    for session in test_ids:
        tape = tapes[session]
        results[str(session)] = {'candidate':evaluate(chosen,tape,BASE),
            'candidateStress':evaluate(chosen,tape,STRESS),'regular':evaluate(baseline,tape,BASE),
            'cash':{'netUsdt':0,'cycles':0},
            'opportunityCensus':{},
            'passiveRegular':passive(tape,np.ones(len(tape.time),dtype=bool)),
            'passiveQueue':passive(tape,tape.features[:,0]>=.75),
            'passiveDiscount':passive(tape,np.ones(len(tape.time),dtype=bool),maker_fee=0,taker_fee=2),
            'feeSensitivity':{str(bps):evaluate(chosen,tape,(250,bps,1)) for bps in (0,2,5,10)}}
        for hold in HORIZONS:
            net, mid, _ = opportunities(tape,hold,BASE)
            valid = np.isfinite(net)
            results[str(session)]['opportunityCensus'][str(hold)] = {
                'observations':int(valid.sum()),'positiveAfterCost':int((net[valid]>0).sum()),
                'medianMidBps':float(np.median(mid[valid])) if valid.any() else None,
                'p99MidBps':float(np.quantile(mid[valid],.99)) if valid.any() else None}
    return {'bounds':bounds, 'train':train_ids,'validation':validation_id,'tests':test_ids,
            'marketMinutes': {i: (tapes[i].time[-1]-tapes[i].time[0])/60000 for i in sessions},
            'snapshots':{i:len(tapes[i].time) for i in sessions}, 'features':FEATURES,
            'stake':STAKE,'base':BASE,'stress':STRESS,'gridSize':len(candidates),
            'candidate':{'name':chosen.name,'holdMs':chosen.hold,'threshold':chosen.threshold},
            'validationResult':selection,'qualified':qualified,'results':results,
            'promote':qualified and all(r['candidate']['netUsdt'] > 0 and
                r['candidateStress']['netUsdt'] > 0 and r['candidate']['cyclesPerMin'] >= 10 and
                r['candidate']['censoredPaths'] == 0 for r in results.values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',type=Path,default=Path('data/live.sqlite'))
    parser.add_argument('--out',type=Path,default=Path('data/microstructure.json'))
    parser.add_argument('--freeze',type=Path,help='Read exact session boundaries from an earlier JSON report')
    args = parser.parse_args()
    frozen = None if args.freeze is None else {int(k):v for k,v in
        json.loads(args.freeze.read_text(encoding='utf8'))['bounds'].items()}
    started = time.perf_counter()
    db = sqlite3.connect(args.db.resolve().as_uri()+'?mode=ro',uri=True)
    try:
        report = replay(db,[1,2],3,[4,5],frozen)
    finally:
        db.close()
    report['runtimeSeconds'] = time.perf_counter()-started
    args.out.parent.mkdir(parents=True,exist_ok=True)
    temporary = args.out.with_suffix('.tmp')
    temporary.write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf8')
    temporary.replace(args.out)
    print(json.dumps(report,indent=2,allow_nan=False))


if __name__ == '__main__':
    main()
