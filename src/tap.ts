// Tap-tempo: average BPM from the intervals between the last taps.

export class TapTempo {
  private taps: number[] = [];
  private readonly maxTaps: number;
  private readonly resetAfterMs: number;

  constructor(maxTaps = 8, resetAfterMs = 2000) {
    this.maxTaps = maxTaps;
    this.resetAfterMs = resetAfterMs;
  }

  /** Register a tap at `now` (ms). Returns the current estimate, or null with < 2 taps. */
  tap(now: number): number | null {
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && now - last > this.resetAfterMs) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > this.maxTaps) this.taps.shift();
    if (this.taps.length < 2) return null;
    const span = this.taps[this.taps.length - 1] - this.taps[0];
    return Math.round((60000 * (this.taps.length - 1)) / span);
  }

  get count() {
    return this.taps.length;
  }
}
