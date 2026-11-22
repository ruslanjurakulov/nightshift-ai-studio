#!/usr/bin/env node
/**
 * Evidence for the lane under a live film (components/studio-live/LiveLane.tsx) against the stand-in Supabase's `live_lane` state:
 * a film whose reading advances one step per read (queued → two clips landed → more plus the narration → assembly running →
 * master ready), in 0166/0171/0198's shapes.
 *
 *   PORT=54461 node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54461 NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key \
 *     npx next build && NIGHTSHIFT_FILM_STUDIO=on npx next start -p 3461 &
 *   node tools/visual-qa/studio-live-lane.mjs --base http://localhost:3461 --fake http://127.0.0.1:54461 --out /tmp/lane-shots
 *
 * Two parts:
 * 1. A real run (en, dark, 1440): one session, the page left to poll, every step screenshotted. The first reading flies nothing;
 *    a step where pieces landed flies them; a reload in the middle flies nothing.
 * 2. Every step pinned (the session's `ls` claim) at 1440 and 390, dark and light, en/ru/uz; and a pinned reload that must restore
 *    the same lane with zero flights.
 * Fails (exit 1) on horizontal page overflow, a page error, the worker's host name in the page, a pill whose "?" and length basis
 * disagree, a planned pill that does not say so, a download before the master is ready, or a reload that replays a landing.
 * Reads and screenshots only; the fake refuses writes.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANE_WORKER, sessionCookie } from "./fake-supabase.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..", "..", "command-center");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BASE = String(arg("base", "http://localhost:3461")).replace(/\/$/, "");
const FAKE = String(arg("fake", "http://127.0.0.1:54461"));
const OUT = path.resolve(String(arg("out", "/tmp/lane-shots")));
const FILM = "0f000000-0000-4000-8000-00000000000f";
const URL_ = `/night-owl/studio?view=live&film=${FILM}`;
const PLAN_WORD = { en: "plan", ru: "план", uz: "reja" };

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

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const bad = [];
const lines = [];

async function open({ width, height, theme, locale, claims }) {
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, isMobile: phone, hasTouch: phone, deviceScaleFactor: 1 });
  await ctx.addCookies([{ name: "chronos_locale", value: locale, url: BASE }, { ...sessionCookie(FAKE, "live_lane", 0, claims), url: BASE }]);
  await ctx.addInitScript((t) => {
    localStorage.setItem("chronos_theme", t);
    // Every flight tag the strip portals in, counted as it appears (they remove themselves when their animation ends).
    window.__flights = [];
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n instanceof HTMLElement) for (const f of [n, ...n.querySelectorAll(".cv-fly")]) if (f.classList?.contains("cv-fly")) window.__flights.push(f.textContent);
    }).observe(document, { childList: true, subtree: true });
  }, theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, errors, phone };
}

/** The lane as the page shows it, and every check that does not depend on the step. */
async function measure(page, locale) {
  return page.evaluate(([worker, plan]) => {
    const pills = [...document.querySelectorAll("[data-testid=live-lane-strip] [data-lane-seg]")].map((el) => ({
      id: el.dataset.laneSeg,
      basis: el.dataset.length,
      made: el.className.includes("is-made"),
      len: el.querySelector(".cv-pill-len")?.textContent ?? "",
    }));
    const html = document.documentElement.outerHTML;
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      made: document.querySelector("[data-testid=live-lane-made]")?.textContent ?? null,
      status: document.querySelector("[data-testid=live-lane-status]")?.getAttribute("data-status") ?? null,
      clock: document.querySelector("[data-testid=live-lane-clock]")?.textContent ?? null,
      master: document.querySelector("[data-testid=lane-master]")?.getAttribute("data-status") ?? null,
      download: !!document.querySelector("[data-testid=live-lane-download]"),
      pills,
      // A "?" exactly where nobody knows the length; "plan" exactly where the length is the plan's.
      qMismatch: pills.filter((p) => (p.len.trim() === "?") !== (p.basis === "unknown")).map((p) => p.id),
      planMismatch: pills.filter((p) => (p.basis === "planned") !== p.len.includes(plan) || (p.basis === "planned" && p.len.includes("~"))).map((p) => p.id),
      worker: html.includes(worker) || html.includes(worker.split(".")[0]),
      flights: window.__flights.length,
      fresh: document.querySelectorAll("[data-testid=live-lane-strip] .is-new").length,
      smallText: [...document.querySelectorAll("[data-testid=live-lane] .ll-transport *, [data-testid=lane-master] *")]
        .filter((el) => el.childElementCount === 0 && el.textContent.trim() && !el.closest(".sr-only") && parseFloat(getComputedStyle(el).fontSize) < 13 && !el.classList.contains("cv-pill-len"))
        .map((el) => el.textContent.trim().slice(0, 20)),
    };
  }, [LANE_WORKER, PLAN_WORD[locale]]);
}
const signature = (m) => JSON.stringify(m.pills.map((p) => [p.id, p.basis, p.made]));

