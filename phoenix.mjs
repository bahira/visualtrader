import {FastPaper} from './fast-paper.mjs';

const weights = Array.from({length:19}, (_, i) => 1 / Math.cosh((i - 9.5) / 2));
const normalization = weights.reduce((sum,w) => sum + w,0);

export function errfKernel(closes) {
  if (closes.length < weights.length) return null;
  return weights.reduce((sum,w,i) => sum + w * closes[closes.length-1-i],0) / normalization;
}

export function inflection(previous, middle, current) {
  if (current > middle && middle <= previous) return 'long';
  if (current < middle && middle >= previous) return 'short';
  return null;
}

export class PhoenixSpot {
  constructor(config,saved,log) {
    this.fast = new FastPaper(config,saved?.fast,log,undefined,'Phoenix 1 s');
    this.closes = [];
    this.kernels = [];
    this.previous = null;
    this.bias = null;
    this.signals = {long:0,short:0};
  }
  checkpoint() {
    return {fast:this.fast.checkpoint()};
  }
  reset() {
    this.closes = [];
    this.kernels = [];
    this.previous = null;
    this.bias = null;
  }
  candle(event) {
    if (!event.closed || (this.previous !== null && event.t <= this.previous)) return;
    if (this.previous !== null && event.t - this.previous !== 1000) this.reset();
    this.previous = event.t;
    this.closes.push(event.c);
    if (this.closes.length > 25) this.closes.shift();
    const kernel = errfKernel(this.closes);
    if (kernel === null) return;
    this.kernels.push(kernel);
    if (this.kernels.length > 3) this.kernels.shift();
    if (this.closes.length < 25 || this.kernels.length < 3) return;
    const signal = inflection(...this.kernels);
    if (signal) {
      this.bias = signal;
      this.signals[signal]++;
    }
  }
  tick(book,time,paused) {
    const warmingOrStale = this.previous === null || time - this.previous > 3_500;
    this.fast.tick(book,time,paused || warmingOrStale || this.bias !== 'long');
  }
  summary(book,now) {
    return {...this.fast.summary(book,now), bias:this.bias, signals:this.signals, warmup:this.closes.length};
  }
}
