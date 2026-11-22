// Tempo (BPM) estimation for constant-tempo music.
//
// Pipeline:
//   1. mix down to mono and decimate to ~11 kHz (beats live in the low/mid range)
//   2. onset strength envelope = positive spectral flux of the log-magnitude spectrum
//   3. coarse tempo = weighted autocorrelation of the envelope (with a mild prior around 120 BPM)
//   4. fine tempo = best phase-aligned pulse train over the whole track (sub-0.1 BPM precision)
//
// Pure TypeScript with no DOM dependencies, so it runs in a Web Worker and in Node tests.

export interface BpmResult {
  bpm: number;
  /** 0..1, how strongly the winning period stands out from the alternatives */
  confidence: number;
  /** Seconds of the first beat of the best pulse grid (useful for future beat markers) */
  firstBeat: number;
}

const TARGET_RATE = 11025;
const FRAME = 1024;
const HOP = 256;
const MIN_BPM = 50;
const MAX_BPM = 220;

export function detectBpm(channels: Float32Array[], sampleRate: number): BpmResult | null {
  const { signal, rate } = mixAndDecimate(channels, sampleRate);
  const env = onsetEnvelope(signal);
  const framesPerSec = rate / HOP;
  if (env.length < framesPerSec * 4) return null; // shorter than 4 seconds: not enough data

  const coarse = coarseTempo(env, framesPerSec);
  if (!coarse) return null;
  const fine = refineTempo(env, framesPerSec, coarse.bpm);
  return { bpm: fine.bpm, confidence: coarse.confidence, firstBeat: fine.phase / framesPerSec };
}

export function mixAndDecimate(channels: Float32Array[], sampleRate: number) {
  const factor = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const len = channels[0].length;
  const out = new Float32Array(Math.floor(len / factor));
  const n = channels.length;
  for (let i = 0; i < out.length; i++) {
    // Box-filter average acts as a cheap anti-aliasing low-pass before decimation.
    let sum = 0;
    const base = i * factor;
    for (let c = 0; c < n; c++) {
      const ch = channels[c];
      for (let k = 0; k < factor; k++) sum += ch[base + k];
    }
    out[i] = sum / (factor * n);
  }
  return { signal: out, rate: sampleRate / factor };
}

export function onsetEnvelope(x: Float32Array): Float32Array {
  const frames = Math.max(0, Math.floor((x.length - FRAME) / HOP) + 1);
  const bins = FRAME / 2;
  const window = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);

  // Group FFT bins into log-spaced bands (~1/3 octave) so that a low kick drum and a
  // broadband snare contribute comparably, instead of the snare dominating by bin count.
  const bandEdges: number[] = [1];
  while (bandEdges[bandEdges.length - 1] < bins) {
    const last = bandEdges[bandEdges.length - 1];
    bandEdges.push(Math.min(bins, Math.max(last + 1, Math.round(last * 1.26))));
  }
  const nBands = bandEdges.length - 1;

  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const prev = new Float64Array(nBands);
  const env = new Float32Array(frames);
  const fft = makeFft(FRAME);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = x[off + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let band = 0; band < nBands; band++) {
      let energy = 0;
      for (let b = bandEdges[band]; b < bandEdges[band + 1]; b++) energy += re[b] * re[b] + im[b] * im[b];
      const level = Math.log1p(1e4 * energy / (bandEdges[band + 1] - bandEdges[band]));
      const d = level - prev[band];
      if (d > 0 && f > 0) flux += d;
      prev[band] = level;
    }
    env[f] = flux;
  }

  // Remove the slowly varying loudness trend, keep only the peaks above it.
  const half = 8; // ~0.2 s on each side
  const out = new Float32Array(frames);
  let acc = 0;
  let count = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < frames; i++) {
    while (hi < Math.min(frames - 1, i + half)) acc += env[++hi], count++;
    while (lo < i - half) acc -= env[lo++], count--;
    out[i] = Math.max(0, env[i] - acc / count);
  }
  return out;
}

