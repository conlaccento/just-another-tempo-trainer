# Just another Tempo Trainer

Slow a song down to practise it, without changing its pitch.

Open an MP3 (or WAV, FLAC, M4A, OGG). Just another Tempo Trainer detects its BPM, and you choose the tempo you want to practise at. It plays the song at that tempo straight away, in the original key.

> 🇮🇹 **In breve:** apri un brano, l'app ne rileva i BPM, scegli i BPM a cui vuoi esercitarti e lo ascolti rallentato senza che cambi la tonalità. L'interfaccia è in italiano se il sistema è in italiano.

## Features

- **BPM detection** on load. You can correct the result: ÷2 / ×2 fix half- or double-tempo readings, you can type the value in, or tap along with **Tap**.
- **Practice BPM**: type the target BPM, or use the speed slider (25–150 %) and the presets (50 %, 60 %, 70 %, 75 %, 80 %, 90 %, 100 %). The tempo changes live, during playback.
- **Pitch preserved**, using [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/), a high-quality time-stretching library.
- **Waveform**: click or drag on it to jump to any point of the song.
- **Transpose** ±12 semitones, for example to match a tuned-down guitar.
- **Per-song memory**: the app remembers the BPM, practice tempo and transposition for each file.
- Small (~3 MB) and works offline. No account, no tracking.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` `→` | Back / forward 5 s |
| `↑` `↓` | Practice BPM ±1 |
| `T` | Tap tempo |
| `Home` | Back to start |

## Download and install

Download the latest installer from the [Releases](../../releases) page.

The app is free and open source, so it is **not signed** with a paid Apple or Microsoft certificate. The system warns you the first time you open it:

**macOS** (`.dmg`; pick `aarch64` for Apple Silicon M1–M4, `x64` for Intel Macs)

1. Open the `.dmg` and drag **Just another Tempo Trainer** into **Applications**.
2. Open it once. macOS says it cannot verify the developer: click **Done**.
3. Go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.

Alternatively, in Terminal: `xattr -cr "/Applications/Just another Tempo Trainer.app"`

**Windows** (`.exe` installer, or `.msi`)

If SmartScreen shows "Windows protected your PC", click **More info → Run anyway**.

**Linux** (`.AppImage`, `.deb` or `.rpm`)

Make the AppImage executable (`chmod +x Tempo*.AppImage`) and run it, or install the `.deb` / `.rpm` package. The app needs WebKitGTK 4.1, plus the GStreamer plugins to decode MP3 (`gstreamer1.0-plugins-good` on Debian/Ubuntu). The Linux build is less tested than the macOS and Windows ones.

## How it works

- The whole app is a web page (TypeScript + Web Audio) running in [Tauri](https://tauri.app). It uses the system's own web engine (WebView2 on Windows, WebKit on macOS, WebKitGTK on Linux), which is why the installers are so small.
- **BPM detection** ([`src/bpm.ts`](src/bpm.ts)) runs in a Web Worker:
  1. It computes an onset-strength envelope: the spectral flux of log energy in ⅓-octave bands.
  2. It picks the tempo from the autocorrelation of that envelope, with a mild preference for the common 70–160 BPM range.
  3. It refines the value by fitting a beat grid over the whole song, then rounds it to a whole BPM.

  Detection works best on music with a steady beat. Rubato or live recordings may need a manual correction (Tap).
- **Time stretching** is done by Signalsmith Stretch (MIT licence), compiled to WebAssembly and running in an AudioWorklet. This keeps audio smooth when you change the tempo on the fly.

## Development

Requirements: [Node.js](https://nodejs.org) 22.18 or later, and [Rust](https://rustup.rs). On Windows and Linux you also need the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev      # run the desktop app with hot reload
npm run dev            # or just the web UI in a browser: http://localhost:1420
npm test               # unit tests (BPM detection, tap tempo)
npm run test:e2e       # browser tests in Chromium + WebKit
                       # (first time: npx playwright install chromium webkit)
npm run tauri build    # build the installer for the current OS
```

### Releasing

Update `version` in `package.json` and `src-tauri/tauri.conf.json`, then push a tag:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

GitHub Actions builds the macOS (Apple Silicon and Intel), Windows and Linux installers and attaches them to a **draft** release. Review the draft and publish it.

### Project layout

```
src/
  main.ts          UI wiring
  player.ts        playback, tempo, pitch (Signalsmith Stretch)
  bpm.ts           tempo detection (pure TS, also used by the unit tests)
  bpm.worker.ts    runs bpm.ts off the UI thread
  waveform.ts      waveform and playhead, click to seek
  tap.ts           tap tempo
  i18n.ts          English / Italian texts
src-tauri/         desktop shell (Tauri v2)
tests/             unit tests and browser e2e tests
```

## Licence

[MIT](LICENSE). Signalsmith Stretch is © Geraint Luff / Signalsmith Audio, MIT licence.
