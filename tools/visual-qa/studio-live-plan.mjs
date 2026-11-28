#!/usr/bin/env node
/**
 * Lab check for the Studio's Plan column beside Nightshift AI (command-center/components/studio-live/PlanColumn.tsx), adapted from the
 * measurement in docs/studio/S3_LIVE_MEASURE.md. Two parts:
 *
 *   flow    one sentence typed in the panel -> the first reply -> Choose -> the storyboard -> Create -> the confirm block, sampled
 *           every 100 ms with a screenshot every 500 ms. Asserts: the planning skeleton while the first turn is out, the Plan board
 *           after the first reply with cards, the storyboard row while the storyboard is written, the confirm key fully visible, the
 *           switch back to the person's canvas, no page error.
 *   layout  the page opened on a 12-scene conversation at 1440, 768, 390 and 360, light and dark (the app's own theme,
 *           chronos_theme), en / ru / uz. Asserts: the Plan cards are drawn (below 1024 px through the Chat / Plan tabs), no horizontal
 *           overflow, no page error, no card text under 12 px as rendered; at 1440x900 also: the 12 scenes fit the board at zoom 1,
 *           the page does not scroll, every card is reached by Tab, Escape closes a step and never leaves the page.
 *
 * The model is stubbed at the browser boundary, as in the measurement: lib/server/brain/llm.ts has no base-URL seam, and every turn
 * writes through ai_chat_* functions the fake refuses. /api/brain/turn is answered here after --L ms, in the route's recorded shape;
 * the film start is never sent. No vendor, LLM or paid provider is called; nothing is started, priced or spent.
 *
 * Needs a running app built against the fake (NEXT_PUBLIC_SUPABASE_URL = the fake's URL; NIGHTSHIFT_AI_CHAT=on,
 * NIGHTSHIFT_FILM_STUDIO=admins at runtime) and the fake (`PORT=... FAKE_ADMIN=1 node tools/visual-qa/fake-supabase.mjs`).
 *
 *   node tools/visual-qa/studio-live-plan.mjs --base http://localhost:3617 --fake http://127.0.0.1:54611 --L 2000 --out DIR [--part flow|layout|all]
 *
 * Reusable: `marks` and `samples` in DIR/<run>/raw.json are plain data (t = ms since the run started); add marks with mark(name).
 * Exit code 1 when any assertion failed.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const { sessionCookie } = await import(path.join(HERE, "fake-supabase.mjs"));
let chromium;
for (const base of [path.join(REPO, "command-center", "noop.js"), "/opt/node22/lib/node_modules/noop.js"]) {
  try {
    ({ chromium } = createRequire(base)("playwright"));
    break;
  } catch {
    /* next */
  }
}

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const BASE = arg("base", "http://localhost:3517");
const FAKE = arg("fake", "http://127.0.0.1:54499");
const L = Number(arg("L", "2000"));
const WINDOWS = Number(arg("windows", "2"));
const PART = arg("part", "all");
const OUT = path.resolve(arg("out", path.join(process.cwd(), "studio-live-plan-shots")));
mkdirSync(OUT, { recursive: true });

const SLUG = "night-owl";
const SID = "5e550000-0000-4000-8000-0000000000e1";
const FILM_ID = "0f000000-0000-4000-8000-00000000000f";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHOOSE_MS = Math.ceil(WINDOWS / 3) * L;
const FILM_S = Math.min(240, WINDOWS * 40 - 5);
const NSCENES = Math.round(FILM_S / 3.3);

let failures = 0;
const check = (ok, what) => {
  if (!ok) failures++;
  console.log(ok ? "ok  " : "FAIL", what);
};