function check(base, m, errors, expect) {
  if (m.overflow > 0) bad.push(`${base}: ${m.overflow}px sideways`);
  if (m.worker) bad.push(`${base}: the worker's host name is in the page`);
  if (m.qMismatch.length) bad.push(`${base}: "?" and length basis disagree on ${m.qMismatch.join(",")}`);
  if (m.planMismatch.length) bad.push(`${base}: a planned length that does not say so on ${m.planMismatch.join(",")}`);
  if (m.download && m.master !== "ok") bad.push(`${base}: a download while the master is ${m.master}`);
  if (m.smallText.length) bad.push(`${base}: text under 13px: ${m.smallText.join(" | ")}`);
  if (expect?.step && expect.step >= 5 && !m.download) bad.push(`${base}: the ready master offers no download`);
  for (const e of errors) bad.push(`${base}: ${e}`);
}

async function openLane(page, phone) {
  await page.waitForSelector("[data-testid=live-lane-transport]", { timeout: 30000 });
  // The phone's strip starts closed: open it so its pills are on screen (a person's tap; nothing is written).
  if (phone && (await page.getAttribute("[data-testid=live-lane-strip]", "data-open")) === "false") await page.click("[data-testid=live-lane-strip] [data-testid=lane-toggle]");
  await page.waitForTimeout(700);
}

// ── 1. A real run: the page polls, the fake advances one step per read ──────────────────────────────────────────────────────
{
  const run = `run-${Date.now()}`;
  const { ctx, page, errors } = await open({ width: 1440, height: 900, theme: "dark", locale: "en", claims: { lr: run } });
  await page.goto(`${BASE}${URL_}`, { waitUntil: "load", timeout: 120000 });
  await openLane(page, false);
  let m = await measure(page, "en");
  const seen = [m.made];
  await page.screenshot({ path: path.join(OUT, `run-1-${m.status}.png`), fullPage: true });
  lines.push(`run step 1  status=${m.status} made="${m.made}" clock="${m.clock}" flights=${m.flights} fresh=${m.fresh}`);
  if (m.flights > 0 || m.fresh > 0) bad.push(`run step 1: the first reading flew ${m.flights} tag(s), ${m.fresh} pill(s) new`);
  check("run-1", m, errors);
  for (let step = 2; step <= 5; step++) {
    const before = m.flights;
    // The next reading: a piece more made, or the master's state moved on (the fake answers every ~6 s poll with the next step).
    await page
      .waitForFunction(
        ([made, master]) =>
          document.querySelector("[data-testid=live-lane-made]")?.textContent !== made || (document.querySelector("[data-testid=lane-master]")?.getAttribute("data-status") ?? null) !== master,
        [seen[seen.length - 1], m.master],
        { timeout: 20000 },
      )
      .catch(() => bad.push(`run step ${step}: the next reading never arrived`));
    await page.waitForTimeout(1600);
    m = await measure(page, "en");
    seen.push(m.made);
    await page.screenshot({ path: path.join(OUT, `run-${step}-${m.status}.png`), fullPage: true });
    lines.push(`run step ${step}  status=${m.status} made="${m.made}" clock="${m.clock}" master=${m.master} flights=${m.flights} (+${m.flights - before}) download=${m.download}`);
    check(`run-${step}`, m, errors, { step });
    // Pieces landed at steps 2 and 3 (clips, then a shot, a clip and the narration): those readings fly them.
    if ((step === 2 || step === 3) && m.flights === before) bad.push(`run step ${step}: pieces landed and nothing flew`);
    if (step === 3) {
      // A reload in the middle: the next reading restores the lane, and nothing flies.
      await page.reload({ waitUntil: "load" });
      await openLane(page, false);
      const r = await measure(page, "en");
      lines.push(`run reload  status=${r.status} made="${r.made}" flights=${r.flights} fresh=${r.fresh}`);
      if (r.flights > 0 || r.fresh > 0) bad.push(`run reload: ${r.flights} flight(s), ${r.fresh} new pill(s) after a reload`);
      check("run-reload", r, errors);
      m = r;
      seen.push(r.made);
      step++; // the reload's read was the next step
      await page.screenshot({ path: path.join(OUT, `run-${step}-after-reload.png`), fullPage: true });
    }
  }
  await ctx.close();
}

