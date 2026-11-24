// In-app updates for the desktop app (Tauri updater plugin). The update manifest is the
// latest.json attached to the latest published GitHub release; updates are signed with the
// project's key and verified against the public key in tauri.conf.json.

import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "./i18n.ts";

const RELEASES_URL = "https://github.com/conlaccento/just-another-tempo-trainer/releases/latest";
/** Quiet check shortly after start-up, so it never competes with opening a file. */
const STARTUP_CHECK_DELAY_MS = 4000;

const $ = (id: string) => document.getElementById(id)!;

export function initUpdates() {
  if (!isTauri()) return; // Browser (development): nothing to update.
  const footer = $("appFooter");
  const checkBtn = $("checkUpdatesBtn") as HTMLButtonElement;
  const status = $("updateStatus");
  const banner = $("updateBanner");
  const bannerText = $("updateText");
  const installBtn = $("installUpdateBtn") as HTMLButtonElement;
  const laterBtn = $("laterUpdateBtn") as HTMLButtonElement;
  let pending: Update | null = null;

  footer.hidden = false;
  getVersion().then((v) => ($("appVersion").textContent = t.version.replace("{v}", v)));

  async function run(manual: boolean) {
    checkBtn.disabled = true;
    if (manual) status.textContent = t.updateChecking;
    try {
      const update = await check();
      if (update) {
        pending = update;
        bannerText.textContent = t.updateAvailable.replace("{v}", update.version);
        banner.hidden = false;
        status.textContent = "";
      } else if (manual) {
        status.textContent = t.updateNone;
      }
    } catch (err) {
      console.error(err);
      // The automatic check stays silent: being offline is not worth a message.
      if (manual) status.textContent = t.updateCheckFailed;
    } finally {
      checkBtn.disabled = false;
    }
  }

  async function install() {
    if (!pending) return;
    installBtn.disabled = laterBtn.disabled = true;
    let total = 0, received = 0;
    try {
      await pending.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") received += e.data.chunkLength;
        const pct = total ? ` ${Math.min(100, Math.round((received / total) * 100))}%` : "";
        bannerText.textContent = e.event === "Finished" ? t.updateInstalling : `${t.updateDownloading}${pct}`;
      });
      bannerText.textContent = t.updateRestarting;
      await relaunch();
    } catch (err) {
      console.error(err);
      bannerText.textContent = t.updateFailed;
      installBtn.hidden = true;
      laterBtn.disabled = false;
      $("downloadUpdateBtn").hidden = false;
    }
  }

  checkBtn.addEventListener("click", () => run(true));
  installBtn.addEventListener("click", install);
  laterBtn.addEventListener("click", () => (banner.hidden = true));
  $("downloadUpdateBtn").addEventListener("click", () => openUrl(RELEASES_URL));
  setTimeout(() => run(false), STARTUP_CHECK_DELAY_MS);
}
