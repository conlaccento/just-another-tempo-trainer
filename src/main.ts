import "@fontsource/jost/latin-400.css";
import "@fontsource/jost/latin-500.css";
import "@fontsource/jost/latin-700.css";
import "./style.css";
import { lang, t, type Strings } from "./i18n.ts";
import { Player, type Loop } from "./player.ts";
import { Waveform } from "./waveform.ts";
import { TapTempo } from "./tap.ts";
import type { BpmResult } from "./bpm.ts";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { initUpdates } from "./updates.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- static texts -------------------------------------------------------------------
document.documentElement.lang = lang;
document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => (el.textContent = t[el.dataset.i18n as keyof Strings]));
document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
  const text = t[el.dataset.i18nTitle as keyof Strings];
  el.title = text;
  if (!el.textContent?.trim()) el.setAttribute("aria-label", text);
});
document.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t[el.dataset.i18nAria as keyof Strings]));

// ---- elements -----------------------------------------------------------------------
const fileInput = $<HTMLInputElement>("fileInput");
const dropSection = $("drop");
const dropStatus = $("dropStatus");
const playerSection = $("player");
const fileName = $("fileName");
const playBtn = $<HTMLButtonElement>("playBtn");
const cur = $("cur");
const dur = $("dur");
const origInput = $<HTMLInputElement>("origInput");
const targetInput = $<HTMLInputElement>("targetInput");
const bpmStatus = $("bpmStatus");
const speedRange = $<HTMLInputElement>("speedRange");
const speedOut = $("speedOut");
const loopBtn = $<HTMLButtonElement>("loopBtn");
const pitchOut = $("pitchOut");
const loopTimes = $("loopTimes");
const zoomLoopBtn = $<HTMLButtonElement>("zoomLoopBtn");
const waveScroll = $("waveScroll");
const waveThumb = $("waveThumb");

// ---- state --------------------------------------------------------------------------
const MIN_RATE = 0.25;
const MAX_RATE = 1.5;

let player: Player | null = null;
let waveform: Waveform;
let fileKey = "";
let originalBpm: number | null = null;
let rate = 1;
let semitones = 0;
let loop: Loop | null = null;
let loopEnabled = false;
let loadToken = 0;
const tapper = new TapTempo();

interface Saved {
  originalBpm?: number | null;
  rate?: number;
  semitones?: number;
  loop?: Loop | null;
  loopEnabled?: boolean;
}

// Per-song settings are a convenience only: storage may be unavailable.
function loadSaved(key: string): Saved {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}") as Saved;
  } catch {
    return {};
  }
}
function save() {
  if (!fileKey) return;
  try {
    localStorage.setItem(fileKey, JSON.stringify({ originalBpm, rate, semitones, loop, loopEnabled } satisfies Saved));
  } catch {
    /* ignore */
  }
}

