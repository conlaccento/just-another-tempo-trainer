import "@fontsource/jost/latin-400.css";
import "@fontsource/jost/latin-500.css";
import "@fontsource/jost/latin-700.css";
import "./style.css";
import { lang, t, type Strings } from "./i18n.ts";
import { Player } from "./player.ts";
import { Waveform } from "./waveform.ts";
import { TapTempo } from "./tap.ts";
import type { BpmResult } from "./bpm.ts";

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
const pitchOut = $("pitchOut");

// ---- state --------------------------------------------------------------------------
const MIN_RATE = 0.25;
const MAX_RATE = 1.5;

let player: Player | null = null;
let waveform: Waveform;
let fileKey = "";
let originalBpm: number | null = null;
let rate = 1;
let semitones = 0;
let loadToken = 0;
const tapper = new TapTempo();

interface Saved {
  originalBpm?: number | null;
  rate?: number;
  semitones?: number;
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
    localStorage.setItem(fileKey, JSON.stringify({ originalBpm, rate, semitones } satisfies Saved));
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
    document.title = `${file.name} — Tempo Trainer`;
    dur.textContent = fmt(buffer.duration, false);
    dropSection.hidden = true;
    playerSection.hidden = false;
    dropStatus.textContent = "";

    waveform.setBuffer(buffer);
    originalBpm = saved.originalBpm ? Math.round(saved.originalBpm) : null;
    rate = clampRate(saved.rate ?? 1);
    semitones = saved.semitones ?? 0;
    await p.setRate(rate);
    await p.setSemitones(semitones);
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

const seekTo = (time: number) => player?.seek(time);
const seekBy = (delta: number) => player && seekTo(player.position + delta);
const goToStart = () => seekTo(0);

playBtn.addEventListener("click", togglePlay);
$("backBtn").addEventListener("click", () => seekBy(-5));
$("fwdBtn").addEventListener("click", () => seekBy(5));
$("startBtn").addEventListener("click", goToStart);

// ---- open / drag & drop ------------------------------------------------------------------
$("openBtn").addEventListener("click", () => fileInput.click());
$("chooseBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) openFile(f);
  fileInput.value = "";
});

const overlay = $("dropOverlay");
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
waveform = new Waveform($<HTMLCanvasElement>("wave"), seekTo);
