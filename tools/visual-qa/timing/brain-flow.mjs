#!/usr/bin/env node
/**
 * Scenario: one sentence in the Nightshift AI panel → its outlines → Choose → the storyboard → Create → confirm → the live view,
 * measured with harness.mjs. It reproduces the measurement in the S3 live measure (MEASURE.md): same stubs, same person.
 *
 * No model, vendor or paid call is made, and nothing is spent or started:
 *   - `/api/brain/turn` is answered in the browser, after L seconds per model call, in the route's own response shape
 *     (start/turn → outlines; choose → the plan after ceil(windows/3)·L·(1+reask), the plan's parallel schedule; handoff → ok);
 *   - `/api/films/{id}/start` is answered in the browser (300 ms) and never reaches the server;
 *   - the fake Supabase refuses every write.
 *
 *   node tools/visual-qa/timing/brain-flow.mjs --L 8 --out /tmp/timing/L8
 *   node tools/visual-qa/timing/brain-flow.mjs --L 2 --base http://localhost:3517 --fake http://127.0.0.1:54499   # stack already up
 *
 * Options: --L seconds per model call (8) · --windows plan windows (2) · --reask 0|1 · --worker ms until the stubbed first step
 * runs (2000) · --selectors file.json (merged over DEFAULT_SELECTORS) · --app-dir (command-center) · --shots 0|1 · --keep 1
 * (leave the stack it started running).
 *
 * Selectors default to both today's main (the panel beside StudioCanvas, Create → `?view=live` by a full reload) and the coming
 * live-plan branch (a Plan column, `data-testid="studio-plan-column"`, `plan-card-*`, `plan-planning`, `plan-storyboard`). A
 * selector that matches nothing reads as 0 / never; it is not an error.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromiumPath, finish, loadPlaywright, record, sleep, startStack, APP_DIR, FAKE_SCRIPT } from "./harness.mjs";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};

export const DEFAULT_SELECTORS = {
  panel: "[data-testid=nightshift-ai-panel]",
  input: "[data-testid=nightshift-ai-panel] textarea",
  send: "[data-testid=nightshift-ai-panel] .chat-send",
  thinking: "[data-testid=nightshift-ai-panel] .chat-typing",
  replies: "[data-testid=nightshift-ai-panel] .chat-msg-ai:not(:has(.chat-typing))",
  outlines: "[data-testid=nightshift-ai-panel] article.studio-field",
  planReady: '[data-testid=nightshift-ai-panel] section[aria-label="The plan"]',
  createKey: "[data-testid=film-create-key]",
  confirmKey: "[data-testid=film-create-confirm-key]",
  // The board beside the panel: StudioCanvas today, the Plan column on the live-plan branch, the live view after Create.
  board: "[data-studio-canvas], [data-testid=studio-plan-column], [data-testid=live-view]",
  canvasNodes: "[data-studio-canvas] .react-flow__node",
  canvasViewport: "[data-studio-canvas] .react-flow__viewport",
  planColumn: "[data-testid=studio-plan-column]",
  planThinking: "[data-testid=plan-thinking]",
  planCards: "[data-testid^=plan-card-]",
  planPlanning: "[data-testid=plan-planning]",
  planStoryboard: "[data-testid=plan-storyboard]",
  liveView: "[data-testid=live-view]",
  liveLoading: "[data-testid=live-loading]",
  liveCards: ".lv-card",
  liveWorking: '.lv-card[data-status="working"]',
};

const SLUG = "night-owl";
const SID = "5e550000-0000-4000-8000-0000000000e1";
const FILM_ID = "0f000000-0000-4000-8000-00000000000f";

/** The route's answers, in the shapes `app/api/brain/turn/route.ts` returns (as recorded in the S3 measure). */
function fixtures(WINDOWS, REASK) {
  const FILM_S = Math.min(240, WINDOWS * 40 - 5);
  const NSCENES = Math.round(FILM_S / 3.3);
  const look = { face: "round", hair: "short black", build: "slight", outfit: "red scarf, grey coat", palette: "warm", signature: "red scarf" };
  const characters = [{ id: "c1", name: "Aziza", description: "a girl", image_prompt: "a girl in a red scarf", asset_id: null, character_id: null, source: "prompt", look }];
  const locations = [{ id: "l1", name: "Rooftop", description: "a rooftop at dusk", image_prompt: "rooftop at dusk", asset_id: null }];
  const third = Math.round(FILM_S / 3);
  const chapters = [
    { id: "ch1", title: "Setup", start_s: 0, beats: [{ at_s: 0, text: "She finds a kite." }], beat: "setup", seconds: third },
    { id: "ch2", title: "Turn", start_s: third, beats: [{ at_s: 0, text: "The wind takes it." }], beat: "turn", seconds: third },
    { id: "ch3", title: "Payoff", start_s: 2 * third, beats: [{ at_s: 0, text: "It comes back." }], beat: "payoff", seconds: FILM_S - 2 * third },
  ];
  const outline = (title) => ({
    title, idea: "A girl and a kite over Tashkent.", story: { logline: "A kite that comes back.", conflict: "The wind." },
    visual_style: "warm film", chapters, characters, locations, props: [], scenes: [], target_seconds: FILM_S, format: "F1", hook: "A kite snaps loose.",
    speech_intent: "none", plan_turns: { about: WINDOWS, at_most: WINDOWS * 2 },
  });
  const slots = { kind: "short", language: "en", audience: "families", style: "warm film", aspect: "9:16", target_seconds: FILM_S, inferred: [] };
  const scenes = Array.from({ length: NSCENES }, (_, i) => ({
    id: `s${i + 1}`, n: i + 1, title: `Shot ${i + 1}`, duration_s: 3, visual_prompt: `Shot ${i + 1}: the kite over the rooftops, no text`, dialogue: [],
    character_ids: ["c1"], location_id: "l1", prop_ids: [], keyframe_model: "qa-pic", clip_model: "qa-clip", speech: "none",
    chapter_id: chapters[Math.min(2, Math.floor((i * 3) / NSCENES))].id,
  }));
  const briefBase = { version: 1, session_id: SID, kind: "short", language: "en", audience: "families", style: "warm film", aspect: "9:16", voice: { mode: "off" }, music: { mode: "off" }, handoff: null };
  const drafting = { ...briefBase, status: "drafting", target_seconds: FILM_S };
  const ready = { ...briefBase, ...outline("The kite that came back"), status: "ready", chapters: chapters.map(({ seconds: _s, ...c }) => c), scenes, price: { state: "unpriced" } };
  delete ready.plan_turns;
  const quote = {
    film_id: FILM_ID, version: 8, priced: true, total: 16, quote_id: `fq-8-${"0".repeat(31)}1`, lines: [], scenes: [], refusals: [], planned_seconds: FILM_S,
    assembly_minutes: 2, exempt: false, available: 1180, active_films: 0, film_studio_enabled: true, blocked_by: [], may_start: true, startable: true,
  };
  const proposal = {
    session: { id: SID }, reply: "Here are two ways to tell it. Pick one and I will write its storyboard.", slots, step: "proposing", card: null,
    scenarios: [outline("The kite that came back"), outline("Wind over Chorsu")], factsState: "ok", brief: drafting, quota: { used: 2, limit: 30, trial_left: null },
  };
  const chosen = {
    brief: ready, film: { id: FILM_ID, version: 8 }, models: { clip: { id: "qa-clip", name: "QA Clip" }, keyframe: { id: "qa-pic", name: "QA Pictures" } },
    quota: { used: 2 + WINDOWS * (1 + REASK), limit: 30, trial_left: null }, film_quote: quote,
  };
  return { FILM_S, NSCENES, ready, proposal, chosen };
}

