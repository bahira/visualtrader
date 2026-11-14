import {createWriteStream, mkdirSync} from 'node:fs';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {host} from './engine.mjs';

export function reconcile(last, first, final) {
  if (final <= last) return 'old';
  return first > last + 1 ? 'gap' : 'apply';
}

async function record(seconds, output) {
  const socket = new WebSocket(host + '/stream?streams=btcusdt@depth@100ms/btcusdt@trade/btcusdt@bookTicker');
  const writer = createWriteStream(output,{flags:'wx'});
  let error;
  const report = {depth:0, trade:0, bookTicker:0, sequenceGaps:0, last:null, queueOverruns:0};
  const started = Date.now();
  let done;
  const end = new Promise(resolve => { done = resolve; });
  const timer = setTimeout(done,seconds*1000);
  try {
    await once(writer,'open');
    writer.on('error',err => { error = err; done(); });
    socket.onerror = () => { error = new Error('Connexion Binance interrompue'); done(); };
    socket.onclose = () => {
      if (Date.now() - started < seconds * 1000) {
        error ??= new Error('Capture interrompue avant échéance');
      }
      done();
    };
    socket.onmessage = ({data}) => {
      const {stream,data:payload} = JSON.parse(data);
      if (stream === 'btcusdt@depth@100ms') {
        report.depth++;
        if (report.last !== null && reconcile(report.last,payload.U,payload.u) === 'gap') {
          report.sequenceGaps++;
        }
        report.last = Math.max(report.last ?? 0,payload.u);
      } else if (stream === 'btcusdt@trade') report.trade++;
      else if (stream === 'btcusdt@bookTicker') report.bookTicker++;
      writer.write(JSON.stringify({recv:Date.now(),stream,data:payload})+'\n');
      if (writer.writableLength > 8*1024*1024) {
        report.queueOverruns++;
        error = new Error('Le disque ne suit pas le débit de capture');
        done();
      }
    };
    await end;
  } finally {
    clearTimeout(timer);
    socket.onmessage = null;
    socket.close();
    const finished = once(writer,'finish');
    writer.end();
    await finished;
  }
  if (error) throw error;
  if (!report.depth || !report.trade || !report.bookTicker) throw new Error('Flux incomplet');
  return {...report,durationSeconds:(Date.now()-started)/1000,output};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {values:{seconds}} = parseArgs({options:{seconds:{type:'string',default:'20'}}});
  const duration = Number(seconds);
  if (!Number.isInteger(duration) || duration < 5 || duration > 3600) throw new Error('--seconds : 5 à 3600');
  mkdirSync('data/depth',{recursive:true});
  const destination = resolve('data/depth',Date.now()+'.ndjson');
  const result = await record(duration,destination);
  // The capture is already flushed. Do not wait for the peer's close handshake.
  process.stdout.write(JSON.stringify(result,null,2)+'\n', () => process.exit(0));
}