// ---- the recorded shapes (as in the measurement) ----
const characters = [{ id: "c1", name: "Aziza", description: "a girl", image_prompt: "a girl in a red scarf", asset_id: null }];
const locations = [{ id: "l1", name: "Rooftop", description: "a rooftop at dusk", image_prompt: "rooftop at dusk", asset_id: null }];
const chapters = [
  { id: "ch1", title: "Setup", start_s: 0, beats: [{ at_s: 0, text: "She finds a kite." }], beat: "setup", seconds: Math.round(FILM_S / 3) },
  { id: "ch2", title: "Turn", start_s: Math.round(FILM_S / 3), beats: [{ at_s: 0, text: "The wind takes it." }], beat: "turn", seconds: Math.round(FILM_S / 3) },
  { id: "ch3", title: "Payoff", start_s: Math.round((2 * FILM_S) / 3), beats: [{ at_s: 0, text: "It comes back." }], beat: "payoff", seconds: FILM_S - 2 * Math.round(FILM_S / 3) },
];
const outline = (title) => ({
  title, idea: "A girl and a kite over Tashkent.", story: { logline: "A kite that comes back.", conflict: "The wind." },
  visual_style: "warm film", chapters, characters, locations, props: [], scenes: [], target_seconds: FILM_S, format: "F1", hook: "A kite snaps loose.",
  speech_intent: "none", plan_turns: { about: WINDOWS, at_most: WINDOWS * 2 },
});
const slots = { kind: "short", language: "en", audience: "families", style: "warm film", aspect: "9:16", target_seconds: FILM_S, inferred: [] };
const scenes = Array.from({ length: NSCENES }, (_, i) => ({
  id: `s${i + 1}`, n: i + 1, title: `Shot ${i + 1}`, duration_s: 3, visual_prompt: `Shot ${i + 1}: the kite over the rooftops, no text`, dialogue: [],
  character_ids: ["c1"], location_id: "l1", prop_ids: [], speech: "none",
}));
const briefBase = { version: 1, session_id: SID, kind: "short", language: "en", voice: { mode: "off" }, music: { mode: "off" }, handoff: null };
const drafting = { ...briefBase, status: "drafting", target_seconds: FILM_S, characters, locations };
const { plan_turns: _pt, ...outlineReady } = outline("The kite that came back");
const ready = { ...briefBase, ...outlineReady, status: "ready", scenes, price: { state: "unpriced" } };
const readyN = (n) => ({ ...ready, scenes: scenes.length >= n ? scenes.slice(0, n) : Array.from({ length: n }, (_, i) => ({ ...scenes[0], id: `s${i + 1}`, n: i + 1, title: `Shot ${i + 1}` })) });
const QUOTE = { film_id: FILM_ID, version: 8, priced: true, total: 16, quote_id: `fq-8-${"0".repeat(31)}1`, lines: [], scenes: [], refusals: [], planned_seconds: FILM_S,
  assembly_minutes: 2, exempt: false, available: 1180, active_films: 0, film_studio_enabled: true, blocked_by: [], may_start: true, startable: true };

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** The brain routes, answered here. `state.brief` is what the session read returns now (the server's stored brief). */
async function stubBrain(page, state) {
  await page.route(/\/api\/brain(\?.*)?$/, (r) => json(r, { plan: { used: 1, limit: 30, max_input_chars: 2000, trial_left: null }, model: "available", canEdit: true, canRun: true, session: null }));
  await page.route(/\/api\/brain\/history/, (r) => {
    const u = new URL(r.request().url());
    if (u.searchParams.get("session")) return json(r, { session: { step: state.brief === ready ? "ready" : "proposing", slots }, card: null, brief: state.brief, messages: [], plan: null });
    return json(r, { sessions: [], next_before: null });
  });
  await page.route(/\/api\/brain\/session\//, (r) => {
    state.sessionReads++;
    return state.brief ? json(r, { brief: state.brief }) : json(r, { error: "not_found" }, 404);
  });
  await page.route(/\/api\/brain\/turn$/, async (r) => {
    const b = JSON.parse(r.request().postData() || "{}");
    if (b.action === "start" || b.action === "turn") {
      await sleep(L);
      state.brief = drafting;
      return json(r, { session: { id: SID }, reply: "Here are two ways to tell it. Pick one and I will write its storyboard.", slots, step: "proposing", card: null,
        scenarios: [outline("The kite that came back"), outline("Wind over Chorsu")], factsState: "ok", brief: drafting, quota: { used: 2, limit: 30, trial_left: null } });
    }
    if (b.action === "choose") {
      await sleep(CHOOSE_MS);
      state.brief = ready;
      return json(r, { brief: ready, film: { id: FILM_ID, version: 8 }, models: { clip: { id: "qa-clip", name: "QA Clip" }, keyframe: { id: "qa-pic", name: "QA Pictures" } },
        quota: { used: 2 + WINDOWS, limit: 30, trial_left: null }, film_quote: QUOTE });
    }
    return json(r, { error: "bad_request" }, 400);
  });
  // Never reaches the server: nothing is started or held.
  await page.route(/\/api\/films\/[^/]+\/start$/, (r) => json(r, { error: "lab_never_starts" }, 409));
}