export async function runBrainFlow(opts = {}) {
  const L = Number(opts.L ?? 8) * 1000;
  const WINDOWS = Number(opts.windows ?? 2);
  const REASK = Number(opts.reask ?? 0);
  const WORKER = Number(opts.worker ?? 2000);
  const OUT = path.resolve(opts.out ?? `/tmp/timing/L${L / 1000}`);
  const S = { ...DEFAULT_SELECTORS, ...(opts.selectors || {}) };
  const CHOOSE_MS = Math.ceil(WINDOWS / 3) * (1 + REASK) * L; // PLAN.concurrency = 3
  const fx = fixtures(WINDOWS, REASK);

  const stack = opts.base
    ? { base: opts.base.replace(/\/$/, ""), fakeUrl: opts.fake, stop: async () => {} }
    : await startStack({
        appDir: opts.appDir ?? APP_DIR,
        appEnv: { NIGHTSHIFT_AI_CHAT: "on", NIGHTSHIFT_FILM_STUDIO: "admins" },
        fakeEnv: { FAKE_ADMIN: "1" },
        logDir: path.join(OUT, "logs"),
      });
  const { sessionCookie } = await import(FAKE_SCRIPT);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: chromiumPath(), args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    await ctx.addCookies([{ name: "chronos_locale", value: "en", url: stack.base }, { ...sessionCookie(stack.fakeUrl, "canvas"), url: stack.base }]);
    const page = await ctx.newPage();
    const rec = await record(page, {
      out: OUT,
      shots: opts.shots !== false,
      watch: {
        counts: {
          thinking: S.thinking, replies: S.replies, outlines: S.outlines, planReady: S.planReady, createKey: S.createKey, confirmKey: S.confirmKey,
          canvasNodes: S.canvasNodes, planColumn: S.planColumn, planThinking: S.planThinking, planCards: S.planCards, planPlanning: S.planPlanning,
          planStoryboard: S.planStoryboard, liveView: S.liveView, liveLoading: S.liveLoading, liveCards: S.liveCards, liveWorking: S.liveWorking, panel: S.panel,
        },
        texts: { input: S.input },
        attrs: { canvasViewport: [S.canvasViewport, "style"] },
        regions: { board: S.board, panel: S.panel },
      },
    });

    let startedAt = null;
    let sessionReads = 0;
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    await page.route(/\/api\/brain(\?.*)?$/, (r) => json(r, { plan: { used: 1, limit: 30, max_input_chars: 2000, trial_left: null }, model: "available", canEdit: true, canRun: true, session: null }));
    await page.route(/\/api\/brain\/history/, (r) => json(r, { sessions: [], next_before: null }));
    await page.route(/\/api\/brain\/session\//, (r) => {
      sessionReads++;
      return json(r, { brief: fx.ready });
    });
    await page.route(/\/api\/brain\/turn(\?.*)?$/, async (r) => {
      const b = JSON.parse(r.request().postData() || "{}");
      if (b.action === "start" || b.action === "turn") {
        await sleep(L);
        return json(r, fx.proposal);
      }
      if (b.action === "choose") {
        await sleep(CHOOSE_MS);
        return json(r, fx.chosen);
      }
      if (b.action === "handoff") return json(r, { ok: true });
      return json(r, { error: "bad_request" }, 400);
    });
    // Never reaches the server: nothing is started, held or spent.
    await page.route(/\/api\/films\/[^/]+\/start$/, async (r) => {
      startedAt = Date.now();
      await sleep(300);
      return json(r, { start: { ok: true, replayed: false } });
    });
    // The fake's real /live answer, with the first key frame "running" once the assumed worker pickup has passed.
    await page.route(/\/api\/films\/[^/]+\/live(\?.*)?$/, async (r) => {
      const res = await r.fetch();
      let body = await res.json().catch(() => null);
      if (body && startedAt && Date.now() - startedAt >= WORKER && body.film?.scenes?.[0]) {
        body = structuredClone(body);
        body.film.film.status = "running";
        const s0 = body.film.scenes[0];
        const now = new Date().toISOString();
        s0.takes = [{
          id: "7f000000-0000-4000-8000-000000000001", scene_id: s0.id, version: 1, shot_index: 0, kind: "keyframe", parent_take_id: null, attempt: 1, status: "running",
          model: "qa-pic", prompt_final: null, params: {}, duration_s: null, first_frame_asset_id: null, last_frame_asset_id: null, reference_asset_ids: [], reshoot: null,
          creative_job_id: null, result_asset_id: null, result_last_frame_asset_id: null, error_code: null, error: null, created_at: now, updated_at: now, finished_at: null,
        }];
      }
      return r.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(body) });
    });

    const m = (n) => rec.mark(n);
    const at = {};
    const step = (n) => {
      m(n);
      at[n] = rec.t();
    };
    rec.start();
    await page.goto(`${stack.base}/${SLUG}/studio`, { waitUntil: "load", timeout: 120000 });
    await page.waitForSelector(S.input, { timeout: 60000 });
    await sleep(1500);
    step("page_ready");
    const box = page.locator(S.input);
    await box.click();
    await box.fill("A 75 second short film about a girl whose kite flies away over Tashkent and comes back");
    await sleep(300);
    step("send_pressed");
    await page.locator(S.send).click();
    const choose = page.getByRole("button", { name: /^Choose this one: The kite/ });
    await choose.waitFor({ timeout: L + 60000 });
    step("outlines_visible");
    await sleep(1000); // the person reads for a second
    step("choose_pressed");
    await choose.click();
    await page.locator(S.createKey).waitFor({ timeout: CHOOSE_MS + 60000 });
    step("create_visible");
    await sleep(1000);
    step("create_pressed");
    await page.locator(S.createKey).click();
    await page.locator(S.confirmKey).waitFor({ timeout: 10000 });
    await sleep(500);
    step("confirm_pressed");
    await page.locator(S.confirmKey).click();
    // Either a reload to ?view=live (today) or the board turning live in place (the plan's item 9): wait for the first lit step.
    await page.locator(S.liveWorking).first().waitFor({ timeout: 30000 }).then(() => step("first_working_seen"), () => step("no_working_card"));
    await sleep(2000);
    step("end");
    await rec.stop();
    await page.screenshot({ path: path.join(OUT, "final.png") });

    const windows = [
      { name: "send→outlines", from: at.send_pressed, to: at.outlines_visible, expect: ["plan thinking", "plan card", "canvas node", "ns:plan:first-card", "ns:plan:thinking"] },
      { name: "choose→plan", from: at.choose_pressed, to: at.create_visible, expect: ["plan planning", "plan storyboard", "ns:plan:storyboard-start", "ns:plan:first-card"] },
      { name: "confirm→first lit", from: at.confirm_pressed, to: at.first_working_seen ?? at.end, expect: ["live card", "live working", "ns:live:first-lit"] },
    ];
    // DOM events. Panel events show what the person sees in the chat; board events are what the plan's targets are about.
    const defs = [
      { name: "thinking dots", count: "thinking" },
      { name: "input cleared after send", text: "input", match: /^$/ },
      { name: "reply text", count: "replies" },
      { name: "outline cards", count: "outlines" },
      { name: "canvas node", count: "canvasNodes" },
      { name: "plan column", count: "planColumn" },
      { name: "plan thinking", count: "planThinking" },
      { name: "plan card", count: "planCards" },
      { name: "plan planning", count: "planPlanning" },
      { name: "plan storyboard", count: "planStoryboard" },
      { name: "the plan + Create in panel", count: "createKey" },
      { name: "live view", count: "liveView" },
      { name: "live loading", count: "liveLoading" },
      { name: "live card", count: "liveCards" },
      { name: "live working", count: "liveWorking" },
    ];
    const result = finish({
      out: OUT,
      title: `brain-flow timing, L = ${L / 1000} s`,
      meta: { L_ms: L, windows: WINDOWS, reask: REASK, worker_pickup_ms: WORKER, choose_ms: CHOOSE_MS, film_s: fx.FILM_S, scenes: fx.NSCENES, base: stack.base, session_reads: sessionReads },
      rec,
      windows,
      defs: defs.map((d) => (d.name === "input cleared after send" ? { ...d, after: at.send_pressed } : d)),
      createAt: at.confirm_pressed,
      stretchRegions: [null, "board"],
      notes: [
        "The model is stubbed in the browser: L is a parameter, not a measured vendor latency. The film start never reached the server.",
        "The live view's film is the fake's fixed film, not the one planned here; its first working step is stubbed at the worker pickup time.",
        `\`/api/brain/session\` reads: ${sessionReads}.`,
      ],
    });
    return { out: OUT, ...result };
  } finally {
    await browser.close();
    if (!opts.keep) await stack.stop();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const sel = arg("selectors", null);
  const r = await runBrainFlow({
    L: arg("L", "8"),
    windows: arg("windows", "2"),
    reask: arg("reask", "0"),
    worker: arg("worker", "2000"),
    out: arg("out", undefined),
    base: arg("base", undefined),
    fake: arg("fake", undefined),
    appDir: arg("app-dir", undefined),
    shots: arg("shots", "1") === "1",
    keep: arg("keep", "0") === "1",
    selectors: sel ? JSON.parse(readFileSync(sel, "utf8")) : undefined,
  });
  process.stdout.write(r.report);
  process.stdout.write(`\nwritten: ${r.out}/REPORT.md, ${r.out}/raw.json\n`);
}
