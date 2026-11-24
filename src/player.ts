// Audio playback with independent tempo and pitch, built on Signalsmith Stretch
// (WASM in an AudioWorklet). Positions are always expressed in seconds of the original song.

type StretchNode = AudioWorkletNode & {
  inputTime: number;
  schedule(opts: Record<string, number | boolean>): Promise<unknown>;
  addBuffers(buffers: Float32Array[]): Promise<number>;
  dropBuffers(): Promise<unknown>;
  setUpdateInterval(seconds: number, cb?: (t: number) => void): Promise<unknown>;
};

type StretchFactory = (ctx: BaseAudioContext, options?: AudioWorkletNodeOptions) => Promise<StretchNode>;

// Loaded at runtime, untouched by the bundler (see vite.config.ts for why).
let factory: Promise<StretchFactory> | null = null;
function loadStretch() {
  factory ??= import(/* @vite-ignore */ new URL(__STRETCH_URL__, document.baseURI).href).then((m) => m.default as StretchFactory);
  return factory;
}

export interface Loop {
  start: number;
  end: number;
}

export class Player {
  readonly ctx: AudioContext;
  private node: StretchNode | null = null;
  private ready: Promise<StretchNode>;

  duration = 0;
  playing = false;
  rate = 1;
  semitones = 0;
  loop: Loop | null = null;

  private lastPosition = 0;
  /** Time reports already in flight when we seek carry the old position: drop them. */
  private ignoreReportsUntil = 0;
  /** Called ~30 times per second while playing, with the position in the original song. */
  onTime: (t: number) => void = () => {};
  /** Called when playback reaches the end of the song (no loop). */
  onEnded: () => void = () => {};

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "playback" });
    this.ready = loadStretch()
      // Keep one (unconnected) input: with zero inputs the processor dereferences an
      // undefined input list while paused, throws, and the node dies for good.
      .then((create) => create(this.ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }))
      .then((node) => {
        node.connect(this.ctx.destination);
        node.setUpdateInterval(1 / 30, (t) => this.handleTime(t));
        this.node = node;
        return node;
      });
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data);
  }

  async load(buffer: AudioBuffer) {
    const node = await this.ready;
    await this.pause();
    await node.dropBuffers();
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    await node.addBuffers([left.slice(), right.slice()]);
    this.duration = buffer.duration;
    this.loop = null;
    this.lastPosition = 0;
    await node.schedule({ active: false, input: 0, rate: this.rate, semitones: this.semitones, loopStart: 0, loopEnd: 0 });
    this.onTime(0);
  }

  get position() {
    return this.lastPosition;
  }

  async play() {
    if (!this.node || this.duration === 0) return;
    if (this.ctx.state !== "running") await this.ctx.resume();
    let from = this.lastPosition;
    if (from >= this.duration - 0.05) from = this.loop ? this.loop.start : 0;
    this.playing = true;
    await this.node.schedule({ active: true, input: from, rate: this.rate });
  }

  async pause() {
    this.playing = false;
    if (this.node) await this.node.schedule({ active: false });
  }

  async toggle() {
    return this.playing ? this.pause() : this.play();
  }

  async seek(t: number) {
    t = Math.max(0, Math.min(this.duration, t));
    this.lastPosition = t;
    this.ignoreReportsUntil = performance.now() + 150;
    this.onTime(t);
    if (this.node) await this.node.schedule({ input: t });
  }

  async setRate(rate: number) {
    this.rate = rate;
    if (this.node) await this.node.schedule({ rate });
  }

  async setSemitones(semitones: number) {
    this.semitones = semitones;
    if (this.node) await this.node.schedule({ semitones });
  }

  async setLoop(loop: Loop | null) {
    this.loop = loop && loop.end - loop.start > 0.05 ? loop : null;
    const l = this.loop;
    if (this.node) await this.node.schedule({ loopStart: l ? l.start : 0, loopEnd: l ? l.end : 0 });
  }

  private handleTime(t: number) {
    // While paused the worklet keeps reporting the frozen position; ignore stale reports
    // that would undo a seek made in the meantime.
    if (!this.playing || performance.now() < this.ignoreReportsUntil) return;
    if (!this.loop && t >= this.duration) {
      this.lastPosition = this.duration;
      this.pause();
      this.onTime(this.duration);
      this.onEnded();
      return;
    }
    this.lastPosition = Math.max(0, Math.min(this.duration, t));
    this.onTime(this.lastPosition);
  }
}