// ---- helpers ------------------------------------------------------------------------
const fmt = (s: number, tenths = true) => {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${(tenths ? sec.toFixed(1) : Math.floor(sec).toString()).padStart(tenths ? 4 : 2, "0")}`;
};
/** m:ss.cc, precise enough to place loop points on a zoomed waveform. */
const fmtPrecise = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
const clampRate = (r: number) => Math.max(MIN_RATE, Math.min(MAX_RATE, r));

function getPlayer() {
  // Created lazily: the AudioContext needs a user gesture before it may start.
  if (!player) {
    player = new Player();
    player.onTime = (time) => {
      cur.textContent = fmt(time);
      waveform.setPosition(time);
    };
    player.onEnded = () => updatePlayButton();
    // Debug handle for automated browser tests.
    (window as unknown as { __player: Player }).__player = player;
  }
  return player;
}

// ---- file loading ---------------------------------------------------------------------
async function openFile(file: File) {
  const token = ++loadToken;
  dropStatus.textContent = t.loading;
  dropStatus.classList.remove("error");
  try {
    const p = getPlayer();
    const buffer = await p.decode(await file.arrayBuffer());
    if (token !== loadToken) return;
    await p.load(buffer);
    if (token !== loadToken) return;

    fileKey = `tt:${file.name}:${file.size}`;
    const saved = loadSaved(fileKey);
    fileName.textContent = file.name;
    document.title = `${file.name} — Just another Tempo Trainer`;
    dur.textContent = fmt(buffer.duration, false);
    dropSection.hidden = true;
    playerSection.hidden = false;
    dropStatus.textContent = "";

    waveform.setBuffer(buffer);
    originalBpm = saved.originalBpm ? Math.round(saved.originalBpm) : null;
    rate = clampRate(saved.rate ?? 1);
    semitones = saved.semitones ?? 0;
    loop = saved.loop && saved.loop.end <= buffer.duration ? saved.loop : null;
    loopEnabled = !!(loop && saved.loopEnabled);
    await p.setRate(rate);
    await p.setSemitones(semitones);
    await applyLoop(false);
    renderTempo();
    renderPitch();
    updatePlayButton();

    if (saved.originalBpm) setBpmStatus("");
    else analyze(buffer, token);
  } catch (err) {
    console.error(err);
    if (token !== loadToken) return;
    dropSection.hidden = false;
    playerSection.hidden = true;
    dropStatus.textContent = t.error;
    dropStatus.classList.add("error");
  }
}

let worker: Worker | null = null;
function analyze(buffer: AudioBuffer, token: number) {
  setBpmStatus(t.analyzing, "busy");
  worker ??= new Worker(new URL("./bpm.worker.ts", import.meta.url), { type: "module" });
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, i) => buffer.getChannelData(i).slice());
  worker.onmessage = (e: MessageEvent<{ id: number; result?: BpmResult | null; error?: string }>) => {
    if (e.data.id !== token || token !== loadToken) return;
    const res = e.data.result;
    if (!res) {
      setBpmStatus(t.notDetected, "warn");
      renderTempo();
      return;
    }
    // Keep the practice speed the user may have already chosen while analysis ran.
    originalBpm = res.bpm;
    setBpmStatus(res.confidence < 0.15 ? t.uncertain : "", res.confidence < 0.15 ? "warn" : "");
    renderTempo();
    save();
  };
  worker.postMessage({ id: token, channels, sampleRate: buffer.sampleRate }, channels.map((c) => c.buffer));
}

function setBpmStatus(text: string, kind: "" | "busy" | "warn" = "") {
  bpmStatus.textContent = text;
  bpmStatus.dataset.kind = kind;
}

// ---- tempo ----------------------------------------------------------------------------
function renderTempo() {
  const hasBpm = originalBpm !== null;
  if (document.activeElement !== origInput) origInput.value = hasBpm ? String(originalBpm) : "";
  origInput.placeholder = "—";
  if (document.activeElement !== targetInput) targetInput.value = hasBpm ? String(Math.round(originalBpm! * rate)) : "";
  targetInput.disabled = !hasBpm;
  targetInput.placeholder = "—";
  for (const id of ["targetDown", "targetUp", "halfBtn", "doubleBtn"]) $<HTMLButtonElement>(id).disabled = !hasBpm;
  speedRange.value = String(Math.round(rate * 100));
  speedOut.textContent = `${Math.round(rate * 100)}%`;
  document.querySelectorAll<HTMLButtonElement>("#presets button").forEach((b) => {
    const pressed = hasBpm ? Math.round(originalBpm! * Number(b.dataset.rate)) === Math.round(originalBpm! * rate) : Math.abs(Number(b.dataset.rate) - rate) < 0.004;
    b.setAttribute("aria-pressed", String(pressed));
  });
}

async function setRate(r: number) {
  // With a known BPM, snap to a whole practice BPM (e.g. 75% of 97 → 73 BPM).
  rate = clampRate(originalBpm ? Math.max(1, Math.round(originalBpm * r)) / originalBpm : r);
  renderTempo();
  save();
  await player?.setRate(rate);
}

function setTargetBpm(bpm: number) {
  if (!originalBpm || !Number.isFinite(bpm) || bpm <= 0) return;
  return setRate(bpm / originalBpm);
}

function setOriginalBpm(bpm: number | null) {
  if (bpm !== null && (!Number.isFinite(bpm) || bpm < 20 || bpm > 400)) return renderTempo();
  // Keep the practice BPM stable where possible when the reference changes.
  const target = originalBpm ? originalBpm * rate : null;
  originalBpm = bpm === null ? null : Math.round(bpm);
  if (target && originalBpm) rate = clampRate(Math.round(target) / originalBpm);
  player?.setRate(rate);
  setBpmStatus("");
  renderTempo();
  save();
}

for (const pct of [50, 60, 70, 75, 80, 90, 100]) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip";
  b.textContent = `${pct}%`;
  b.dataset.rate = String(pct / 100);
  b.addEventListener("click", () => setRate(pct / 100));
  $("presets").append(b);
}

speedRange.addEventListener("input", () => setRate(Number(speedRange.value) / 100));
targetInput.addEventListener("change", () => setTargetBpm(Number(targetInput.value)));
targetInput.addEventListener("blur", renderTempo);
origInput.addEventListener("change", () => setOriginalBpm(origInput.value === "" ? null : Number(origInput.value)));
origInput.addEventListener("blur", renderTempo);
$("targetDown").addEventListener("click", () => nudgeTarget(-1));
$("targetUp").addEventListener("click", () => nudgeTarget(1));
$("halfBtn").addEventListener("click", () => originalBpm && setOriginalBpm(originalBpm / 2));
$("doubleBtn").addEventListener("click", () => originalBpm && setOriginalBpm(originalBpm * 2));
$("tapBtn").addEventListener("click", tap);

function nudgeTarget(delta: number) {
  if (!originalBpm) return;
  // Step to the next whole BPM so that fractional values snap to integers.
  const current = originalBpm * rate;
  const next = delta > 0 ? Math.floor(current + 1e-6) + delta : Math.ceil(current - 1e-6) + delta;
  setTargetBpm(next);
}

function tap() {
  const bpm = tapper.tap(performance.now());
  if (bpm === null || tapper.count < 4) {
    setBpmStatus(t.tapping, "busy");
    if (bpm !== null) origInput.value = String(bpm);
    return;
  }
  setOriginalBpm(bpm);
  setBpmStatus(t.tapping, "busy");
}

// ---- pitch ---------------------------------------------------------------------
function renderPitch() {
  pitchOut.textContent = semitones > 0 ? `+${semitones}` : String(semitones);
}
async function setSemitones(s: number) {
  semitones = Math.max(-12, Math.min(12, s));
  renderPitch();
  await player?.setSemitones(semitones);
  save();
}
$("pitchDown").addEventListener("click", () => setSemitones(semitones - 1));
$("pitchUp").addEventListener("click", () => setSemitones(semitones + 1));

// ---- transport ------------------------------------------------------------------------
function updatePlayButton() {
  const playing = !!player?.playing;
  playBtn.classList.toggle("playing", playing);
  playBtn.title = playing ? t.pause : t.play;
  playBtn.setAttribute("aria-label", playBtn.title);
}

async function togglePlay() {
  if (!player?.duration) return;
  await player.toggle();
  updatePlayButton();
}

function seekBy(delta: number) {
  if (player) seekTo(player.position + delta);
}

function seekTo(time: number) {
  if (!player) return;
  // Jumping outside the active loop means the user wants to leave it.
  if (loop && loopEnabled && (time < loop.start - 0.01 || time > loop.end + 0.01)) {
    loopEnabled = false;
    applyLoop();
  }
  player.seek(time);
}

function goToStart() {
  seekTo(loop && loopEnabled ? loop.start : 0);
}

playBtn.addEventListener("click", togglePlay);
$("backBtn").addEventListener("click", () => seekBy(-5));
$("fwdBtn").addEventListener("click", () => seekBy(5));
$("startBtn").addEventListener("click", goToStart);

// ---- loop -----------------------------------------------------------------------------
async function applyLoop(persist = true) {
  waveform.setLoop(loop, loopEnabled);
  loopTimes.textContent = loop ? `A ${fmtPrecise(loop.start)} · B ${fmtPrecise(loop.end)}` : "";
  loopTimes.classList.toggle("off", !loopEnabled);
  zoomLoopBtn.disabled = !loop;
  loopBtn.setAttribute("aria-pressed", String(loopEnabled));
  loopBtn.disabled = !loop;
  $<HTMLButtonElement>("clearLoopBtn").disabled = !loop;
  if (persist) save();
  const p = player;
  if (!p) return;
  await p.setLoop(loop && loopEnabled ? loop : null);
  // Starting a loop from outside it would only reach it after a long wait: jump in.
  if (loop && loopEnabled && (p.position < loop.start || p.position >= loop.end)) await p.seek(loop.start);
}

function setLoopPoint(which: "start" | "end") {
  if (!player?.duration) return;
  const now = player.position;
  const other = which === "start" ? (loop?.end ?? player.duration) : (loop?.start ?? 0);
  let start = which === "start" ? now : other;
  let end = which === "end" ? now : other;
  if (end - start < 0.1) {
    // Point placed past the other one: restart the region from here.
    start = which === "start" ? now : Math.max(0, now - 4);
    end = which === "end" ? now : Math.min(player.duration, now + 4);
  }
  loop = { start, end };
  loopEnabled = true;
  applyLoop();
}

$("setABtn").addEventListener("click", () => setLoopPoint("start"));
$("setBBtn").addEventListener("click", () => setLoopPoint("end"));
loopBtn.addEventListener("click", () => {
  if (!loop) return;
  loopEnabled = !loopEnabled;
  applyLoop();
});
$("clearLoopBtn").addEventListener("click", () => {
  loop = null;
  loopEnabled = false;
  applyLoop();
});

// ---- open / drag & drop ------------------------------------------------------------------
$("openBtn").addEventListener("click", () => fileInput.click());
$("chooseBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) openFile(f);
  fileInput.value = "";
});

const overlay = $("dropOverlay");

if (isTauri()) {
  // Desktop app: use Tauri's native drag-and-drop, which works the same on every OS
  // (HTML5 drops from the Linux file manager often carry no readable File).
  getCurrentWebview().onDragDropEvent(async (e) => {
    const ev = e.payload;
    if (ev.type === "over") return;
    overlay.hidden = ev.type !== "enter";
    if (ev.type !== "drop" || !ev.paths.length) return;
    const path = ev.paths[0];
    const name = path.split(/[\\/]/).pop() || path;
    try {
      const data = await invoke<ArrayBuffer>("read_audio_file", { path });
      openFile(new File([data], name));
    } catch (err) {
      console.error(err);
      dropStatus.textContent = t.error;
      dropStatus.classList.add("error");
      dropSection.hidden = false;
      playerSection.hidden = true;
    }
  });
} else {
  // Browser (development): standard HTML5 drag-and-drop.
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    dragDepth++;
    overlay.hidden = false;
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.hidden = true;
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const f = e.dataTransfer?.files[0];
    if (f) openFile(f);
  });
}

// ---- keyboard ---------------------------------------------------------------------------
window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || playerSection.hidden) return;
  const target = e.target as HTMLElement;
  const typing = target.tagName === "INPUT" && !["range", "checkbox"].includes((target as HTMLInputElement).type);
  if (typing) {
    if (e.key === "Enter") target.blur();
    return;
  }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const actions: Record<string, () => void> = {
    " ": togglePlay,
    ArrowLeft: () => seekBy(-5),
    ArrowRight: () => seekBy(5),
    ArrowUp: () => nudgeTarget(1),
    ArrowDown: () => nudgeTarget(-1),
    a: () => setLoopPoint("start"),
    b: () => setLoopPoint("end"),
    l: () => loopBtn.click(),
    "+": () => waveform.zoomBy(2),
    "=": () => waveform.zoomBy(2),
    "-": () => waveform.zoomBy(0.5),
    "0": () => waveform.fit(),
    t: tap,
    Home: goToStart,
  };
  // Leave arrows to sliders that have focus.
  if (target.tagName === "INPUT" && key.startsWith("Arrow")) return;
  const action = actions[key];
  if (!action) return;
  e.preventDefault();
  action();
});

// ---- init -------------------------------------------------------------------------------
waveform = new Waveform($<HTMLCanvasElement>("wave"), {
  onSeek: seekTo,
  onLoopChange: (l) => {
    loop = l;
    loopEnabled = !!l;
    applyLoop();
  },
  onViewChange: renderView,
});

// ---- zoom -------------------------------------------------------------------------------
function renderView(start: number, span: number) {
  const duration = player?.duration ?? 0;
  const zoomed = duration > 0 && span < duration - 1e-6;
  waveScroll.hidden = !zoomed;
  if (zoomed) {
    waveThumb.style.left = `${(start / duration) * 100}%`;
    waveThumb.style.width = `${(span / duration) * 100}%`;
  }
  $<HTMLButtonElement>("zoomOutBtn").disabled = !zoomed;
  $<HTMLButtonElement>("zoomFitBtn").disabled = !zoomed;
  $<HTMLButtonElement>("zoomInBtn").disabled = !duration || span <= waveform.minSpan + 1e-6;
}

$("zoomInBtn").addEventListener("click", () => waveform.zoomBy(2));
$("zoomOutBtn").addEventListener("click", () => waveform.zoomBy(0.5));
$("zoomFitBtn").addEventListener("click", () => waveform.fit());
zoomLoopBtn.addEventListener("click", () => loop && waveform.zoomTo(loop.start, loop.end));

// Scrollbar under the zoomed waveform: drag the thumb, or click the track to jump there.
let thumbGrab: number | null = null; // pointer offset inside the thumb, as a fraction of the track
waveScroll.addEventListener("pointerdown", (e) => {
  const track = waveScroll.getBoundingClientRect();
  const thumb = waveThumb.getBoundingClientRect();
  const onThumb = e.clientX >= thumb.left && e.clientX <= thumb.right;
  thumbGrab = onThumb ? (e.clientX - thumb.left) / track.width : thumb.width / track.width / 2;
  waveScroll.setPointerCapture(e.pointerId);
  scrollToPointer(e.clientX);
});
waveScroll.addEventListener("pointermove", (e) => thumbGrab !== null && scrollToPointer(e.clientX));
waveScroll.addEventListener("pointerup", () => (thumbGrab = null));
waveScroll.addEventListener("pointercancel", () => (thumbGrab = null));
function scrollToPointer(clientX: number) {
  const track = waveScroll.getBoundingClientRect();
  const frac = (clientX - track.left) / track.width - (thumbGrab ?? 0);
  waveform.scrollTo(frac * (player?.duration ?? 0));
}
applyLoop(false);
initUpdates();