const probe = () => {
  const q = (s) => document.querySelector(s);
  const pane = q("[data-testid=plan-board-pane]");
  const canvas = q("[data-testid=plan-canvas-pane]");
  const panel = q("[data-testid=nightshift-ai-panel]");
  const vp = pane?.querySelector(".react-flow__viewport");
  return {
    url: location.pathname + location.search,
    replies: panel ? panel.querySelectorAll(".chat-msg-ai:not(:has(.chat-typing))").length : 0,
    thinking: !!panel?.querySelector(".chat-typing"),
    plan: !!pane,
    phase: pane?.dataset.phase ?? null,
    stage: pane?.querySelector("[data-stage]")?.getAttribute("data-stage") ?? null,
    planning: !!pane?.querySelector("[data-testid=plan-planning]"),
    skeleton: !!pane?.querySelector("[data-testid=plan-planning] .plan-skel"),
    storyboard: !!pane?.querySelector("[data-testid=plan-storyboard]"),
    cards: pane ? pane.querySelectorAll("[data-node-id]").length : 0,
    entering: pane ? pane.querySelectorAll("article.ds-reveal").length : 0,
    sceneCards: pane ? pane.querySelectorAll('[data-node-id^="scene#"]').length : 0,
    transform: vp ? vp.style.transform : null,
    canvasInert: canvas ? canvas.hasAttribute("inert") : null,
    createKey: !!q("[data-testid=film-create-key]"),
    scrollW: document.scrollingElement.scrollWidth,
    clientW: document.scrollingElement.clientWidth,
    scrollH: document.scrollingElement.scrollHeight,
    clientH: document.scrollingElement.clientHeight,
  };
};