// ── 2. Every step pinned, at both widths, both themes, three languages ───────────────────────────────────────────────────
const VIEWS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
for (let step = 1; step <= 5; step++)
  for (const v of VIEWS)
    for (const theme of ["dark", "light"])
      for (const locale of ["en", "ru", "uz"]) {
        const { ctx, page, errors, phone } = await open({ ...v, theme, locale, claims: { ls: step } });
        await page.goto(`${BASE}${URL_}`, { waitUntil: "load", timeout: 120000 });
        await openLane(page, phone);
        const m = await measure(page, locale);
        const base = `step${step}-${v.width}-${theme}-${locale}`;
        await page.screenshot({ path: path.join(OUT, `${base}.png`), fullPage: true });
        const lane = page.locator("[data-testid=live-lane]");
        await lane.scrollIntoViewIfNeeded();
        await lane.screenshot({ path: path.join(OUT, `lane-${base}.png`) });
        lines.push(`${base}  overflow=${m.overflow} made="${m.made}" master=${m.master} download=${m.download} pills=${m.pills.map((p) => p.basis[0]).join("")} flights=${m.flights}`);
        check(base, m, errors, { step });
        if (m.flights > 0) bad.push(`${base}: a first reading flew ${m.flights} tag(s)`);
        await ctx.close();
      }

// ── a pinned reload restores the same lane, and flies nothing ────────────────────────────────────────────────────────────
{
  const { ctx, page, errors } = await open({ width: 1440, height: 900, theme: "dark", locale: "en", claims: { ls: 3 } });
  await page.goto(`${BASE}${URL_}`, { waitUntil: "load", timeout: 120000 });
  await openLane(page, false);
  await page.waitForTimeout(1500);
  const a = await measure(page, "en");
  await page.reload({ waitUntil: "load" });
  await openLane(page, false);
  await page.waitForTimeout(1500);
  const b = await measure(page, "en");
  lines.push(`pinned reload  same=${signature(a) === signature(b)} flights=${b.flights} fresh=${b.fresh}`);
  if (signature(a) !== signature(b)) bad.push(`pinned reload: the lane changed (${signature(a)} → ${signature(b)})`);
  if (b.flights > 0 || b.fresh > 0) bad.push(`pinned reload: ${b.flights} flight(s), ${b.fresh} new pill(s)`);
  check("pinned-reload", b, errors);
  await ctx.close();
}

await browser.close();
process.stdout.write(lines.join("\n") + "\n");
if (bad.length) {
  process.stdout.write(`\nFAILED\n${bad.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`\nok: ${lines.length} checks, screenshots in ${OUT}\n`);
