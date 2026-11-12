import { MAX_BEATS } from "@kynimo/scene";

export interface DetectedBeats {
  bpm: number;
  confidence: number;
  timesMs: number[];
}

/** Bounds of the detector (ADR-0052). A tempo outside min/max bpm, or a weak pulse, yields no beats. */
export const BEAT_LIMITS = {
  maxSeconds: 61,
  minBpm: 50,
  maxBpm: 220,
  minConfidence: 0.2,
  minBeats: 4,
} as const;

/** Analysis window and envelope rate: 1024-sample Hann frames, one every 10 ms. */
const WINDOW = 1024;
const ENVELOPE_RATE = 100;
/** Highest frequency that counts towards onset strength. */
const FLUX_MAX_HZ = 8000;
/** Cut-off of the bass band whose onsets are added to the spectral flux. */
const LOW_BAND_HZ = 150;
/** Half width, in envelope frames, of the moving average removed from the envelope. */
const MEAN_RADIUS = 25;
/** Tempo prior: log-Gaussian over octaves around 120 bpm. */
const PRIOR_BPM = 120;
const PRIOR_WIDTH_OCTAVES = 1;
/** Ellis (2007) tightness: how strongly beats are pulled onto a steady period. */
const TIGHTNESS = 100;

/** In-place iterative radix-2 FFT with precomputed tables. */
function makeFft(n: number) {
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  return (re: Float64Array, im: Float64Array): void => {
    for (let i = 0; i < n; i++) {
      const j = rev[i] as number;
      if (j > i) {
        const tr = re[i] as number;
        re[i] = re[j] as number;
        re[j] = tr;
        const ti = im[i] as number;
        im[i] = im[j] as number;
        im[j] = ti;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step] as number;
          const wi = sin[k * step] as number;
          const a = start + k;
          const b = a + half;
          const xr = (re[b] as number) * wr - (im[b] as number) * wi;
          const xi = (re[b] as number) * wi + (im[b] as number) * wr;
          re[b] = (re[a] as number) - xr;
          im[b] = (im[a] as number) - xi;
          re[a] = (re[a] as number) + xr;
          im[a] = (im[a] as number) + xi;
        }
      }
    }
  };
}

/** Mean of the channels; samples that are not finite count as 0. */
function mixdown(pcm: Float32Array, channels: number): Float64Array {
  const frames = pcm.length / channels;
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const v = pcm[i * channels + c] as number;
      if (Number.isFinite(v)) sum += v;
    }
    mono[i] = sum / channels;
  }
  return mono;
}

/** Onset strength at 100 Hz: log-compressed spectral flux, detrended, rectified, unit variance. */
function onsetEnvelope(mono: Float64Array, rate: number): Float64Array | undefined {
  const hop = Math.round(rate / ENVELOPE_RATE);
  if (mono.length < WINDOW) return undefined;
  const count = Math.floor((mono.length - WINDOW) / hop) + 1;
  const fft = makeFft(WINDOW);
  const hann = new Float64Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW);
  const bins = WINDOW / 2 + 1;
  const top = Math.min(bins - 1, Math.floor((FLUX_MAX_HZ * WINDOW) / rate));
  const re = new Float64Array(WINDOW);
  const im = new Float64Array(WINDOW);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const flux = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    const start = f * hop;
    for (let i = 0; i < WINDOW; i++) {
      re[i] = (mono[start + i] as number) * (hann[i] as number);
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++)
      cur[k] = Math.log1p(1000 * Math.hypot(re[k] as number, im[k] as number));
    if (f > 0) {
      let sum = 0;
      for (let k = 1; k <= top; k++) sum += Math.max(0, (cur[k] as number) - (prev[k] as number));
      flux[f] = sum;
    }
    [prev, cur] = [cur, prev];
  }

  const low = lowBandFlux(mono, rate, hop, count);
  const spectral = normalise(flux);
  const bass = normalise(low);
  if (spectral === undefined && bass === undefined) return undefined;
  const env = new Float64Array(count);
  for (let i = 0; i < count; i++)
    env[i] = (spectral ? (spectral[i] as number) : 0) + (bass ? (bass[i] as number) : 0);
  return env;
}

/** Low-pass biquad (RBJ cookbook, Butterworth Q) over the whole signal, direct form I. */
function lowPass(mono: Float64Array, rate: number, hz: number): Float64Array {
  const w0 = (2 * Math.PI * Math.min(hz, rate / 2 - 1)) / rate;
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const cosW = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 - cosW) / 2 / a0;
  const b1 = (1 - cosW) / a0;
  const b2 = b0;
  const a1 = (-2 * cosW) / a0;
  const a2 = (1 - alpha) / a0;
  const out = new Float64Array(mono.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < mono.length; i++) {
    const x = mono[i] as number;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

/** Rise of the log energy of the bass band per envelope frame. */
function lowBandFlux(mono: Float64Array, rate: number, hop: number, count: number): Float64Array {
  const filtered = lowPass(mono, rate, LOW_BAND_HZ);
  const flux = new Float64Array(count);
  let prev = 0;
  for (let f = 0; f < count; f++) {
    const start = f * hop;
    let sum = 0;
    for (let i = 0; i < WINDOW; i++) sum += (filtered[start + i] as number) ** 2;
    const cur = Math.log1p((1000 * sum) / WINDOW);
    if (f > 0) flux[f] = Math.max(0, cur - prev);
    prev = cur;
  }
  return flux;
}

/** Subtract a centred moving average, keep what rises above it, scale to unit std; undefined if flat. */
function normalise(flux: Float64Array): Float64Array | undefined {
  const count = flux.length;
  const prefix = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) prefix[i + 1] = (prefix[i] as number) + (flux[i] as number);
  const env = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const lo = Math.max(0, i - MEAN_RADIUS);
    const hi = Math.min(count - 1, i + MEAN_RADIUS);
    const mean = ((prefix[hi + 1] as number) - (prefix[lo] as number)) / (hi - lo + 1);
    env[i] = Math.max(0, (flux[i] as number) - mean);
  }
  let mean = 0;
  for (let i = 0; i < count; i++) mean += env[i] as number;
  mean /= count;
  let variance = 0;
  for (let i = 0; i < count; i++) variance += ((env[i] as number) - mean) ** 2;
  const std = Math.sqrt(variance / count);
  if (!(std > 0) || !Number.isFinite(std)) return undefined;
  for (let i = 0; i < count; i++) env[i] = (env[i] as number) / std;
  return env;
}