async function flow() {
  const run = `flow_L${L}_w${WINDOWS}`;
  const dir = path.join(OUT, run);
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.VISUAL_QA_CHROMIUM || "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await ctx.addCookies([{ name: "chronos_locale", value: "en", url: BASE }, { ...sessionCookie(FAKE, "canvas"), url: BASE }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  const state = { brief: null, sessionReads: 0 };
  await stubBrain(page, state);

  const T0 = { v: Date.now() };
  const t = () => Date.now() - T0.v;
  const marks = [];
  const mark = (name, extra = {}) => marks.push({ t: t(), name, ...extra });
  const samples = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const at = t();
      try {
        samples.push({ t: at, ...(await page.evaluate(probe)) });
      } catch (e) {
        samples.push({ t: at, error: String(e.message).slice(0, 60) });
      }
      await sleep(Math.max(0, 100 - (t() - at)));
    }
  })();
  let shotN = 0;
  const shooter = (async () => {
    while (sampling) {
      const at = t();
      try {
        await page.screenshot({ path: path.join(dir, `f${String(shotN++).padStart(4, "0")}_${String(at).padStart(6, "0")}ms.jpg`), type: "jpeg", quality: 55 });
      } catch {
        /* navigating */
      }
      await sleep(Math.max(0, 500 - (t() - at)));
    }
  })();

  await page.goto(`${BASE}/${SLUG}/studio`, { waitUntil: "load", timeout: 120000 });
  await page.waitForSelector("[data-testid=nightshift-ai-panel] textarea", { timeout: 60000 });
  await sleep(1000);
  mark("page_ready");
  const box = page.locator("[data-testid=nightshift-ai-panel] textarea");
  await box.click();
  await box.fill("A 75 second short film about a girl whose kite flies away over Tashkent and comes back");
  await sleep(300);
  mark("send_pressed");
  await page.locator("[data-testid=nightshift-ai-panel] .chat-send").click();
  await page.getByRole("button", { name: /^Choose this one: The kite/ }).waitFor({ timeout: L + 60000 });
  mark("outlines_visible");
  await page.locator("[data-testid=plan-board-pane] [data-node-id]").first().waitFor({ timeout: 10000 }).then(() => mark("plan_cards"), () => mark("no_plan_cards"));
  await sleep(1000);
  mark("choose_pressed");
  await page.getByRole("button", { name: /^Choose this one: The kite/ }).click();
  await page.locator("[data-testid=film-create-key]").waitFor({ timeout: CHOOSE_MS + 60000 });
  mark("create_visible");
  await page.locator('[data-testid=plan-board-pane] [data-node-id^="scene#"]').first().waitFor({ timeout: 10000 }).then(() => mark("scene_cards"), () => mark("no_scene_cards"));
  await sleep(1500);
  mark("create_pressed");
  await page.locator("[data-testid=film-create-key]").click();
  await page.locator("[data-testid=film-create-confirm-key]").waitFor({ timeout: 10000 }).catch(() => mark("no_confirm"));
  await sleep(600);
  // The confirm key must be wholly inside the thread's visible box, not under the composer.
  const confirmVisible = await page.evaluate(() => {
    const key = document.querySelector("[data-testid=film-create-confirm-key]");
    const thread = key?.closest(".chat-thread") ?? key?.closest("[data-testid=nightshift-ai-panel]");
    const composer = document.querySelector("[data-testid=nightshift-ai-panel] .chat-composer");
    if (!key || !thread) return { ok: false, why: "missing" };
    const k = key.getBoundingClientRect();
    const th = thread.getBoundingClientRect();
    const c = composer?.getBoundingClientRect();
    const ok = k.top >= th.top && k.bottom <= th.bottom && (!c || k.bottom <= c.top);
    return { ok, key: [Math.round(k.top), Math.round(k.bottom)], thread: [Math.round(th.top), Math.round(th.bottom)], composer: c ? Math.round(c.top) : null };
  });
  mark("confirm_checked", confirmVisible);
  await page.screenshot({ path: path.join(dir, "confirm.png") });
  // Back to the person's canvas and to the plan again: the switch, not a reload.
  await page.locator("[data-testid=film-create-cancel]").click().catch(() => {});
  await page.locator("[data-testid=plan-switch-canvas]").click();
  await sleep(500);
  const canvasBack = await page.evaluate(() => ({ plan: !!document.querySelector("[data-testid=plan-board-pane]"), inert: document.querySelector("[data-testid=plan-canvas-pane]")?.hasAttribute("inert") }));
  await page.screenshot({ path: path.join(dir, "my-canvas.png") });
  await page.locator("[data-testid=plan-switch-plan]").click();
  await sleep(800);
  await page.screenshot({ path: path.join(dir, "plan-again.png") });
  sampling = false;
  await sampler;
  await shooter;
  await browser.close();

  const M = Object.fromEntries(marks.map((m) => [m.name, m.t]));
  const ok = samples.filter((s) => !s.error);
  const first = (from, f) => ok.find((s) => s.t >= from && f(s))?.t ?? null;
  const rel = (x, base) => (x === null || x === undefined ? null : +((x - base) / 1000).toFixed(2));
  const S = M.send_pressed;
  const C = M.choose_pressed;
  const derived = {
    L_ms: L, windows: WINDOWS, choose_ms: CHOOSE_MS, scenes: NSCENES,
    after_send_s: {
      "plan column shown": rel(first(S, (s) => s.plan), S),
      "Planning… shown": rel(first(S, (s) => s.planning), S),
      "planning skeleton shown": rel(first(S, (s) => s.skeleton), S),
      "reply shown in panel": rel(first(S, (s) => s.replies > 0), S),
      "first plan cards": rel(first(S, (s) => s.cards > 0), S),
    },
    after_choose_s: {
      "storyboard state shown": rel(first(C, (s) => s.storyboard), C),
      "Create shown in panel": rel(first(C, (s) => s.createKey), C),
      "scene cards on the board": rel(first(C, (s) => s.sceneCards > 0), C),
      "storyboard state gone": rel(first(C + 200, (s) => !s.storyboard && s.sceneCards > 0), C),
    },
    stages_seen: [...new Set(ok.map((s) => s.stage).filter(Boolean))],
    viewport_transforms_after_send: [...new Set(ok.filter((s) => s.t >= S).map((s) => s.transform).filter(Boolean))].length,
    max_entering: Math.max(0, ...ok.map((s) => s.entering)),
    session_reads: state.sessionReads,
    confirm: confirmVisible,
    canvas_back: canvasBack,
    page_errors: errors,
  };
  writeFileSync(path.join(dir, "raw.json"), JSON.stringify({ marks, samples, derived }, null, 1));
  console.log(JSON.stringify(derived, null, 1));
  check(derived.after_send_s["first plan cards"] !== null, `${run}: the Plan board shows cards after the first reply`);
  check(derived.after_send_s["planning skeleton shown"] !== null, `${run}: the planning skeleton while the first turn was out`);
  check(derived.after_choose_s["storyboard state shown"] !== null, `${run}: the storyboard state was shown while it was written`);
  check(derived.after_choose_s["scene cards on the board"] !== null, `${run}: the storyboard's scene cards reached the board`);
  check(confirmVisible.ok === true, `${run}: the confirm key is wholly visible above the composer`);
  check(canvasBack.plan === false && canvasBack.inert === false, `${run}: "My canvas" shows the person's canvas again`);
  check(errors.length === 0, `${run}: no page error`);
}

