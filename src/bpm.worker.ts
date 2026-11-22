import { detectBpm } from "./bpm.ts";

// Runs the (CPU-heavy) tempo analysis off the UI thread.
self.onmessage = (e: MessageEvent<{ id: number; channels: Float32Array[]; sampleRate: number }>) => {
  const { id, channels, sampleRate } = e.data;
  try {
    self.postMessage({ id, result: detectBpm(channels, sampleRate) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
