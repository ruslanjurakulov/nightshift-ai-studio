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
 * disagree, a planned pill that does not say so, a pill whose face is not its tag, more or fewer than one visible total, prose
 * under 13px or a label under 12px, pill text under 4.5:1 against its painted ground, a phone pill under 44px, a phone master not
 * on screen with the strip closed, a download before the master is ready, or a reload that replays a landing.
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
const ratioLines = [];
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
    // A colour as the page paints it: any CSS colour string through a canvas, so color-mix() and color(srgb …) resolve too.
    const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const rgba = (css) => {
      cv.clearRect(0, 0, 1, 1);
      cv.fillStyle = "rgba(0,0,0,0)";
      cv.fillStyle = css;
      cv.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = cv.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
    /** The element's background as painted: its own colour over its ancestors', down to the page (images ignored). */
    const ground = (el) => {
      const layers = [];
      for (let e = el; e; e = e.parentElement) {
        const c = rgba(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      let bg = [255, 255, 255, 1];
      if (layers.length && layers[layers.length - 1][3] >= 1) bg = layers.pop();
      for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
      return bg;
    };
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (el) => {
      const bg = ground(el);
      const fg = over(rgba(getComputedStyle(el).color), bg);
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    };
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && !el.closest(".sr-only");
    };
    const pills = [...document.querySelectorAll("[data-testid=live-lane-strip] [data-lane-seg]")].map((el) => ({
      id: el.dataset.laneSeg,
      basis: el.dataset.length,
      made: el.className.includes("is-made"),
      len: el.querySelector(".cv-pill-len")?.textContent ?? "",
      face: el.querySelector(".cv-pill-nm")?.textContent ?? "",
      // The tag must be whole on screen: a cut "clip-02…" hides the ".1" that tells two shots apart.
      cut: (() => {
        const nm = el.querySelector(".cv-pill-nm");
        return !!nm && nm.scrollWidth > nm.clientWidth + 1;
      })(),
      h: el.getBoundingClientRect().height,
    }));
    // Every visible text leaf in the lane: labels (mono capitals, lengths, ruler) may be 12px, prose never under 13.
    const LABEL = ".ds-t-label, .is-tag, .cv-pill-len, .cv-ruler i, .cv-lane-chip, .cv-lane-chip *, .cv-lane-plan, .ll-plan, .ll-tag, .cv-lane-unk, .cv-th-nm, .cv-th-badge *, .ll-tc *";
    const leaves = [...document.querySelectorAll("[data-testid=live-lane] *")].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && shown(el));
    const small = leaves
      .map((el) => ({ el, px: parseFloat(getComputedStyle(el).fontSize), label: el.matches(LABEL) }))
      .filter((x) => x.px < (x.label ? 12 : 13))
      .map((x) => `${x.el.textContent.trim().slice(0, 18)}@${x.px}`);
    const pillText = [...document.querySelectorAll("[data-testid=live-lane-strip] [data-lane-seg] :is(.cv-pill-nm, .cv-pill-len, .cv-pill-st)")].filter(shown);
    const ratios = pillText.map((el) => ({ text: el.textContent.trim().slice(0, 14), cls: el.className, r: Math.round(ratio(el) * 100) / 100, seg: el.closest("[data-lane-seg]").dataset.laneSeg }));
    const totals = [...document.querySelectorAll("[data-testid=lane-total], [data-testid=live-lane-total]")].filter(shown);
    const html = document.documentElement.outerHTML;
    const master = document.querySelector("[data-testid=lane-master]");
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      made: document.querySelector("[data-testid=live-lane-made]")?.textContent ?? null,
      status: document.querySelector("[data-testid=live-lane-status]")?.getAttribute("data-status") ?? null,
      clock: document.querySelector("[data-testid=live-lane-clock]")?.textContent ?? null,
      master: master?.getAttribute("data-status") ?? null,
      masterShown: !!master && shown(master),
      open: document.querySelector("[data-testid=live-lane-strip]")?.getAttribute("data-open") ?? null,
      download: !!document.querySelector("[data-testid=live-lane-download]"),
      pills,
      totals: totals.length,
        // A pill too narrow for "clip-" keeps the number (the track names the kind); never anything else.
      faceMismatch: pills.filter((p) => !/^((clip-)?\d\d(\.\d)?|voice)$/.test(p.face)).map((p) => `${p.id}=${p.face}`),
      qMismatch: pills.filter((p) => (p.len.trim() === "?") !== (p.basis === "unknown")).map((p) => p.id),
      planMismatch: pills.filter((p) => (p.basis === "planned") !== p.len.toLowerCase().includes(plan) || (p.basis === "planned" && p.len.includes("~"))).map((p) => p.id),
      worker: html.includes(worker) || html.includes(worker.split(".")[0]),
      flights: window.__flights.length,
      fresh: document.querySelectorAll("[data-testid=live-lane] .is-new").length,
      small,
      ratios,
      minRatio: ratios.length ? Math.min(...ratios.map((x) => x.r)) : null,
      pillMinH: pills.length ? Math.min(...pills.map((p) => p.h)) : null,
    };
  }, [LANE_WORKER, PLAN_WORD[locale]]);
}
const signature = (m) => JSON.stringify(m.pills.map((p) => [p.id, p.basis, p.made]));