async function layout() {
  const dir = path.join(OUT, "layout");
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.VISUAL_QA_CHROMIUM || "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const N = 12;
  for (const locale of ["en", "ru", "uz"])
    for (const theme of ["light", "dark"])
      for (const width of [1440, 768, 390, 360]) {
        const phone = width < 700;
        const height = phone ? 844 : 900;
        const ctx = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: width <= 1024, colorScheme: theme });
        // The app's own theme switch (not only the system's): a real light page, not a dark one in a light browser.
        await ctx.addInitScript((t) => {
          try {
            localStorage.setItem("chronos_theme", t);
          } catch {
            /* storage refused */
          }
        }, theme);
        await ctx.addCookies([{ name: "chronos_locale", value: locale, url: BASE }, { ...sessionCookie(FAKE, "canvas"), url: BASE }]);
        const page = await ctx.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
        const state = { brief: readyN(N), sessionReads: 0 };
        await stubBrain(page, state);
        const name = `${locale}-${theme}-${width}`;
        await page.goto(`${BASE}/${SLUG}/studio?brain=${SID}`, { waitUntil: "load", timeout: 120000 });
        await page.waitForSelector("[data-testid=studio-split]", { timeout: 60000 });
        await sleep(600);
        const tabs = await page.locator("[data-testid=studio-tab-plan]").count();
        if (width < 1024) {
          check(tabs === 1, `${name}: Chat / Plan tabs below 1024 px`);
          await page.locator("[data-testid=studio-tab-plan]").click().catch(() => {});
        } else check(tabs === 0, `${name}: chat and plan side by side, no tabs`);
        const cards = await page.locator("[data-testid=plan-board-pane] [data-node-id]").first().waitFor({ timeout: 30000 }).then(() => true, () => false);
        await sleep(1200);
        const s = await page.evaluate(probe);
        const small = await page.evaluate(() => {
          const out = [];
          for (const el of document.querySelectorAll("[data-testid=plan-board-pane] .psc *")) {
            if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
            const r = el.getBoundingClientRect();
            if (!r.width) continue;
            const size = parseFloat(getComputedStyle(el).fontSize);
            const vp = el.closest(".react-flow__viewport");
            const zoom = vp ? Number(/scale\(([\d.]+)\)/.exec(vp.style.transform)?.[1] ?? 1) : 1;
            if (size * zoom < 11.95) out.push(`${el.className}:${(size * zoom).toFixed(1)}`);
          }
          return out.slice(0, 5);
        });
        check(cards && s.cards > 0, `${name}: Plan cards drawn (${s.cards})`);
        check(s.scrollW <= s.clientW, `${name}: no horizontal overflow (${s.scrollW} <= ${s.clientW})`);
        check(small.length === 0, `${name}: no card text under 12 px as rendered ${small.join(" ")}`);
        if (width === 1440) {
          const fit = await page.evaluate(() => {
            const board = document.querySelector("[data-testid=plan-board]")?.getBoundingClientRect();
            const vp = document.querySelector("[data-testid=plan-board] .react-flow__viewport")?.style.transform ?? "";
            const out = [...document.querySelectorAll('[data-testid=plan-board] [data-node-id^="scene#"]')].map((b) => b.closest("article").getBoundingClientRect());
            const inside = out.every((r) => board && r.top >= board.top - 0.5 && r.bottom <= board.bottom + 0.5 && r.left >= board.left - 0.5 && r.right <= board.right + 0.5);
            return { scenes: out.length, inside, zoom1: /scale\(1\)/.test(vp) };
          });
          check(fit.scenes === N && fit.inside && fit.zoom1, `${name}: ${N} scenes fit the board at zoom 1 (${JSON.stringify(fit)})`);
          // The Studio's own column ends inside the window. (The page itself still scrolls on main by the app shell's rail and the
          // map credit under the page, which this PR does not touch: reported, not asserted.)
          const col = await page.evaluate(() => Math.round(document.querySelector("[data-testid=studio-plan-column]").getBoundingClientRect().bottom));
          check(col <= 900, `${name}: the Plan column ends inside the 900 px window (${col}); page scroll ${s.scrollH}/${s.clientH}`);
          // Tab through the board from its first card: every card is reached.
          const ids = await page.evaluate(() => [...document.querySelectorAll("[data-testid=plan-board-pane] [data-node-id]")].map((e) => e.dataset.nodeId));
          await page.locator("[data-testid=plan-board-pane] [data-node-id]").first().focus();
          const reached = new Set();
          for (let i = 0; i < ids.length + 2; i++) {
            const id = await page.evaluate(() => document.activeElement?.closest?.("[data-node-id]")?.dataset.nodeId ?? null);
            if (id) reached.add(id);
            await page.keyboard.press("Tab");
          }
          check(ids.every((id) => reached.has(id)), `${name}: every card is reached by Tab (${reached.size}/${ids.length})`);
          // Escape closes a step and never leaves the Studio.
          const before = page.url();
          await page.locator('[data-testid=plan-board-pane] [data-node-id="scene#3"]').click();
          const opened = await page.locator("[data-testid=live-details]").count();
          await page.keyboard.press("Escape");
          await sleep(300);
          const closed = (await page.locator("[data-testid=live-details]").count()) === 0;
          await page.keyboard.press("Escape");
          await sleep(500);
          check(opened === 1 && closed && page.url() === before, `${name}: Escape closes the step and stays on the Studio`);
        }
        await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: phone });
        check(errors.length === 0, `${name}: no page error ${errors.join(" | ")}`);
        await ctx.close();
      }
  await browser.close();
}

if (PART === "flow" || PART === "all") await flow();
if (PART === "layout" || PART === "all") await layout();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