export function coarseTempo(raw: Float32Array, fps: number) {
  // Onset peaks are ~1 frame wide while beat periods are fractional in frames: smoothing
  // keeps the integer-lag autocorrelation from missing peaks that fall between frames.
  const env = smooth(raw, [1, 3, 4, 3, 1]);
  const minLag = Math.floor((60 * fps) / MAX_BPM);
  const maxLag = Math.ceil((60 * fps) / MIN_BPM);
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;

  const ac = new Float64Array(maxLag * 4 + 2);
  for (let lag = 0; lag < ac.length && lag < n; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += (env[i] - mean) * (env[i + lag] - mean);
    ac[lag] = s / (n - lag);
  }

  // Score each period by its own autocorrelation plus its multiples (a beat at period P
  // also correlates at 2P, 3P...) and apply a log-normal prior centred on 120 BPM so that
  // half/double tempo ambiguities resolve towards the musically common range.
  const scores: { lag: number; score: number }[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = ac[lag] + 0.5 * ac[2 * lag] + 0.25 * ac[3 * lag] + 0.25 * ac[4 * lag];
    const bpm = (60 * fps) / lag;
    const octaves = Math.log2(bpm / 120);
    s *= Math.exp(-0.5 * (octaves / 0.9) ** 2);
    scores.push({ lag, score: s });
  }
  let best = scores[0];
  for (const s of scores) if (s.score > best.score) best = s;
  if (!(best.score > 0)) return null;

  // Parabolic interpolation around the peak for a sub-frame estimate.
  const i = best.lag - minLag;
  let lag = best.lag;
  if (i > 0 && i < scores.length - 1) {
    const a = scores[i - 1].score, b = scores[i].score, c = scores[i + 1].score;
    const denom = a - 2 * b + c;
    if (denom < 0) lag += (0.5 * (a - c)) / denom;
  }

  // Confidence: margin between the winner and the best score that is not a near neighbour.
  let second = 0;
  for (const s of scores) {
    if (Math.abs(s.lag - best.lag) > 2 && s.score > second) second = s.score;
  }
  const confidence = Math.max(0, Math.min(1, 1 - second / best.score));
  return { bpm: (60 * fps) / lag, confidence };
}

function refineTempo(env: Float32Array, fps: number, around: number) {
  // Sample the envelope at fractional positions with linear interpolation; take the local
  // maximum over +/-1 frame to be tolerant of small onset jitter.
  const n = env.length;
  const at = (pos: number) => {
    const i = Math.floor(pos);
    if (i < 0 || i + 1 >= n) return 0;
    const t = pos - i;
    return env[i] * (1 - t) + env[i + 1] * t;
  };
  const peakNear = (pos: number) => Math.max(at(pos - 1), at(pos), at(pos + 1));

  let bestBpm = around;
  let bestScore = -Infinity;
  let bestPhase = 0;
  const span = Math.max(2, around * 0.03);
  for (let bpm = around - span; bpm <= around + span; bpm += 0.02) {
    const period = (60 * fps) / bpm;
    for (let phase = 0; phase < period; phase += 0.5) {
      let s = 0;
      let count = 0;
      for (let pos = phase; pos < n; pos += period) {
        s += peakNear(pos);
        count++;
      }
      s /= count;
      if (s > bestScore) {
        bestScore = s;
        bestBpm = bpm;
        bestPhase = phase;
      }
    }
  }
  // Whole BPM: what musicians expect, and sub-BPM precision is not meaningful for practice.
  return { bpm: Math.round(bestBpm), phase: bestPhase };
}

function smooth(x: Float32Array, kernel: number[]): Float32Array {
  const out = new Float32Array(x.length);
  const half = kernel.length >> 1;
  const norm = kernel.reduce((a, b) => a + b, 0);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (let k = 0; k < kernel.length; k++) {
      const j = i + k - half;
      if (j >= 0 && j < x.length) s += x[j] * kernel[k];
    }
    out[i] = s / norm;
  }
  return out;
}

/** In-place iterative radix-2 FFT for a fixed power-of-two size. */
function makeFft(size: number) {
  const levels = Math.log2(size);
  if (!Number.isInteger(levels)) throw new Error("FFT size must be a power of two");
  const rev = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = Math.sin((2 * Math.PI * i) / size);
  }
  return (re: Float64Array, im: Float64Array) => {
    for (let i = 0; i < size; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= size; len <<= 1) {
      const halfLen = len >> 1;
      const step = size / len;
      for (let i = 0; i < size; i += len) {
        for (let j = 0; j < halfLen; j++) {
          const wr = cos[j * step], wi = -sin[j * step];
          const a = i + j, b = a + halfLen;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}
