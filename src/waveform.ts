// Waveform overview with playhead. Click (or drag) to seek.

export class Waveform {
  private ctx: CanvasRenderingContext2D;
  private peaks: Float32Array | null = null; // [min, max] pairs at high resolution
  private duration = 0;
  private position = 0;
  private dragging = false;

  constructor(private canvas: HTMLCanvasElement, private onSeek: (t: number) => void) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.draw()).observe(canvas);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.draw());
    canvas.addEventListener("pointerdown", (e) => {
      if (!this.duration) return;
      canvas.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.onSeek(this.timeAt(e.clientX));
    });
    canvas.addEventListener("pointermove", (e) => this.dragging && this.onSeek(this.timeAt(e.clientX)));
    canvas.addEventListener("pointerup", () => (this.dragging = false));
    canvas.addEventListener("pointercancel", () => (this.dragging = false));
  }

  setBuffer(buffer: AudioBuffer | null) {
    this.peaks = null;
    this.duration = buffer?.duration ?? 0;
    if (buffer) {
      const buckets = 4000;
      const peaks = new Float32Array(buckets * 2);
      const chans = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
      const per = Math.max(1, Math.floor(buffer.length / buckets));
      for (let b = 0; b < buckets; b++) {
        let lo = 0, hi = 0;
        const start = b * per;
        // Sampling every 4th frame is plenty for a visual overview.
        for (let i = start; i < start + per && i < buffer.length; i += 4) {
          for (const ch of chans) {
            const v = ch[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        peaks[2 * b] = lo;
        peaks[2 * b + 1] = hi;
      }
      this.peaks = peaks;
    }
    this.draw();
  }

  setPosition(t: number) {
    this.position = t;
    this.draw();
  }

  private timeAt(clientX: number) {
    const r = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * this.duration;
  }

  private xOf(t: number) {
    return (t / this.duration) * this.canvas.getBoundingClientRect().width;
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(c);
    const color = (name: string) => css.getPropertyValue(name).trim();
    if (!this.peaks || !this.duration) return;

    const mid = h / 2;
    const playedX = this.xOf(this.position);
    const buckets = this.peaks.length / 2;
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((x / w) * buckets), b1 = Math.max(b0 + 1, Math.floor(((x + 1) / w) * buckets));
      let lo = 0, hi = 0;
      for (let b = b0; b < b1; b++) {
        lo = Math.min(lo, this.peaks[2 * b]);
        hi = Math.max(hi, this.peaks[2 * b + 1]);
      }
      g.fillStyle = x < playedX ? color("--wave-played") : color("--wave");
      g.fillRect(x, mid - hi * mid * 0.95, 1, Math.max(1, (hi - lo) * mid * 0.95));
    }

    g.fillStyle = color("--playhead");
    g.fillRect(playedX - 1.5, 0, 3, h);
  }
}
