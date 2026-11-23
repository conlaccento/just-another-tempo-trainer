# Just another Tempo Trainer

Tauri v2 desktop app (vanilla TS + Vite, no framework): detects a song's BPM and plays it at a chosen BPM with pitch preserved (Signalsmith Stretch, WASM AudioWorklet). Listening only, no export.

## Commands
- `export PATH="$HOME/.cargo/bin:$PATH"` - needed before any Tauri/cargo command (rustup installed without modifying PATH)
- `cd src-tauri && cargo test` - Rust tests (file reading command)
- `npm test` - unit tests via Node's native TS stripping (`node --test tests/*.test.ts`)
- `npm run test:e2e` - builds, then Playwright on Chromium (≈ WebView2) + WebKit (≈ WKWebView) with the Tauri CSP injected
- `npm run tauri build -- --bundles app` - local macOS build; the `.dmg` step fails here (Finder AppleEvent timeout), CI builds the dmg
- Release: bump version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, then push a `vX.Y.Z` tag → draft release for macOS (arm64 + x64), Windows, Linux; publish it with `gh release edit vX.Y.Z --draft=false`

## Gotchas
- `signalsmith-stretch` serialises its functions with `toString()` into a worklet Blob: never let Vite transform it. It's served raw by the `rawSignalsmith()` plugin in `vite.config.ts` and loaded with dynamic `import()`
- The stretch node needs `numberOfInputs: 1`; with 0 inputs `process()` throws while paused and the node dies
- Files imported by unit tests can't use TS parameter properties or other non-erasable syntax (Node strip-only mode)
- Drag-and-drop in the desktop app is Tauri's native one (`onDragDropEvent` → `read_audio_file` command in `src-tauri/src/lib.rs`): HTML5 drops from the Linux file manager carry no readable File. The HTML5 handler is only for the browser dev mode
- BPM values are always integers (detection, tap, practice BPM snapping in `setRate`)
- Release asset names are version-free (`assetNamePattern` in release.yml) because the README links to `releases/latest/download/JustAnotherTempoTrainer_<os>_<arch>.<ext>`; keep them in sync
- Style is Bauhaus, shared with the sibling `../dettato-ritmico-app`: Jost, paper bg, red/yellow/blue tokens in `src/style.css`, square corners
- UI texts live in `src/i18n.ts` (English + Italian); add both