function check(base, m, errors, expect) {
  if (m.overflow > 0) bad.push(`${base}: ${m.overflow}px sideways`);
  if (m.worker) bad.push(`${base}: the worker's host name is in the page`);
  if (m.qMismatch.length) bad.push(`${base}: "?" and length basis disagree on ${m.qMismatch.join(",")}`);
  if (m.planMismatch.length) bad.push(`${base}: a planned length that does not say so on ${m.planMismatch.join(",")}`);
  if (m.pills.some((p) => p.cut)) bad.push(`${base}: a tag is cut on its pill: ${m.pills.filter((p) => p.cut).map((p) => p.face).join(", ")}`);
  if (m.faceMismatch.length) bad.push(`${base}: a pill's face is not its tag: ${m.faceMismatch.join(", ")}`);
  if (m.totals !== 1) bad.push(`${base}: ${m.totals} visible totals (one only)`);
  if (m.download && m.master !== "ok") bad.push(`${base}: a download while the master is ${m.master}`);
  if (m.small.length) bad.push(`${base}: text under its floor: ${m.small.join(" | ")}`);
  if (m.minRatio !== null && m.minRatio < 4.5) bad.push(`${base}: pill text contrast ${m.minRatio} < 4.5 (${JSON.stringify(m.ratios.filter((x) => x.r < 4.5))})`);
  if (expect?.step && expect.step >= 5 && !m.download) bad.push(`${base}: the ready master offers no download`);
  if (expect?.touch && m.pillMinH !== null && m.pillMinH < 43.5) bad.push(`${base}: a pill is ${m.pillMinH}px high on touch, under 44`);
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
  { width: 360, height: 780 },
];
for (let step = 1; step <= 5; step++)
  for (const v of VIEWS)
    for (const theme of ["dark", "light"])
      for (const locale of ["en", "ru", "uz"]) {
        const { ctx, page, errors, phone } = await open({ ...v, theme, locale, claims: { ls: step } });
        await page.goto(`${BASE}${URL_}`, { waitUntil: "load", timeout: 120000 });
        const base = `step${step}-${v.width}-${theme}-${locale}`;
        if (phone) {
          // Before opening: the strip is closed and the master is still on screen.
          await page.waitForSelector("[data-testid=live-lane-transport]", { timeout: 30000 });
          await page.waitForTimeout(500);
          const closed = await measure(page, locale);
          await page.screenshot({ path: path.join(OUT, `${base}-closed.png`), fullPage: true });
          if (closed.open !== "false") bad.push(`${base}: the phone strip did not start closed`);
          if (!closed.masterShown) bad.push(`${base}: the master is not on screen with the strip closed`);
        }
        await openLane(page, phone);
        const m = await measure(page, locale);
        await page.screenshot({ path: path.join(OUT, `${base}.png`), fullPage: true });
        const lane = page.locator("[data-testid=live-lane]");
        await lane.scrollIntoViewIfNeeded();
        await lane.screenshot({ path: path.join(OUT, `lane-${base}.png`) });
        lines.push(`${base}  overflow=${m.overflow} made="${m.made}" master=${m.master} download=${m.download} pills=${m.pills.map((p) => p.basis[0]).join("")} faces=${m.pills.map((p) => p.face).join(",")} minContrast=${m.minRatio} pillMinH=${m.pillMinH} totals=${m.totals} flights=${m.flights}`);
        if (step === 3) ratioLines.push(`${base}  ${m.ratios.map((x) => `${x.seg}/${x.cls.replace("cv-pill-", "")}=${x.r}`).join(" ")}`);
        check(base, m, errors, { step, touch: phone });
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
process.stdout.write("\ncontrast at step 3 (pill text over its painted ground):\n" + ratioLines.join("\n") + "\n");
if (bad.length) {
  process.stdout.write(`\nFAILED\n${bad.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`\nok: ${lines.length} checks, screenshots in ${OUT}\n`);
