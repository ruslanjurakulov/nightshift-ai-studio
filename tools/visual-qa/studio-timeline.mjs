#!/usr/bin/env node
/**
 * Evidence for Nightshift Studio's Timeline (components/studio-timeline) against the stand-in Supabase (state `timeline`: two scenes
 * shot, four drafts, a music file, no narration yet; `timeline_missing`: the projects migration not applied). One scene asks the
 * server for the price, so the Assemble key shows the fake backend's quote, never a number the page made up.
 *
 *   PORT=54399 node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399 NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key \
 *     npx next build && NIGHTSHIFT_FILM_STUDIO=on npx next start -p 3417 &
 *   node tools/visual-qa/studio-timeline.mjs --base http://localhost:3417 --out /tmp/studio-timeline-shots
 *
 * Fails (exit 1) on horizontal page overflow, a page error, or a missing landmark. Reads and screenshots only; the fake refuses writes.
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
const OUT = path.resolve(String(arg("out", "/tmp/studio-timeline-shots")));
const FILM = "0f000000-0000-4000-8000-00000000000f";
const SLUG = "night-owl";

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

const SCENES = [
  { name: "timeline", state: "timeline", url: `/${SLUG}/studio?view=timeline&film=${FILM}`, check: "[data-testid=lanes]", select: `[data-testid="clip-v1:50000000-0000-4000-8000-000000000000"]`, quote: true },
  { name: "timeline-unquoted", state: "timeline", url: `/${SLUG}/studio?view=timeline&film=${FILM}`, check: "[data-testid=lanes]", only: [1440] },
  { name: "timeline-pick", state: "timeline", url: `/${SLUG}/studio?view=timeline`, check: "[data-testid=timeline-pick]", only: [1440] },
  { name: "timeline-missing", state: "timeline_missing", url: `/${SLUG}/studio?view=timeline&film=${FILM}`, check: "[data-testid=timeline-missing]", only: [1440] },
];
const VIEWS = [
  { width: 1440, height: 900, theme: "dark" },
  { width: 1440, height: 900, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const bad = [];
const lines = [];
for (const v of VIEWS)
  for (const s of SCENES) {
    if (s.only && !s.only.includes(v.width)) continue;
    if (s.only && v.theme !== "dark") continue;
    const phone = v.width < 600;
    const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, colorScheme: v.theme, reducedMotion: "reduce", isMobile: phone, hasTouch: phone, deviceScaleFactor: 1 });
    await ctx.addCookies([{ name: "chronos_locale", value: "en", url: BASE }, { ...sessionCookie(FAKE, s.state), url: BASE }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${BASE}${s.url}`, { waitUntil: "load", timeout: 120000 });
    await page.waitForSelector(s.check, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    if (s.select && !phone) await page.click(s.select).catch((e) => errors.push(`select: ${e.message}`));
    if (s.quote) {
      await page.locator("[data-testid=assemble-key]:visible").first().click().catch((e) => errors.push(`quote: ${e.message}`));
      await page.waitForTimeout(1200);
    }
    const m = await page.evaluate((sel) => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      landmark: !!document.querySelector(sel),
      amount: [...document.querySelectorAll("[data-testid=assemble-amount]")].map((e) => e.textContent).join(" | "),
      drafts: document.querySelectorAll("[data-draft]").length,
    }), s.check);
    const name = `${s.name}-${v.width}-${v.theme}.png`;
    await page.screenshot({ path: path.join(OUT, name), fullPage: false });
    lines.push(`${name}  overflow=${m.overflow}  landmark=${m.landmark}  drafts=${m.drafts}  assemble="${m.amount}"`);
    if (m.overflow > 0) bad.push(`${name}: ${m.overflow}px sideways`);
    if (!m.landmark) bad.push(`${name}: ${s.check} missing`);
    for (const e of errors) bad.push(`${name}: ${e}`);
    await ctx.close();
  }
await browser.close();
process.stdout.write(lines.join("\n") + "\n");
if (bad.length) {
  process.stdout.write(`\nFAILED\n${bad.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`\nok: ${lines.length} pictures in ${OUT}\n`);