/**
 * Beat times of decoded interleaved PCM, by onset envelope, tempo autocorrelation and the dynamic
 * programming tracker of Ellis (2007), "Beat tracking by dynamic programming". Pure and
 * deterministic: no randomness, clock or I/O. `undefined` when there is no steady beat.
 */
export function detectBeats(
  pcm: Float32Array,
  channels = 2,
  rate = 48_000,
): DetectedBeats | undefined {
  if (!Number.isInteger(channels) || channels < 1)
    throw new RangeError(`channels must be a positive integer, got ${channels}`);
  if (!Number.isInteger(rate) || rate < 1)
    throw new RangeError(`rate must be a positive integer, got ${rate}`);
  if (pcm.length % channels !== 0)
    throw new RangeError(`pcm length ${pcm.length} is not a multiple of ${channels} channels`);
  const frames = pcm.length / channels;
  if (frames / rate > BEAT_LIMITS.maxSeconds)
    throw new RangeError(
      `audio is longer than the ${BEAT_LIMITS.maxSeconds} s beat analysis limit`,
    );

  const hop = Math.round(rate / ENVELOPE_RATE);
  const env = onsetEnvelope(mixdown(pcm, channels), rate);
  if (env === undefined) return undefined;
  const n = env.length;

  // Tempo: weighted autocorrelation over the allowed lags.
  const minLag = Math.floor((60 * ENVELOPE_RATE) / BEAT_LIMITS.maxBpm);
  const maxLag = Math.min(Math.ceil((60 * ENVELOPE_RATE) / BEAT_LIMITS.minBpm), n - 1);
  if (maxLag < minLag) return undefined;
  // The envelope is rectified, so it has a positive mean that every lag would share; remove it,
  // or noise would score a confidence near 0.3.
  let envMean = 0;
  for (let t = 0; t < n; t++) envMean += env[t] as number;
  envMean /= n;
  const centred = env.map((v) => v - envMean);
  const acf = (lag: number): number => {
    let sum = 0;
    for (let t = 0; t + lag < n; t++) sum += (centred[t] as number) * (centred[t + lag] as number);
    return sum;
  };
  const score = (lag: number): number => {
    const bpm = (60 * ENVELOPE_RATE) / lag;
    return Math.exp(-0.5 * (Math.log2(bpm / PRIOR_BPM) / PRIOR_WIDTH_OCTAVES) ** 2) * acf(lag);
  };
  let bestLag = minLag;
  let best = Number.NEGATIVE_INFINITY;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const s = score(lag);
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  let period = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = score(bestLag - 1);
    const c = score(bestLag + 1);
    const denom = a - 2 * best + c;
    if (denom < 0) period += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
  }
  const bpm =
    Math.round(
      Math.max(BEAT_LIMITS.minBpm, Math.min(BEAT_LIMITS.maxBpm, (60 * ENVELOPE_RATE) / period)) *
        100,
    ) / 100;
  const confidence = Math.round(Math.max(0, Math.min(1, acf(bestLag) / acf(0))) * 1000) / 1000;
  if (!(confidence >= BEAT_LIMITS.minConfidence)) return undefined;

  // Beats: best-scoring chain of onsets spaced about one period apart.
  const lo = Math.max(1, Math.round(period / 2));
  const hi = Math.round(2 * period);
  const penalty = new Float64Array(hi + 1);
  for (let d = lo; d <= hi; d++) penalty[d] = TIGHTNESS * Math.log(d / period) ** 2;
  const total = new Float64Array(n);
  const pred = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let bestPrev = Number.NEGATIVE_INFINITY;
    let from = -1;
    for (let d = lo; d <= hi && t - d >= 0; d++) {
      const v = (total[t - d] as number) - (penalty[d] as number);
      if (v > bestPrev) {
        bestPrev = v;
        from = t - d;
      }
    }
    total[t] = (env[t] as number) + (from >= 0 ? bestPrev : 0);
    pred[t] = from;
  }
  let end = n - 1;
  for (let t = n - 1; t >= Math.max(0, n - Math.round(period)); t--)
    if ((total[t] as number) > (total[end] as number)) end = t;
  const chain: number[] = [];
  for (let t = end; t >= 0; t = pred[t] as number) chain.push(t);
  chain.reverse();

  const durationMs = Math.floor((frames * 1000) / rate);
  const times: number[] = [];
  for (const f of chain) {
    const ms = Math.round(((f * hop + WINDOW / 2) * 1000) / rate);
    if (ms >= durationMs || ms === times[times.length - 1]) continue;
    times.push(ms);
    if (times.length === MAX_BEATS) break;
  }
  if (times.length < BEAT_LIMITS.minBeats) return undefined;
  return { bpm, confidence, timesMs: times };
}
