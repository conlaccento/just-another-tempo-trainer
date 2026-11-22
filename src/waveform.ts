// Waveform overview with playhead and A–B loop region.
// Click = seek, drag = select a loop region, drag the region edges = adjust it.

import type { Loop } from "./player.ts";

export interface WaveformEvents {
  onSeek(t: number): void;
  onLoopChange(loop: Loop | null): void;
}

const EDGE_PX = 8;

export class Waveform {
  private ctx: CanvasRenderingContext2D;
  private peaks: Float32Array | null = null; // [min, max] pairs at high resolution
  private duration = 0;
  private position = 0;
  private loop: Loop | null = null;
  private loopEnabled = false;
  private drag: { mode: "new" | "start" | "end"; x0: number; t0: number; moved: boolean } | null = null;

  constructor(private canvas: HTMLCanvasElement, private events: WaveformEvents) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.draw()).observe(canvas);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.draw());
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", () => (this.drag = null));
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

  setLoop(loop: Loop | null, enabled: boolean) {
    this.loop = loop;
    this.loopEnabled = enabled;
    this.draw();
  }

  private timeAt(clientX: number) {
    const r = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * this.duration;
  }

  private xOf(t: number) {
    return (t / this.duration) * this.canvas.getBoundingClientRect().width;
  }

  private edgeAt(clientX: number): "start" | "end" | null {
    if (!this.loop || !this.duration) return null;
    const x = clientX - this.canvas.getBoundingClientRect().left;
    if (Math.abs(x - this.xOf(this.loop.start)) <= EDGE_PX) return "start";
    if (Math.abs(x - this.xOf(this.loop.end)) <= EDGE_PX) return "end";
    return null;
  }

  private down(e: PointerEvent) {
    if (!this.duration) return;
    this.canvas.setPointerCapture(e.pointerId);
    const edge = this.edgeAt(e.clientX);
    this.drag = { mode: edge ?? "new", x0: e.clientX, t0: this.timeAt(e.clientX), moved: false };
  }

  private move(e: PointerEvent) {
    if (!this.drag) {
      this.canvas.style.cursor = this.edgeAt(e.clientX) ? "ew-resize" : "pointer";
      return;
    }
    if (Math.abs(e.clientX - this.drag.x0) > 4) this.drag.moved = true;
    if (!this.drag.moved) return;
    const t = this.timeAt(e.clientX);
    if (this.drag.mode === "new") this.loop = { start: Math.min(t, this.drag.t0), end: Math.max(t, this.drag.t0) };
    else if (this.loop && this.drag.mode === "start") this.loop = { start: Math.min(t, this.loop.end - 0.1), end: this.loop.end };
    else if (this.loop) this.loop = { start: this.loop.start, end: Math.max(t, this.loop.start + 0.1) };
    this.loopEnabled = true;
    this.draw();
  }

  private up(e: PointerEvent) {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if (drag.moved) this.events.onLoopChange(this.loop);
    else this.events.onSeek(this.timeAt(e.clientX));
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

    if (this.loop) {
      const x0 = this.xOf(this.loop.start), x1 = this.xOf(this.loop.end);
      g.fillStyle = color(this.loopEnabled ? "--loop-fill" : "--loop-fill-off");
      g.fillRect(x0, 0, x1 - x0, h);
      g.fillStyle = color(this.loopEnabled ? "--loop-edge" : "--loop-edge-off");
      g.fillRect(x0 - 1, 0, 2, h);
      g.fillRect(x1 - 1, 0, 2, h);
      g.font = "600 11px system-ui, sans-serif";
      g.fillText("A", x0 + 4, 13);
      g.fillText("B", x1 - 12, 13);
    }

    g.fillStyle = color("--playhead");
    g.fillRect(playedX - 1, 0, 2, h);
  }
}
