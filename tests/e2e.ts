// End-to-end test of the built web app in Chromium (≈ WebView2 on Windows) and WebKit
// (≈ WKWebView on macOS), served with the same CSP as the Tauri app.
// Run with: npm run test:e2e   (first time: npx playwright install chromium webkit)

import { chromium, webkit, type Page } from "playwright";
import { preview } from "vite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { drumTrack, encodeWav, sineTone } from "./synth.ts";

const dir = mkdtempSync(join(tmpdir(), "tempo-trainer-"));
const drums = join(dir, "drums96.wav");
const tone = join(dir, "tone440.wav");
writeFileSync(drums, encodeWav(drumTrack(96, 30)));
writeFileSync(tone, encodeWav(sineTone(440, 12)));

const csp = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).app.security.csp;
const server = await preview({ preview: { port: 4174, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4174/";

const position = (page: Page) =>
  page.evaluate(() => {
    const [m, s] = document.querySelector("#cur")!.textContent!.split(":");
    return Number(m) * 60 + Number(s);
  });

let failed = false;
for (const engine of [chromium, webkit]) {
  const name = engine.name();
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route(url, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": csp } });
  });

  try {
    await page.goto(url);
    await page.setInputFiles("#fileInput", drums);
    await page.waitForFunction(() => (document.querySelector("#origInput") as HTMLInputElement).value !== "", null, { timeout: 20000 });
    assert.equal(await page.inputValue("#origInput"), "96", "detected BPM");

    await page.click("#playBtn");
    await page.waitForTimeout(2000);
    const p100 = await position(page);
    assert.ok(p100 > 1.5 && p100 < 2.5, `plays at normal speed (at ${p100}s after 2s)`);

    await page.click("#presets button:has-text('50%')");
    assert.equal(await page.inputValue("#targetInput"), "48", "practice BPM at 50%");
    const a = await position(page);
    await page.waitForTimeout(2000);
    const slow = (await position(page)) - a;
    assert.ok(slow > 0.7 && slow < 1.3, `plays at half speed (advanced ${slow}s in 2s)`);

    // Drag a loop over 40%–50% of the waveform (12 s – 15 s) and check playback stays in it.
    const box = (await page.locator("#wave").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.click("#presets button:has-text('100%')");
    assert.equal(await page.getAttribute("#loopBtn", "aria-pressed"), "true", "loop enabled after drag");
    const samples: number[] = [];
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(400);
      samples.push(await position(page));
    }
    assert.ok(Math.min(...samples) >= 11.9 && Math.max(...samples) <= 15.1, `loop stays in 12–15 s (${samples.join(", ")})`);
    assert.ok(samples.some((s, i) => i > 0 && s < samples[i - 1]), "loop wraps around");

    // Keyboard: space pauses, arrow down lowers the practice BPM.
    await page.locator("body").press("Space");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.inputValue("#targetInput"), "95", "arrow down: -1 BPM");
    const q = await position(page);
    await page.waitForTimeout(800);
    assert.equal(await position(page), q, "paused");

    // Settings are remembered per file.
    await page.reload();
    await page.setInputFiles("#fileInput", drums);
    await page.waitForFunction(() => (document.querySelector("#targetInput") as HTMLInputElement).value !== "");
    assert.equal(await page.inputValue("#targetInput"), "95", "remembers practice BPM");

    // Pitch: a 440 Hz tone at 50% speed must still sound at 440 Hz.
    await page.setInputFiles("#fileInput", tone);
    await page.waitForFunction(() => document.querySelector("#dur")!.textContent === "0:12");
    await page.click("#presets button:has-text('50%')");
    await page.click("#playBtn");
    await page.waitForTimeout(1500);
    const peakHz = await page.evaluate(async () => {
      const pl = (window as any).__player;
      const an = pl.ctx.createAnalyser();
      an.fftSize = 32768;
      pl.node.connect(an);
      await new Promise((r) => setTimeout(r, 1200));
      const bins = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(bins);
      let best = 1;
      for (let i = 1; i < bins.length; i++) if (bins[i] > bins[best]) best = i;
      return (best * pl.ctx.sampleRate) / an.fftSize;
    });
    assert.ok(Math.abs(peakHz - 440) < 3, `pitch preserved at 50% (peak ${peakHz.toFixed(1)} Hz)`);

    assert.deepEqual(errors, [], "no page errors");
    console.log(`ok ${name}`);
  } catch (err) {
    failed = true;
    console.error(`not ok ${name}: ${(err as Error).message}`);
    if (errors.length) console.error(errors);
  }
  await browser.close();
}
await server.close();
process.exit(failed ? 1 : 0);
