// Zoomable waveform with playhead and A–B loop region.
// Click = seek, drag = select a loop region, drag the region edges = adjust it.
// Zoom: Ctrl/⌘ + wheel or pinch (around the pointer), or the public zoom methods.
// Pan: horizontal wheel / Shift + wheel, or the scrollbar handled in main.ts.

import type { Loop } from "./player.ts";

export interface WaveformEvents {
  onSeek(t: number): void;
  onLoopChange(loop: Loop | null): void;
  /** Called whenever the visible time range changes. */
  onViewChange?(start: number, span: number): void;
}

const EDGE_PX = 8;
const OVERVIEW_BUCKETS = 4000;
/** Narrowest visible range, in seconds. */
const MIN_SPAN = 0.5;

export class Waveform {
  private canvas: HTMLCanvasElement;
  private events: WaveformEvents;
  private ctx: CanvasRenderingContext2D;
  private channels: Float32Array[] = [];
  private sampleRate = 44100;
  private overview: Float32Array | null = null; // [min, max] pairs over the whole song
  private duration = 0;
  private position = 0;
  private loop: Loop | null = null;
  private loopEnabled = false;
  private drag: { mode: "new" | "start" | "end"; x0: number; t0: number; moved: boolean } | null = null;
  private viewStart = 0;
  private viewSpan = 0;
  /** Per-pixel [min, max] for the current view and width, rebuilt only when they change. */
  private columns: { key: string; data: Float32Array } | null = null;
  private pinchSpan = 0;

