#!/usr/bin/env node
/**
 * Evidence for the Studio live view's Activity log (components/studio-live/ActivityPanel.tsx) against the stand-in Supabase
 * (state `live_run`: a film mid-run with twelve film_events rows, one a word with no sentence, two `segment_claimed` rows whose
 * detail names a worker host). The log is drawn from those rows only; the worker's host name must never reach the page.
 *
 *   PORT=54399 node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399 NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key \
 *     npx next build && NIGHTSHIFT_FILM_STUDIO=on npx next start -p 3417 &
 *   node tools/visual-qa/studio-live.mjs --base http://localhost:3417 --out /tmp/studio-live-shots
 *
 * Fails (exit 1) on horizontal page overflow, a page error, a missing log, the worker host name anywhere in the page, a line marked
 * new on the first reading (a load must replay nothing), or prose under 13px. Reads and screenshots only; the fake refuses writes.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionCookie } from "./fake-supabase.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..", "..", "command-center");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BASE = String(arg("base", "http://localhost:3417")).replace(/\/$/, "");
const FAKE = String(arg("fake", "http://127.0.0.1:54399"));
const OUT = path.resolve(String(arg("out", "/tmp/studio-live-shots")));
const FILM = "0f000000-0000-4000-8000-00000000000f";
const SLUG = "night-owl";
// The fake's segment_claimed detail.worker (fake-supabase.mjs, LIVE_WORKER). Its pieces are checked too: a host name cut to its
// first label is still the host name.
const WORKER = "film-worker-qa-host-7.internal";

function loadPlaywright() {
  const roots = [APP];
  try {
    roots.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim());
  } catch {
    /* local only */
  }
  for (const root of roots) {
    try {
      return createRequire(path.join(root, "noop.js"))("playwright");
    } catch {
      /* next */
    }
  }
  throw new Error("Playwright not found.");
}
const { chromium } = loadPlaywright();
const exe = (() => {
  try {
    return statSync("/opt/pw-browsers/chromium").isFile() ? "/opt/pw-browsers/chromium" : undefined;
  } catch {
    return undefined;
  }
})();

const URL_ = `/${SLUG}/studio?view=live&film=${FILM}`;
const VIEWS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
const THEMES = ["dark", "light"];
const LOCALES = ["en", "ru", "uz"];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const bad = [];
const lines = [];
for (const v of VIEWS)
  for (const theme of THEMES)
    for (const locale of LOCALES) {
      const phone = v.width < 600;
      const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, colorScheme: theme, isMobile: phone, hasTouch: phone, deviceScaleFactor: 1 });
      await ctx.addCookies([{ name: "chronos_locale", value: locale, url: BASE }, { ...sessionCookie(FAKE, "live_run"), url: BASE }]);
      // The app's theme is the stored choice (lib/theme.ts, default dark), not the system's: store it before the first paint.
      await ctx.addInitScript((t) => localStorage.setItem("chronos_theme", t), theme);
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(`${BASE}${URL_}`, { waitUntil: "load", timeout: 120000 });
      const found = await page.waitForSelector("[data-testid=live-activity] .lv-log", { timeout: 30000 }).then(() => true, () => false);
      await page.waitForTimeout(800);
      const m = await page.evaluate((worker) => {
        const panel = document.querySelector("[data-testid=live-activity]");
        const list = panel?.querySelector("ol");
        const rows = [...document.querySelectorAll("[data-testid=live-activity-item]")];
        const px = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : null);
        const text = document.body.innerText;
        const html = document.documentElement.outerHTML;
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          listOverflow: list ? list.scrollWidth - list.clientWidth : null,
          listFocusable: list?.getAttribute("tabindex") === "0",
          rows: rows.length,
          tags: rows.map((r) => r.querySelector("[data-testid=live-activity-tag] [aria-hidden]")?.textContent ?? "").join(" "),
          fresh: document.querySelectorAll("[data-testid=live-activity] .is-new").length,
          unknownCode: rows.some((r) => r.getAttribute("data-word") === "lease_extended" && r.querySelector("code")?.textContent === "lease_extended"),
          worker: text.includes(worker) || html.includes(worker) || text.includes(worker.split(".")[0]) || html.includes(worker.split(".")[0]),
          sentencePx: Math.min(...rows.map((r) => px(r.querySelector(".lv-log-text")) ?? 99)),
          timePx: Math.min(...rows.map((r) => px(r.querySelector("time")) ?? 99)),
          tagPx: px(rows[0]?.querySelector("[data-testid=live-activity-tag]")),
          panelBg: panel ? getComputedStyle(panel).backgroundColor : null,
        };
      }, WORKER);
      const base = `live-${v.width}-${theme}-${locale}`;
      await page.screenshot({ path: path.join(OUT, `${base}.png`), fullPage: true });
      if (found) {
        const panel = page.locator("[data-testid=live-activity]");
        await panel.scrollIntoViewIfNeeded();
        await panel.screenshot({ path: path.join(OUT, `activity-${v.width}-${theme}-${locale}.png`) });
      }
      lines.push(
        `${base}  overflow=${m.overflow}  list-overflow=${m.listOverflow}  rows=${m.rows}  fresh=${m.fresh}  worker=${m.worker}  ` +
          `px(sentence/time/tag)=${m.sentencePx}/${m.timePx}/${m.tagPx}  bg=${m.panelBg}  tags="${m.tags}"`,
      );
      if (!found) bad.push(`${base}: the Activity log did not render`);
      if (m.overflow > 0) bad.push(`${base}: ${m.overflow}px sideways`);
      if (m.listOverflow !== null && m.listOverflow > 0) bad.push(`${base}: the log is ${m.listOverflow}px wider than its panel`);
      if (!m.listFocusable) bad.push(`${base}: the log list is not keyboard focusable`);
      if (m.worker) bad.push(`${base}: the worker's host name is in the page`);
      if (m.fresh > 0) bad.push(`${base}: ${m.fresh} line(s) marked new on the first reading`);
      if (found && m.rows !== 13) bad.push(`${base}: ${m.rows} lines, the fake recorded 13 rows`);
      if (found && !m.unknownCode) bad.push(`${base}: the unknown word did not show as its code`);
      if (found && (m.sentencePx < 13 || m.timePx < 13)) bad.push(`${base}: prose under 13px`);
      for (const e of errors) bad.push(`${base}: ${e}`);
      await ctx.close();
    }
await browser.close();
process.stdout.write(lines.join("\n") + "\n");
if (bad.length) {
  process.stdout.write(`\nFAILED\n${bad.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`\nok: ${lines.length} views in ${OUT}\n`);
