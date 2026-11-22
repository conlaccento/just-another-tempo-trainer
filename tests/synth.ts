// Synthetic test audio shared by the unit tests and the browser tests.

export const SR = 44100;

// Deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Synthetic drum loop: kick on 1 and 3, snare on 2 and 4, hi-hat on eighths, plus a pad. */
export function drumTrack(bpm: number, seconds: number, seed = 1) {
  const rand = rng(seed);
  const len = Math.floor(seconds * SR);
  const l = new Float32Array(len);
  const r = new Float32Array(len);
  const beat = (60 / bpm) * SR;
  const add = (start: number, dur: number, fn: (t: number) => number) => {
    for (let i = 0; i < dur * SR && start + i < len; i++) {
      const v = fn(i / SR);
      l[start + i] += v;
      r[start + i] += v;
    }
  };
  for (let b = 0; b * beat < len; b++) {
    const s = Math.round(b * beat);
    if (b % 2 === 0) add(s, 0.25, (t) => 0.8 * Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 12));
    else add(s, 0.2, (t) => 0.4 * (rand() * 2 - 1) * Math.exp(-t * 20));
    for (const off of [0, 0.5]) add(Math.round(s + off * beat), 0.05, (t) => 0.15 * (rand() * 2 - 1) * Math.exp(-t * 80));
  }
  // Sustained chord + background noise make it less trivial than a bare click track.
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const pad = 0.05 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t));
    const noise = 0.02 * (rand() * 2 - 1);
    l[i] += pad + noise;
    r[i] += pad - noise;
  }
  return [l, r];
}

/** Pure sine tone, used to verify that slowing down does not change pitch. */
export function sineTone(freq: number, seconds: number) {
  const ch = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < ch.length; i++) ch[i] = 0.3 * Math.sin((2 * Math.PI * freq * i) / SR);
  return [ch, ch];
}

/** Encodes channels as a 16-bit PCM WAV file. */
export function encodeWav(channels: Float32Array[]): Uint8Array {
  const n = channels[0].length, nch = channels.length;
  const buf = new ArrayBuffer(44 + n * nch * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * nch * 2, true); str(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * nch * 2, true);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      v.setInt16(44 + (i * nch + c) * 2, Math.round(Math.max(-1, Math.min(1, channels[c][i])) * 32767), true);
    }
  }
  return new Uint8Array(buf);
}