  constructor(canvas: HTMLCanvasElement, events: WaveformEvents) {
    this.canvas = canvas;
    this.events = events;
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.draw()).observe(canvas);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.draw());
    document.fonts?.ready.then(() => this.draw());
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", () => (this.drag = null));
    canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    // Safari / WKWebView report trackpad pinches as non-standard gesture events.
    canvas.addEventListener("gesturestart", (e) => {
      e.preventDefault();
      this.pinchSpan = this.viewSpan;
    });
    canvas.addEventListener("gesturechange", (e) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number };
      this.zoomAround(this.timeAt(g.clientX), this.pinchSpan / g.scale);
    });
  }

  setBuffer(buffer: AudioBuffer | null) {
    this.overview = null;
    this.columns = null;
    this.duration = buffer?.duration ?? 0;
    this.channels = buffer ? Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)) : [];
    this.sampleRate = buffer?.sampleRate ?? 44100;
    if (buffer) {
      const peaks = new Float32Array(OVERVIEW_BUCKETS * 2);
      const per = Math.max(1, Math.floor(buffer.length / OVERVIEW_BUCKETS));
      for (let b = 0; b < OVERVIEW_BUCKETS; b++) {
        const [lo, hi] = this.scan(b * per, Math.min(buffer.length, (b + 1) * per));
        peaks[2 * b] = lo;
        peaks[2 * b + 1] = hi;
      }
      this.overview = peaks;
    }
    this.viewStart = 0;
    this.viewSpan = this.duration;
    this.emitView();
    this.draw();
  }

  setPosition(t: number) {
    // When zoomed in, turn the page as the playhead leaves the window, but only if it was in
    // view: if the user is looking at another part of the song, leave the view alone.
    if (this.zoomed && this.inView(this.position) && !this.inView(t)) this.setView(t - this.viewSpan * 0.05, this.viewSpan);
    this.position = t;
    this.draw();
  }

  private inView(t: number) {
    return t >= this.viewStart && t <= this.viewStart + this.viewSpan;
  }

  setLoop(loop: Loop | null, enabled: boolean) {
    this.loop = loop;
    this.loopEnabled = enabled;
    this.draw();
  }

  // ---- view -------------------------------------------------------------------------------

  get zoomed() {
    return this.duration > 0 && this.viewSpan < this.duration - 1e-6;
  }

  get minSpan() {
    return Math.min(MIN_SPAN, this.duration);
  }

  /** Zoom in (factor > 1) or out (factor < 1), keeping `anchor` (default: playhead or view centre) in place. */
  zoomBy(factor: number, anchor?: number) {
    if (!this.duration) return;
    this.zoomAround(anchor ?? (this.inView(this.position) ? this.position : this.viewStart + this.viewSpan / 2), this.viewSpan / factor);
  }

  /** Show the whole song. */
  fit() {
    this.setView(0, this.duration);
  }

  /** Show a time range with a small margin on both sides. */
  zoomTo(start: number, end: number) {
    const margin = (end - start) * 0.08;
    this.setView(start - margin, end - start + 2 * margin);
  }

  /** Move the view so that it starts at `start`, keeping the current zoom. */
  scrollTo(start: number) {
    this.setView(start, this.viewSpan);
  }

  private zoomAround(anchor: number, span: number) {
    span = Math.max(this.minSpan, Math.min(this.duration, span));
    const frac = this.viewSpan ? (anchor - this.viewStart) / this.viewSpan : 0.5;
    this.setView(anchor - frac * span, span);
  }

  private setView(start: number, span: number) {
    span = Math.max(this.minSpan, Math.min(this.duration, span));
    start = Math.max(0, Math.min(this.duration - span, start));
    if (start === this.viewStart && span === this.viewSpan) return;
    this.viewStart = start;
    this.viewSpan = span;
    this.emitView();
    this.draw();
  }

  private emitView() {
    this.events.onViewChange?.(this.viewStart, this.viewSpan);
  }

  private wheel(e: WheelEvent) {
    if (!this.duration) return;
    const width = this.canvas.getBoundingClientRect().width || 1;
    // Lines / pages → pixels, so mice and trackpads feel alike.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? width : 1;
    if (e.ctrlKey || e.metaKey) {
      // Ctrl + wheel, ⌘ + wheel, or a trackpad pinch in Chromium (sent as Ctrl + wheel).
      e.preventDefault();
      this.zoomAround(this.timeAt(e.clientX), this.viewSpan * Math.exp((e.deltaY * unit) / 200));
      return;
    }
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    // Plain vertical scrolling keeps scrolling the page.
    if (!this.zoomed || Math.abs(dx) < Math.abs(e.shiftKey ? 0 : e.deltaY)) return;
    e.preventDefault();
    this.setView(this.viewStart + ((dx * unit) / width) * this.viewSpan, this.viewSpan);
  }

  // ---- pointer ------------------------------------------------------------------------------

  private timeAt(clientX: number) {
    const r = this.canvas.getBoundingClientRect();
    return this.viewStart + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * this.viewSpan;
  }

  private xOf(t: number) {
    return ((t - this.viewStart) / this.viewSpan) * this.canvas.getBoundingClientRect().width;
  }

  private edgeAt(clientX: number): "start" | "end" | null {
    if (!this.loop || !this.duration) return null;
    const x = clientX - this.canvas.getBoundingClientRect().left;
    if (Math.abs(x - this.xOf(this.loop.start)) <= EDGE_PX) return "start";
    if (Math.abs(x - this.xOf(this.loop.end)) <= EDGE_PX) return "end";
    return null;
  }

  private down(e: PointerEvent) {
    if (!this.duration || e.button > 0) return;
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
    const minLen = Math.min(0.1, this.viewSpan / 50);
    if (this.drag.mode === "new") this.loop = { start: Math.min(t, this.drag.t0), end: Math.max(t, this.drag.t0) };
    else if (this.loop && this.drag.mode === "start") this.loop = { start: Math.min(t, this.loop.end - minLen), end: this.loop.end };
    else if (this.loop) this.loop = { start: this.loop.start, end: Math.max(t, this.loop.start + minLen) };
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

  // ---- drawing ------------------------------------------------------------------------------

  /** Min / max of all channels over [from, to) samples, reading at most ~256 samples. */
  private scan(from: number, to: number): [number, number] {
    let lo = 0, hi = 0;
    const step = Math.max(1, Math.floor((to - from) / 256));
    for (const ch of this.channels) {
      for (let i = from; i < to; i += step) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return [lo, hi];
  }

  private columnsFor(width: number): Float32Array {
    const key = `${width}:${this.viewStart}:${this.viewSpan}`;
    if (this.columns?.key === key) return this.columns.data;
    const data = new Float32Array(width * 2);
    const total = this.channels[0]?.length ?? 0;
    const overview = this.overview!;
    const samplesPerPx = (this.viewSpan * this.sampleRate) / width;
    const bucketSamples = total / OVERVIEW_BUCKETS;
    for (let x = 0; x < width; x++) {
      const t0 = this.viewStart + (x / width) * this.viewSpan;
      let lo = 0, hi = 0;
      if (samplesPerPx >= bucketSamples * 2) {
        // Zoomed out: the precomputed overview is detailed enough and much cheaper.
        const b0 = Math.floor((t0 / this.duration) * OVERVIEW_BUCKETS);
        const b1 = Math.max(b0 + 1, Math.floor(((t0 + this.viewSpan / width) / this.duration) * OVERVIEW_BUCKETS));
        for (let b = b0; b < b1 && b < OVERVIEW_BUCKETS; b++) {
          lo = Math.min(lo, overview[2 * b]);
          hi = Math.max(hi, overview[2 * b + 1]);
        }
      } else {
        const from = Math.floor(t0 * this.sampleRate);
        [lo, hi] = this.scan(from, Math.min(total, Math.max(from + 1, Math.floor(from + samplesPerPx))));
      }
      data[2 * x] = lo;
      data[2 * x + 1] = hi;
    }
    this.columns = { key, data };
    return data;
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
    if (!this.overview || !this.duration || !w) return;

    const mid = h / 2;
    const playedX = this.xOf(this.position);
    // Loop region goes behind the waveform so it does not tint the bars.
    if (this.loop) {
      g.fillStyle = color(this.loopEnabled ? "--loop-fill" : "--loop-fill-off");
      g.fillRect(this.xOf(this.loop.start), 0, this.xOf(this.loop.end) - this.xOf(this.loop.start), h);
    }
    const cols = this.columnsFor(Math.round(w));
    const wave = color("--wave"), played = color("--wave-played");
    for (let x = 0; x < cols.length / 2; x++) {
      const lo = cols[2 * x], hi = cols[2 * x + 1];
      g.fillStyle = x < playedX ? played : wave;
      g.fillRect(x, mid - hi * mid * 0.95, 1, Math.max(1, (hi - lo) * mid * 0.95));
    }

    if (this.loop) {
      const x0 = this.xOf(this.loop.start), x1 = this.xOf(this.loop.end);
      g.fillStyle = color(this.loopEnabled ? "--loop-edge" : "--loop-edge-off");
      g.fillRect(x0 - 1.5, 0, 3, h);
      g.fillRect(x1 - 1.5, 0, 3, h);
      g.font = "700 13px Jost, system-ui, sans-serif";
      g.fillText("A", x0 + 5, 14);
      g.fillText("B", x1 - 14, 14);
    }

    g.fillStyle = color("--playhead");
    g.fillRect(playedX - 1.5, 0, 3, h);
  }
}
