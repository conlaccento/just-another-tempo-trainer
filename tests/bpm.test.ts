import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBpm } from "../src/bpm.ts";
import { TapTempo } from "../src/tap.ts";
import { SR, drumTrack } from "./synth.ts";

// In the common range the exact tempo is required. At the extremes half/double tempo is a
// genuine ambiguity (the UI offers x2 / ÷2), but the value must still be precise.
for (const bpm of [90, 100, 112, 120, 128, 133.5, 145]) {
  test(`detects ${bpm} BPM on a synthetic drum loop`, () => {
    const res = detectBpm(drumTrack(bpm, 40, Math.round(bpm * 10)), SR);
    assert.ok(res, "expected a result");
    assert.ok(Math.abs(res.bpm - bpm) <= 0.3, `expected ~${bpm}, got ${res.bpm}`);
  });
}
for (const bpm of [64, 72, 160, 174]) {
  test(`detects ${bpm} BPM up to an octave on a synthetic drum loop`, () => {
    const res = detectBpm(drumTrack(bpm, 40, Math.round(bpm * 10)), SR);
    assert.ok(res, "expected a result");
    const ok = [bpm, bpm * 2, bpm / 2].some((c) => Math.abs(res.bpm - c) <= 0.3 * (c / bpm));
    assert.ok(ok, `expected ${bpm} or an octave of it, got ${res.bpm}`);
  });
}

test("is not fooled by a 3:2 subdivision (triplet hi-hats)", () => {
  const [l, r] = drumTrack(100, 40, 7);
  const beat = (60 / 100) * SR;
  for (let s = 0; s < l.length; s += beat / 3) {
    for (let i = 0; i < 0.03 * SR && s + i < l.length; i++) {
      const v = 0.1 * Math.sin(i * 1.7) * Math.exp(-i / 200);
      l[Math.floor(s) + i] += v;
      r[Math.floor(s) + i] += v;
    }
  }
  const res = detectBpm([l, r], SR);
  assert.ok(res && Math.abs(res.bpm - 100) <= 0.3, `got ${res?.bpm}`);
});

test("works with mono input and 48 kHz", () => {
  const [l] = drumTrack(110, 30);
  // Naive resample 44.1k -> 48k by linear interpolation.
  const out = new Float32Array(Math.floor((l.length * 48000) / SR));
  for (let i = 0; i < out.length; i++) {
    const p = (i * SR) / 48000, k = Math.floor(p), t = p - k;
    out[i] = l[k] * (1 - t) + (l[k + 1] ?? 0) * t;
  }
  const res = detectBpm([out], 48000);
  assert.ok(res && Math.abs(res.bpm - 110) <= 0.3, `got ${res?.bpm}`);
});

test("returns null for too-short or silent audio", () => {
  assert.equal(detectBpm([new Float32Array(SR)], SR), null);
  assert.equal(detectBpm([new Float32Array(SR * 10)], SR), null);
});

test("tap tempo averages intervals and resets after a pause", () => {
  const tap = new TapTempo();
  assert.equal(tap.tap(0), null);
  assert.equal(tap.tap(500), 120);
  assert.equal(tap.tap(1000), 120);
  assert.equal(tap.tap(1500), 120);
  assert.equal(tap.tap(10000), null); // long pause starts over
  assert.equal(tap.tap(10600), 100);
});
