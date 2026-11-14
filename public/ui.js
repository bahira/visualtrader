const el = id => document.getElementById(id);
const num = (value, digits = 2) => value == null ? '—' :
  new Intl.NumberFormat('fr-FR',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value);
const clock = time => time == null ? '—' : new Date(time).toLocaleTimeString('fr-FR',{timeZone:'Europe/Paris'});
const write = (id,text) => { el(id).textContent = text; };
const sign = (id,value) => { el(id).className = value == null || value === 0 ? '' : value > 0 ? 'green' : 'red'; };
function rows(id, data, width, message) {
  const body = el(id);
  body.replaceChildren(...data.map(({values, color}) => {
    const row = document.createElement('tr');
    if (color) row.className = color;
    for (const value of values) row.insertCell().textContent = value;
    return row;
  }));
  if (!data.length) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = width;
    cell.className = 'empty';
    cell.textContent = message;
  }
}
const canvas = el('chart');
const ctx = canvas.getContext('2d');
const palette = {line:'#2b3533',muted:'#a0aeaa',green:'#73e8bd',red:'#ff9b98',gold:'#e9ce78',blue:'#83aac8'};
let snapshot, view = '1s', inspected = null, refreshing = false;
function timeline(s) {
  const minutes = new Map(s.minuteHistory.map(c => [c.t,c]));
  for (const c of [...s.chart, ...(s.current ? [s.current] : [])]) {
    const t = Math.floor(c.t / 60_000) * 60_000;
    if (s.minuteHistory.length && t <= s.minuteHistory.at(-1).t) continue;
    const prior = minutes.get(t);
    minutes.set(t,{t,c:c.c,v:(prior?.v ?? 0) + c.v});
  }
  return [...minutes.values()];
}
function renderChart() {
  if (!snapshot) return;
  const s = snapshot;
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
    canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
  }
  ctx.setTransform(ratio,0,0,ratio,0,0);
  ctx.clearRect(0,0,w,h);
  const candles = view === '1s';
  const data = candles ? [...s.chart.slice(-160),...(s.current ? [s.current] : [])] :
    view === 'time' ? timeline(s) : s.equity.map(v => ({...v,c:v.value}));
  write('chart-source',candles ? 'OHLCV · 1 s' : view === 'time' ? s.historyState + ' · Europe/Paris' : 'USDT · après coûts');
  const usable = data.filter(point => point.c != null);
  ctx.font = '11px "IBM Plex Mono", monospace';
  if (!usable.length) {
    ctx.fillStyle = palette.muted;
    ctx.textAlign = 'center';
    ctx.fillText('En attente des données',w / 2,h / 2);
    write('chart-info','—');
    return;
  }
  const left = 13, right = w - 79, top = 14, bottom = h - 29;
  const priceBottom = view === 'equity' ? bottom : bottom - 44;
  const high = Math.max(...usable.map(c => candles ? c.h : c.c));
  const low = Math.min(...usable.map(c => candles ? c.l : c.c));
  const margin = Math.max((high - low) * .075, view === 'equity' ? 0.05 : .1);
  const x = t => left + 3 + (right - left - 6) * (t - data[0].t) / Math.max(1, data.at(-1).t - data[0].t);
  const y = v => top + (priceBottom - top) * (high + margin - v) / (high - low + margin * 2);
  const spacing = (right - left) / Math.max(data.length,2);
  for (let i = 0; i <= 5; i++) {
    const yy = top + (priceBottom - top) * i / 5;
    line(left,yy,right,yy,palette.line);
    ctx.fillStyle = palette.muted; ctx.textAlign = 'left';
    ctx.fillText(num(high + margin - i * (high - low + margin * 2) / 5),right + 6,yy + 4);
  }
  const ticks = w < 480 ? 3 : 6;
  for (let i = 0; i < ticks; i++) {
    const index = Math.round(i * (data.length - 1)/(ticks - 1));
    const xx = x(data[index].t);
    line(xx,top,xx,bottom,palette.line);
    ctx.fillStyle = palette.muted; ctx.textAlign = i === 0 ? 'left' : 'center';
    ctx.fillText(clock(data[index].t),xx,bottom+18);
  }
  if (view !== 'equity') {
    const maxVolume = Math.max(0.001,...usable.map(c => c.v));
    for (const c of usable) {
      const xx = x(c.t);
      const color = candles && c.c < c.o ? palette.red : palette.green;
      if (candles) {
        line(xx,y(c.h),xx,y(c.l),color);
        ctx.fillStyle = color;
        ctx.fillRect(xx - spacing * .29,Math.min(y(c.o),y(c.c)),Math.max(1,spacing * .58),Math.max(1,Math.abs(y(c.o)-y(c.c))));
      }
      ctx.fillStyle = color; ctx.globalAlpha = .38;
      const height = c.v / maxVolume * 36;
      ctx.fillRect(xx - spacing * .29,bottom-height,Math.max(1,spacing*.58),height);
      ctx.globalAlpha = 1;
    }
  }
  if (!candles) {
    ctx.beginPath();
    let prior = null;
    for (const c of data) {
      if (c.c == null) { prior = null; continue; }
      if (prior && c.t - prior.t <= (view === 'time' ? 60_000 : 1_000)) ctx.lineTo(x(c.t),y(c.c));
      else ctx.moveTo(x(c.t),y(c.c));
      prior = c;
    }
    ctx.strokeStyle = palette.green; ctx.lineWidth = 1.65; ctx.stroke(); ctx.lineWidth = 1;
  }
  if (candles) {
    const all = s.chart;
    for (const [n,color] of [[7,palette.gold],[25,'#ca96ce'],[99,palette.blue]]) {
      let last = null;
      for (const c of usable) {
        const i = all.findIndex(a => a.t === c.t);
        if (i < n - 1 || c.t - all[i - n + 1].t !== (n - 1)*1_000) { last = null; continue; }
        const v = all.slice(i-n+1,i+1).reduce((sum,a) => sum+a.c,0)/n;
        if (last) line(last.xx,last.yy,x(c.t),y(v),color);
        last = {xx:x(c.t),yy:y(v)};
      }
    }
  }
  const point = inspected == null ? usable.at(-1) : usable.reduce((best,c) => Math.abs(x(c.t)-inspected) <
    Math.abs(x(best.t)-inspected) ? c : best);
  if (inspected != null) {
    line(x(point.t),top,x(point.t),bottom,palette.muted);
    ctx.fillStyle = palette.gold;
    ctx.beginPath(); ctx.arc(x(point.t),y(point.c),3,0,Math.PI*2); ctx.fill();
  }
  write('chart-info',clock(point.t) + (candles ? '  O ' + num(point.o) + '  H ' + num(point.h) +
    '  L ' + num(point.l) + '  C ' + num(point.c) + '  Vol ' + num(point.v,4) : '  ' + num(point.c) + ' USDT'));
}
function line(x1,y1,x2,y2,color) {
  ctx.beginPath(); ctx.strokeStyle = color; ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
}
function render(s) {
  snapshot = s;
  const w = s.wallet;
  const live = s.mode === 'live' && s.marketReady;
  write('status',live ? '● BINANCE LIVE' : s.status === 'complete' ? 'LECTURE TERMINÉE' :
    s.mode === 'live' ? '○ EN ATTENTE' : s.mode.toUpperCase());
  el('status').className = live ? 'live' : '';
  write('price',s.price == null ? '—' : num(s.price) + ' USDT');
  for (const [id,value] of Object.entries({equity:w.equity,net:w.net,fees:w.fees,dd:w.drawdown})) write(id,num(value));
  sign('net',w.net);
  write('spread',s.spread == null ? '—' : num(s.spread,3) + ' pb');
  const book = s.book ? [...s.book.asks.slice().reverse().map(row => [row,'Ask','red']),
    ...s.book.bids.map(row => [row,'Bid','green'])] : [];
  rows('book',book.map(([[p,q],side,color]) => ({values:[num(p),num(q,5),side],color})),3,'Carnet en attente');
  write('strategy',s.strategy ?? 'Cash');
  write('candidate',s.waiting ? s.waiting + ' · en attente' : s.nomination ?? '—');
  write('decision',s.review[0]?.reason ?? 'En attente de la première fenêtre');
  write('window',s.window == null ? 'Chauffe · ' + Math.min(99,s.chart.length) + '/99' :
    s.covered + ' / ' + s.config.windowMs / 1000 + ' s couvertes');
  rows('candidates',s.candidates.slice().sort((a,b)=>(b.score ?? -Infinity)-(a.score ?? -Infinity))
    .map(c => ({values:[c.id,num(c.score),num(c.net),c.trades,num(c.drawdown)]})),5,'Aucun candidat');
  el('reviews').replaceChildren(...s.review.slice(0,15).map(r => {
    const p = document.createElement('p');
    p.textContent = clock(r.time) + ' · ' + r.reason + (r.coverage == null ? '' :
      ' · ' + num(r.coverage * 100,1) + ' % de couverture') + (r.tested ? ' · ' + r.tested : '');
    return p;
  }));
  el('runtime-data').replaceChildren(...Object.entries({
    'Session':s.mode + ' #' + s.session,'État du flux':s.detail,'Retard bougie':s.recent.lagMs == null ? '—' : s.recent.lagMs + ' ms',
    'Messages':s.counts.candle + ' clôtures · ' + s.counts.trade + ' trades · ' + s.counts.book + ' carnets',
    'Bougies manquantes':s.counts.gaps,'Position':w.position ? num(w.position.qty,8) + ' BTC' : 'Cash',
    'Coûts simulés':s.config.feeBps + ' pb + ' + s.config.slipBps + ' pb par côté',
    'Réussite':w.trades ? w.wins + ' / ' + w.trades + ' cycles' : '—',
    'P&L brut réalisé':num(w.gross) + ' USDT',
    'Profit factor':w.profitFactor == null && w.profit > 0 ? '∞' : num(w.profitFactor),
    'Net moyen / cycle':num(w.averageNet,4),
    'Meilleur / pire cycle':num(w.best,4) + ' / ' + num(w.worst,4),'Écart vs signal cumulé':num(w.drag) + ' USDT',
  }).map(([label,value]) => {
    const section = document.createElement('div');
    section.textContent = label;
    const b = document.createElement('b'); b.textContent = value; section.append(b); return section;
  }));
  rows('tape',s.tape.map(t => ({color:t.sell ? 'red' : 'green',values:[num(t.price),num(t.size,6),clock(t.t)]})),3,'Aucune transaction reçue');
  rows('fills',s.fills.map(f => ({color:f.side === 'BUY' ? 'green' : 'red',
    values:[clock(f.time),f.side,num(f.price),num(f.qty,8),num(f.fee,4),num(f.drag,4),f.latencyMs + ' ms',num(f.net,4),f.reason]})),
  9,'Aucun fill de la stratégie active');
  el('pause').disabled = false;
  el('pause').textContent = s.paused ? 'Reprendre les entrées' : 'Pause entrées';
  renderChart();
}
async function update() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch('/api/state',{signal:AbortSignal.timeout(3_000)});
    if (!response.ok) throw new Error('Runtime inaccessible');
    render(await response.json());
  } catch {
    write('status','○ HORS LIGNE');
    el('status').className = '';
    el('pause').disabled = true;
  } finally { refreshing = false; }
}
document.querySelectorAll('[data-chart]').forEach(button => button.addEventListener('click',() => {
  view = button.dataset.chart; inspected = null;
  document.querySelectorAll('[data-chart]').forEach(b => b.setAttribute('aria-pressed',String(b === button)));
  renderChart();
}));
canvas.addEventListener('pointermove',event => { inspected = event.offsetX; renderChart(); });
canvas.addEventListener('pointerleave',() => { inspected = null; renderChart(); });
new ResizeObserver(renderChart).observe(canvas);
el('pause').addEventListener('click', async () => {
  el('pause').disabled = true;
  try {
    const response = await fetch(snapshot.paused ? '/api/resume' : '/api/pause',{method:'POST'});
    if (!response.ok) throw new Error('Modification refusée');
    await update();
  } catch {
    write('status','Commande indisponible');
    el('pause').disabled = false;
  }
});
void update();
setInterval(update,500);
