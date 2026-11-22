import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const STRETCH_URL = "vendor/signalsmith-stretch.mjs";

// signalsmith-stretch builds its AudioWorklet module by serialising its own functions
// with toString(). Any bundler transform (minification, syntax lowering that injects
// helpers such as _defineProperty) breaks that code inside the isolated worklet scope.
// So the library is shipped byte-for-byte as a static file and loaded at runtime.
function rawSignalsmith(): Plugin {
  const file = createRequire(import.meta.url).resolve("signalsmith-stretch").replace(/\.js$/, ".mjs");
  const source = () => readFileSync(file, "utf8");
  return {
    name: "raw-signalsmith-stretch",
    configureServer(server) {
      server.middlewares.use(`/${STRETCH_URL}`, (_req, res) => {
        res.setHeader("Content-Type", "text/javascript");
        res.end(source());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: STRETCH_URL, source: source() });
    },
  };
}

// Settings follow the Tauri v2 + Vite guide: fixed port, no screen clearing,
// and targets matching the system webviews (WebView2 on Windows, WebKit on macOS).
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  define: { __STRETCH_URL__: JSON.stringify(STRETCH_URL) },
  plugins: [rawSignalsmith()],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  worker: { format: "es" },
});
