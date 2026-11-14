import {host, streams} from './engine.mjs';

export function connect(onMessage, status) {
  let socket, retry, watchdog, stopped = false, attempts = 0;
  function dial() {
    status('connecting', 'Connexion à Binance');
    socket = new WebSocket(host + '/stream?streams=' + streams);
    let last = Date.now();
    const arm = () => {
      watchdog = setInterval(() => {
        if (Date.now() - last > 10_000) socket.close();
      }, 1_000);
    };
    arm();
    socket.onopen = () => status('waiting', 'WebSocket ouvert, attente du marché');
    socket.onmessage = event => {
      last = Date.now();
      attempts = 0;
      onMessage(event.data, last);
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      clearInterval(watchdog);
      if (stopped) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts++, 5));
      status('offline', 'Flux interrompu · reconnexion dans ' + delay / 1000 + ' s');
      retry = setTimeout(dial, delay);
    };
  }
  dial();
  return () => {
    stopped = true;
    clearInterval(watchdog);
    clearTimeout(retry);
    socket.close();
  };
}

export async function history(interval, limit) {
  const url = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=' + interval + '&limit=' + limit;
  const response = await fetch(url, {signal:AbortSignal.timeout(8_000)});
  if (!response.ok) throw new Error('Historique Binance HTTP ' + response.status);
  const end = Date.now();
  return (await response.json()).filter(k => k[6] < end)
    .map(k => ({t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5], closed:true}));
}

export function* synthetic(start, seconds) {
  // Deterministic uptrends and pullbacks for exercising the order and review lifecycle.
  let previous = 65_000, id = 0;
  for (let i = 0; i < seconds; i++) {
    const t = start + i * 1_000;
    const cycle = i % 120;
    const price = 65_000 + (cycle <= 88 ? cycle * 8 : (120 - cycle) * 22) + Math.sin(i * 0.21) * 5;
    const book = (value, time) => [time, {
      stream:'btcusdt@depth20@100ms', data:{lastUpdateId:++id,
        bids:Array.from({length:20}, (_, level) => [(value - 0.05 - level * 0.1).toFixed(2), '0.08']),
        asks:Array.from({length:20}, (_, level) => [(value + 0.05 + level * 0.1).toFixed(2), '0.08'])}}];
    yield book(price, t + 300);
    yield [t + 500, {stream:'btcusdt@trade', data:{T:t + 480, E:t + 490, t:i + 1, p:price, q:0.015, m:price < previous}}];
    yield [t + 1_000, {stream:'btcusdt@kline_1s', data:{E:t + 999, k:{t, i:'1s', o:previous, c:price,
      h:Math.max(previous, price) + 1, l:Math.min(previous, price) - 1, v:0.015, n:1, x:true}}}];
    yield book(price, t + 1_000);
    previous = price;
  }
}
