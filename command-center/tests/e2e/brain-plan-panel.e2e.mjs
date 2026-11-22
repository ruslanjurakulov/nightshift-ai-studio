#!/usr/bin/env node
/**
 * Browser check for the Nightshift AI panel's plan step on the real Studio page (Probe on S1): the storyboard being written, a
 * failed plan with Retry, a plan priced past the workspace's credits (S2's Add credits), and a model-gate refusal (Confirm your
 * age), at 390, 768 and 1440 px in dark mode. At 390 the remedy keys must never sit under the canvas's fixed phone dock
 * (.cv-flow-dock): after scrolling each key into view, and with the page scrolled to its end, their boxes must not intersect.
 *
 * The app runs against the stand-in Supabase (tools/visual-qa/fake-supabase.mjs) for its signed-in shell; every /api/brain call
 * the panel makes is answered here by page.route, so nothing reaches a model, a database or a vendor and nothing is spent.
 *
 *   PORT=54399 node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399 NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key npx next build
 *   NIGHTSHIFT_AI_CHAT=on npx next start -p 3417 &
 *   node tests/e2e/brain-plan-panel.e2e.mjs --base http://localhost:3417 --out ../docs/studio/qa/s1-plan
 *
 * Uses the preinstalled Chromium (/opt/pw-browsers/chromium); never installs one. Exit 1 on any failed check. Not part of vitest
 * (its name does not end in .test.*).
 */
import { createRequire } from "node:module";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..", "..");
const REPO = path.resolve(APP, "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BASE = String(arg("base", "http://localhost:3417")).replace(/\/$/, "");
const FAKE = String(arg("fake", "http://127.0.0.1:54399"));
const OUT = path.resolve(String(arg("out", path.join(REPO, "docs/studio/qa/s1-plan"))));
const { chromium } = createRequire(path.join(APP, "noop.js"))("playwright");
const { sessionCookie } = await import(path.join(REPO, "tools/visual-qa/fake-supabase.mjs"));
const exe = (() => {
  try { return statSync("/opt/pw-browsers/chromium").isFile() ? "/opt/pw-browsers/chromium" : undefined; } catch { return undefined; }
})();

const SLUG = "night-owl";
const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const FILM = "bbbbbbbb-0000-4000-8000-000000000002";
const chapters = [
  { id: "ch1", title: "The storm", seconds: 300, beats: [] }, { id: "ch2", title: "The ambush", seconds: 300, beats: [] },
  { id: "ch3", title: "The well", seconds: 300, beats: [] }, { id: "ch4", title: "The dawn", seconds: 300, beats: [] },
];
const outline = (title, idea) => ({ title, idea, target_seconds: 1200, characters: [{ id: "c1", name: "Aziz" }, { id: "c2", name: "Lola" }], scenes: [], chapters });
const OUTLINES = [outline("The lost caravan", "A young guard must bring a caravan through a sandstorm before the well runs dry."),
                  outline("Salt and silk", "Two merchants race a rival across the steppe to reach the city before the gates close.")];
const PROPOSING = {
  session: { id: S1, step: "proposing" }, card: null, brief: { version: 1, kind: "short" },
  messages: [
    { id: 1, role: "user", content: "A 20-minute desert adventure film, noir style" },
    { id: 2, role: "assistant", content: "Here are two outlines for a 20-minute film. Pick one and I will write its storyboard, chapter by chapter.", payload: { scenarios: OUTLINES } },
  ],
};
const scenes = Array.from({ length: 48 }, (_, i) => ({ id: `s${i + 1}`, n: i + 1, title: `Scene ${i + 1}`, duration_s: 25, visual_prompt: "dunes", dialogue: [],
  character_ids: [], location_id: null, prop_ids: [], keyframe_model: null, clip_model: null }));
const POOR = {
  brief: { version: 1, session_id: S1, status: "ready", kind: "short", language: "English", audience: null, style: "noir", aspect: "9:16", target_seconds: 1200,
           title: OUTLINES[0].title, idea: OUTLINES[0].idea, characters: OUTLINES[0].characters, scenes, voice: { mode: "clip_audio" }, music: { mode: "off" },
           price: { state: "priced", total_credits: 4800, spendable: 1060, fits: false, shorter: null } },
  film: { id: FILM, version: 2 },
  quote: { quote_id: `fq-2-${"a".repeat(32)}`, total: 4800, startable: false, blocked_by: ["insufficient_credits"], refusal: "insufficient_credits", exempt: false },
  // quote_film's own answer, which S2's Create reads (#905): it says the shortfall with its own "Add credits".
  film_quote: { priced: true, total: 4800, quote_id: `fq-2-${"a".repeat(32)}`, startable: false, may_start: true, available: 1060, blocked_by: [{ reason: "insufficient_credits" }] },
};
const BRAIN = (session) => ({ plan: { used: 6, limit: 30, trial_left: null, max_input_chars: 2000 }, model: "available", canEdit: true, canRun: true, session });

const STATES = [
  { name: "plan-writing", url: `/${SLUG}/studio?brain=${S1}`, act: "choose", turn: "hold", keys: [] },
  { name: "plan-failed", url: `/${SLUG}/studio?brain=${S1}`, act: "choose",
    turn: { status: 502, body: { error: "plan_failed", reason: "timeout", step: { window: 5, windows: 8, chapter: 3, chapters: 4 }, quota: { used: 11, limit: 30, trial_left: null } } },
    keys: ["retry"] },
  { name: "insufficient-credits", url: `/${SLUG}/studio?brain=${S1}`, act: "choose", turn: { status: 200, body: POOR }, keys: ["addCredits"] },
  { name: "gate-adult", url: `/${SLUG}/studio?ai=new`, act: "send", turn: { status: 428, body: { error: "adult_attestation_required" } }, keys: ["confirmAge"] },
  { name: "gate-country", url: `/${SLUG}/studio?ai=new`, act: "send", turn: { status: 451, body: { error: "country_unverified" } }, keys: [] },
];
const VIEWS = [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }];
const EN = {
  // en.ts (lib/i18n/ai-chat): chooseThisNamed, retry, upgrade, topUp, errors.confirmAge, planReady, planWriting.
  choose: "Choose this one: The lost caravan", retry: "Try again", upgrade: "Upgrade plan", topUp: "Buy credits", confirmAge: "Confirm your age", addCredits: "Add credits", planReady: "The plan",
};

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
mkdirSync(OUT, { recursive: true });
const bad = [];
const lines = [];
const intersects = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const v of VIEWS) {
  for (const s of STATES) {
    const phone = v.width < 700;
    const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, colorScheme: "dark", reducedMotion: "reduce", isMobile: phone, hasTouch: phone, deviceScaleFactor: 2 });
    await ctx.addCookies([{ name: "chronos_locale", value: "en", url: BASE }, { ...sessionCookie(FAKE, "low"), url: BASE }]);
    await ctx.addInitScript(() => { try { window.sessionStorage.clear(); window.localStorage.clear(); } catch { /* none */ } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const fresh = s.url.includes("ai=new");
    let posted = 0;
    await page.route("**/api/brain/history**", (r) => r.fulfill({ json: r.request().url().includes("session=") ? PROPOSING : { sessions: [], next_before: null } }));
    await page.route(/\/api\/brain(\?|$)/, (r) => r.fulfill({ json: BRAIN(fresh ? null : { id: S1 }) }));
    await page.route("**/api/brain/turn", async (r) => {
      posted += 1;
      if (s.turn === "hold") return; // never answered: the storyboard is still being written
      // Answered after a moment, as a real plan is: the second press below lands while this one is still running.
      await new Promise((res) => setTimeout(res, 1_500));
      await r.fulfill({ status: s.turn.status, json: s.turn.body });
    });
    await page.goto(`${BASE}${s.url}`, { waitUntil: "load", timeout: 120_000 });
    const panel = page.getByTestId("nightshift-ai-panel");
    await panel.waitFor({ timeout: 60_000 });
    if (s.act === "choose") {
      const btn = page.getByRole("button", { name: EN.choose });
      await btn.waitFor({ timeout: 30_000 });
      await btn.click();
      // A second press while the first runs must send nothing (the panel's own guard).
      await btn.click({ timeout: 2_000, force: true }).catch(() => undefined);
    } else {
      const box = page.locator("#ns-ai-input");
      await box.waitFor({ timeout: 30_000 });
      await box.fill("A short film about the sea");
      await box.press("Enter");
    }
    const landmark = s.name === "plan-writing" ? panel.getByRole("status").filter({ hasText: "Writing the storyboard" })
      : s.name === "insufficient-credits" ? panel.getByRole("region", { name: EN.planReady }).first()
      : panel.getByRole("alert").first();
    let found = true;
    await landmark.waitFor({ timeout: 20_000 }).catch(() => { found = false; });
    if (!found) bad.push(`${s.name}@${v.width}: its state never appeared`);
    if (posted !== 1) bad.push(`${s.name}@${v.width}: ${posted} POSTs to /api/brain/turn (one press, one request)`);

    const dock = page.locator(".cv-flow-dock");
    const dockShown = phone && (await dock.count()) > 0 && (await dock.first().isVisible());
    if (phone && !dockShown) bad.push(`${s.name}@${v.width}: the canvas's phone dock is not on the page, so nothing was measured`);
    const measures = [];
    for (const k of s.keys) {
      const key = panel.getByRole(k === "retry" ? "button" : "link", { name: EN[k], exact: true }).first();
      if (!(await key.count())) { bad.push(`${s.name}@${v.width}: remedy key "${EN[k]}" missing`); continue; }
      if (!phone) continue;
      // (1) Playwright's own scroll into view; (2) keyboard focus; (3) the page scrolled to its very end. Each must leave the key clear.
      for (const how of ["scrollIntoView", "focus", "pageEnd", "alignEnd"]) {
        if (how === "scrollIntoView") await key.scrollIntoViewIfNeeded();
        if (how === "focus") { await page.evaluate(() => window.scrollTo(0, 0)); await key.focus(); }
        if (how === "pageEnd") { await key.scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); }
        // The strictest: the key's bottom edge put at the viewport's bottom (block: "end"), where a fixed dock sits.
        if (how === "alignEnd") await key.evaluate((el) => el.scrollIntoView({ block: "end" }));
        await page.waitForTimeout(150);
        const a = await key.boundingBox();
        const b = await dock.first().boundingBox();
        const inView = !!a && a.y >= 0 && a.y + a.height <= v.height;
        const hit = intersects(a, b);
        measures.push(`${k}/${how}: key y=${a ? Math.round(a.y) : "?"}..${a ? Math.round(a.y + a.height) : "?"} dock y=${b ? Math.round(b.y) : "?"}..${b ? Math.round(b.y + b.height) : "?"} ${hit ? "COVERED" : "clear"}${inView ? "" : " (off-screen)"}`);
        // alignEnd is reported, not failed: no person's action puts a key exactly at the screen's bottom edge.
        if (hit && how !== "alignEnd") bad.push(`${s.name}@${v.width}: "${EN[k]}" is covered by .cv-flow-dock after ${how}`);
        if (how === "pageEnd" && !inView && !hit) {
          // At the page's end the key may have scrolled above the screen (the panel is above the canvas): that is not covered.
        }
      }
      await key.scrollIntoViewIfNeeded();
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) bad.push(`${s.name}@${v.width}: ${overflow}px horizontal overflow`);
    if (errors.length) bad.push(`${s.name}@${v.width}: page errors: ${errors.join(" | ")}`);
    // Bring the state into view for the picture (at 390 the remedy key and the dock together).
    if (!s.keys.length || !phone) await landmark.scrollIntoViewIfNeeded().catch(() => undefined);
    const file = path.join(OUT, `${s.name}-${v.width}-dark.png`);
    await page.screenshot({ path: file });
    lines.push(`${path.basename(file)}  posts=${posted}  overflow=${overflow}  dock=${dockShown}  ${measures.join("; ")}`);
    await ctx.close();
  }
}
await browser.close();
console.log(lines.join("\n"));
if (bad.length) {
  console.error(`\nFAIL (${bad.length})\n${bad.join("\n")}`);
  process.exit(1);
}
console.log("\nok");
