import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePlanLease } from "./helpers/fakePlanLease";
import { planLimits, planWindows } from "@/lib/brain/plan";
import { readScenario, readSlots } from "@/lib/brain/logic";
/** 0211's plan lease, as the database keeps it (tests/helpers/fakePlanLease.ts). */
const lease = fakePlanLease();

/**
 * /api/brain/turn `choose` on a short outline, at the plan step's edges (Probe on S1), against a fake database and a fake model.
 * What breaks if these fail: a 20-minute film priced from a partial storyboard; a window that timed out (or answered garbage) turned
 * into a shorter film; a re-ask that is never asked, asked twice, or asked when it cannot help; a plan begun that today's turns
 * cannot finish; an old stored storyboard that does not add up being priced; a long video sent through the short plan; a scene
 * split into shots on a guessed clip length; a second tab writing the same storyboard again and taking every turn twice.
 */

vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
const ref = (id: string) => createHash("md5").update(`nightshift-chat-model:${id}`).digest("hex");

const ORG = "11111111-2222-3333-4444-555555555555";
const SESSION = "aaaaaaaa-0000-0000-0000-000000000001";
const FILM = "bbbbbbbb-0000-0000-0000-000000000002";
const RID = "press12345";
const slots = (target: number, kind = "short") => ({ kind, target_seconds: target, aspect: "9:16", style: "noir", language: "English", audience: "teens" });
const outline = (seconds: number[], o: Record<string, unknown> = {}) => ({
  title: "The lost caravan", idea: "A guard must save a caravan.", story: { logline: "l", conflict: "c" },
  characters: [{ id: "c1", name: "Aziz", description: "a guard", image_prompt: "guard" }],
  locations: [{ id: "l1", name: "Dune", description: "dunes", image_prompt: "dunes" }], props: [],
  chapters: seconds.map((s, i) => ({ id: `ch${i + 1}`, title: `Chapter ${i + 1}`, seconds: s, beats: [{ at_s: 0, text: "beat" }] })),
  ...o,
});
/** The windows the route itself plans (no clip model on sale: the film's own 30 s scenes). Counted, not written down, so a change to
 *  the packing (Lens M2) moves these pins with it rather than past them. */
const windowsFor = (target: number, seconds: number[]) =>
  planWindows(readScenario(outline(seconds), readSlots(slots(target)))!, planLimits(null))!;
const storedScene = (d: number, o: Record<string, unknown> = {}) => ({ title: "x", duration_s: d, visual_prompt: "v", character_ids: ["c1"], location_id: "l1", ...o });

type Part = { id: string; seconds: number };
type Data = Record<string, unknown> & { window: { n: number; of: number }; limits: { max_scenes: number; scene_max?: number }; previous_answer_problem?: string };
type Answer = (parts: Part[], data: Data, call: number) => Record<string, unknown> | Promise<Record<string, unknown>>;
const ok = (text: unknown) => ({ ok: true, tokensIn: 10, tokensOut: 20, text: typeof text === "string" ? text : JSON.stringify(text) });
/** An obedient model: each part in as few 30 s-or-shorter scenes as it can, adding up exactly; the first scene speaks. */
const exact: Answer = (parts) => ok({ chapters: parts.map((p) => {
  const k = Math.ceil(p.seconds / 30);
  const lens = Array.from({ length: k }, (_, i) => Math.floor(p.seconds / k) + (i < p.seconds % k ? 1 : 0));
  return { id: p.id, scenes: lens.map((d, i) => ({ title: `${p.id}-${i}`, duration_s: d, visual_prompt: `shot of ${p.id}`, character_ids: ["c1"], location_id: "l1",
    dialogue: [] /* wordless: only speech "none" can be planned today (speechAllowed) */ })) };
}) });
const shortBy = (n: number): Answer => (parts) => ok({ chapters: parts.map((p) => ({ id: p.id, scenes: [{ title: "x", duration_s: Math.min(30, p.seconds - n), visual_prompt: "v" }] })) });

const state = {
  session: null as Record<string, unknown> | null,
  proposal: null as unknown,
  last: null as Record<string, unknown> | null,
  quota: { used: 3, limit: 30 } as Record<string, unknown>,
  /** Per reservation: an error to refuse it with, or null. */
  reserveRefusal: (() => null) as (args: Record<string, unknown>, n: number) => unknown,
  answer: exact as Answer,
  clipModel: null as string | null,
  clipSpec: null as unknown,
  /** A stateful last message: the first plan call stores the person's choice, as 0199 does. */
  trackLast: false,
};
const rpc = vi.fn();
const llm = vi.fn();
let calls = 0;
let reserved = 0;

function table(name: string) {
  const f: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  for (const m of ["select", "in", "order", "limit", "not", "gte", "neq", "is"]) b[m] = () => b;
  b.eq = (k: string, v: unknown) => { f[k] = v; return b; };
  b.maybeSingle = async () => ({ data: name === "ai_chat_sessions" ? state.session : name === "channels" ? { org_id: ORG, name: "Chan" } : null, error: null });
  b.then = (resolve: (v: unknown) => void) => {
    if (name !== "ai_chat_messages") return resolve({ data: [], error: null });
    if (f.role === "assistant") return resolve({ data: [{ id: 41, payload: state.proposal }], error: null });
    return resolve({ data: state.last ? [state.last] : [{ id: 41, role: "assistant", content: "Pick one" }], error: null });
  };
  return b;
}
const client = {
  from: (t: string) => table(t),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpc(fn, args);
    const leased = lease.rpc(fn, args as Record<string, unknown>);
    if (leased) return leased;
    if (fn === "sellable_models") {
      if (args.p_capability === "i2v") {
        return { data: state.clipModel && state.clipSpec ? [{ id: state.clipModel, display_name: "Clip", provider: "x", availability: "ga", verified_at: "2026-11-01",
          credit_unit: "second", credits_per_unit: 1, capabilities: ["i2v"], spec: state.clipSpec }] : [], error: null };
      }
      return { data: [{ id: "anthropic-claude-sonnet-5-5" }], error: null };
    }
    if (fn === "ai_chat_quota") return { data: { ...state.quota, model_ref: ref("anthropic-claude-sonnet-5-5") }, error: null };
    if (fn === "ai_chat_reserve_turn") {
      const refusal = state.reserveRefusal(args, reserved + 1);
      if (refusal) return { data: null, error: refusal };
      reserved += 1;
      if (state.trackLast && args.p_retry === false) state.last = { id: 50, role: "user", content: args.p_text };
      return { data: { call_id: `call-${reserved}`, used: Number(state.quota.used ?? 0) + reserved, limit: state.quota.limit ?? null }, error: null };
    }
    if (fn === "create_film_draft") return { data: { film: { id: FILM, version: 1, clip_model: state.clipModel }, limits: { max_shots: 3 } }, error: null };
    if (fn === "save_film") return { data: { film: { id: FILM, version: 2 } }, error: null };
    if (fn === "quote_film") return { data: { priced: true, total: 240, quote_id: `fq-2-${"a".repeat(32)}`, startable: true, available: 500 }, error: null };
    return { data: null, error: null };
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, getUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => ({ ok: true, role: "editor", orgId: ORG, source: "org" }) }));
vi.mock("@/lib/server/same-origin", () => ({ rejectCrossOrigin: () => null }));
vi.mock("@/lib/server/age", () => ({ readAgeState: async () => "adult" }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: ORG, role: "owner" } }) }));
vi.mock("@/lib/i18n/server", () => ({ getLocale: async () => "en" }));
vi.mock("@/lib/server/films", () => ({ filmGate: async () => ({ ok: true, supabase: client, userId: "user-1" }) }));
vi.mock("@/lib/server/brain/facts", () => ({ readChannelFacts: async () => ({ state: "none", source: null, name: "Chan", statuses: {}, ownRecent: [], competitorTop: [], audienceAsks: [] }) }));
const pricing = { value: { ok: false } as Record<string, unknown> };
vi.mock("@/lib/server/brain/quote", () => ({ chatPricing: async () => pricing.value }));
vi.mock("@/lib/server/brain/google-gate", () => ({ chatModelGate: async () => null }));
vi.mock("@/lib/server/brain/llm", async () => {
  const real = await vi.importActual<typeof import("@/lib/server/brain/llm")>("@/lib/server/brain/llm");
  return {
    ...real, chatModelConfigured: () => true,
    callChatModel: async (...a: unknown[]) => {
      llm(...a);
      const data = readData(a[2]);
      const parts = (data.write_chapters as { id: string; seconds: number }[]).map((p) => ({ id: p.id, seconds: p.seconds }));
      calls += 1;
      const n = calls;
      await new Promise((r) => setTimeout(r, 2));
      return state.answer(parts, data, n);
    },
  };
});

const { POST } = await import("@/app/api/brain/turn/route");
const choose = (body: Record<string, unknown> = {}) => POST(new Request("https://x/api/brain/turn", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "choose", session: SESSION, index: 0, request_id: RID, ...body }) }));
const called = (fn: string) => rpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Record<string, unknown>);
/** The data block a call was sent, with its "n of m" read as numbers. */
function readData(block: unknown): Data {
  const data = JSON.parse(String(block).split("\n").slice(1).join("\n")) as Data;
  const [n, of] = String(data.this_call).split(" of ").map(Number);
  return { ...data, window: { n, of } };
}
const dataOf = (i: number) => readData(llm.mock.calls[i][2]);
/** The draft may exist: it is made before the plan's first turn (Breach BR-S1-03, Atlas's order). Nothing is saved into it, quoted,
 *  or kept as the plan. */
const nothingPriced = () => {
  for (const fn of ["save_film", "quote_film", "ai_chat_save_brief"]) expect(called(fn), fn).toHaveLength(0);
};
/** Every reserved turn was finished with a real outcome: none is left pending (0199 would count it forever). */
const everyTurnFinished = () => {
  const finished = called("ai_chat_finish_turn");
  expect(finished).toHaveLength(reserved);
  expect(finished.every((f) => typeof f.p_outcome === "string" && f.p_outcome !== "pending")).toBe(true);
};
const savedScenes = () => (called("save_film")[0].p_patch as { scenes: Record<string, unknown>[] }).scenes;

function setup(target: number, seconds: number[], o: Record<string, unknown> = {}, kind = "short") {
  state.session = { id: SESSION, org_id: ORG, channel_id: "chan-1", slots: slots(target, kind), step: "proposing", card: null, brief: {} };
  state.proposal = { scenarios: [outline(seconds, o), outline(seconds, { title: "Other" })] };
}

beforeEach(() => {
  lease.reset();
  rpc.mockReset();
  llm.mockReset();
  process.env.NIGHTSHIFT_AI_CHAT = "orgs";
  process.env.NIGHTSHIFT_AI_CHAT_ORGS = ORG;
  state.last = null;
  state.quota = { used: 3, limit: 30 };
  state.reserveRefusal = () => null;
  state.answer = exact;
  state.clipModel = null;
  state.clipSpec = null;
  state.trackLast = false;
  pricing.value = { ok: false };
  reserved = 0;
  calls = 0;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("a 1200 s plan", () => {
  it("ten 120 s chapters: several windows, 40–60 scenes adding up to 1200 s, every turn finished ok, nothing started", async () => {
    setup(1200, Array(10).fill(120));
    const res = await choose();
    expect(res.status).toBe(200);
    const d = await res.json();
    const scenes = d.brief.scenes as { id: string; duration_s: number }[];
    expect(scenes.length).toBeGreaterThanOrEqual(40);
    expect(scenes.length).toBeLessThanOrEqual(60);
    expect(scenes.reduce((a, s) => a + s.duration_s, 0)).toBe(1200);
    const r = called("ai_chat_reserve_turn");
    expect(r.length).toBeGreaterThan(1);
    expect(new Set(r.map((x) => x.p_request_id)).size).toBe(r.length);
    expect(r.every((x) => /^[A-Za-z0-9_-]{8,64}$/.test(String(x.p_request_id)))).toBe(true);
    everyTurnFinished();
    expect(called("ai_chat_finish_turn").every((f) => f.p_outcome === "ok")).toBe(true);
    // The windows' data blocks say which window of how many each one is.
    expect(llm.mock.calls.map((_, i) => dataOf(i).window.of)).toEqual(Array(r.length).fill(r.length));
    expect(savedScenes()).toHaveLength(scenes.length);
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain("start_film");
  });

  it("a 1200 s outline opening with two short chapters is planned, not refused for scenes it was never allowed", async () => {
    // Same root cause as brain-plan-edges' window allowance: window 1 holds ch1+ch2 (20 s) and is allowed 1 scene.
    setup(1200, [10, 10, 1180]);
    const res = await choose();
    const d = await res.json();
    // Today: window 1 is answered perfectly, refused as "2 scenes; at most 1", asked again, refused again: plan_length_mismatch.
    expect({ status: res.status, error: d.error ?? null }).toEqual({ status: 200, error: null });
    expect(d.brief).toMatchObject({ target_seconds: 1200 });
  });
});

describe("a window that does not answer", () => {
  it("the vendor timing out on window 3 fails the plan by that window: nothing priced, later windows not reserved, every turn finished", async () => {
    setup(1200, [300, 300, 300, 300]);
    state.answer = (parts, data, n) => (data.window.n === 3 ? { ok: false, error: "timeout", tokensIn: null, tokensOut: null } : exact(parts, data, n));
    const res = await choose();
    expect(res.status).toBe(502);
    const d = await res.json();
    const w = windowsFor(1200, [300, 300, 300, 300]);
    expect(w.length).toBeGreaterThanOrEqual(3);
    expect(d).toMatchObject({ error: "plan_failed", reason: "timeout", step: { window: 3, windows: w.length, chapter: w[2].parts[0].chapter_n, chapters: 4 } });
    nothingPriced();
    everyTurnFinished();
    expect(called("ai_chat_finish_turn").find((f) => f.p_outcome === "vendor_error")).toMatchObject({ p_tokens_in: null, p_tokens_out: null });
    // Only the windows already picked up when it failed: nothing after them is reserved.
    expect(reserved).toBeLessThanOrEqual(d.step.windows);
    expect(d.quota).toMatchObject({ limit: 30 });
  });

  it("the route's own time running out mid-plan stops before a window that could not finish, said as a timeout", async () => {
    // More windows than run at once (five chapters of 240 s, one call each), so the later ones wait for a free slot as the clock runs.
    setup(1200, Array(5).fill(240));
    expect(windowsFor(1200, Array(5).fill(240)).length).toBeGreaterThan(3);
    let t = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);
    // Each call takes 100 s; once a whole call and the work after the plan no longer fit in the route's time (PLAN_BUDGET_MS), no
    // further window is begun (it could not finish).
    state.answer = (parts, data, n) => { t += 100_000; return exact(parts, data, n); };
    const res = await choose();
    expect(res.status).toBe(502);
    const d = await res.json();
    expect(d).toMatchObject({ error: "plan_failed", reason: "timeout" });
    expect(d.step.window).toBeGreaterThan(1);
    expect(reserved).toBeLessThan(d.step.windows);
    nothingPriced();
    everyTurnFinished();
  });

  it("a thrown network error mid-call is a failure with unknown tokens, never a pending turn", async () => {
    setup(60, [60]);
    state.answer = () => { throw new Error("socket hang up"); };
    const res = await choose();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "plan_failed", reason: "unavailable", step: { window: 1 } });
    everyTurnFinished();
    expect(called("ai_chat_finish_turn")[0]).toMatchObject({ p_outcome: "vendor_error", p_tokens_in: null, p_tokens_out: null });
    nothingPriced();
  });
});

describe("a window that answers invalid JSON", () => {
  it("fails the plan as invalid_output with the window named; it is not asked again and never becomes a shorter film", async () => {
    setup(1200, Array(10).fill(120));
    state.answer = (parts, data, n) => (data.window.n === 2 ? ok('{"chapters":[{"id":"ch3","scenes":[{"title":"a",') : exact(parts, data, n));
    const res = await choose();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "plan_failed", reason: "invalid_output",
                                             step: { window: 2, chapter: windowsFor(1200, Array(10).fill(120))[1].parts[0].chapter_n } });
    expect(llm.mock.calls.filter((_, i) => dataOf(i).window.n === 2)).toHaveLength(1);
    expect(called("ai_chat_reserve_turn").some((r) => String(r.p_request_id).endsWith("-w2r"))).toBe(false);
    expect(called("ai_chat_finish_turn").filter((f) => f.p_outcome === "invalid_output")).toHaveLength(1);
    everyTurnFinished();
    nothingPriced();
  });
});

describe("the one re-ask", () => {
  it("window 2 of a multi-window plan off by 5 s is asked again once with the reason and its own id; the re-ask succeeds", async () => {
    setup(1200, Array(10).fill(120));
    let asked = 0;
    state.answer = (parts, data, n) => {
      if (data.window.n !== 2) return exact(parts, data, n);
      asked += 1;
      return asked === 1 ? shortBy(5)(parts, data, n) : exact(parts, data, n);
    };
    const res = await choose();
    expect(res.status).toBe(200);
    expect(asked).toBe(2);
    const again = llm.mock.calls.map((_, i) => dataOf(i)).find((x) => x.window.n === 2 && x.previous_answer_problem);
    const second = windowsFor(1200, Array(10).fill(120))[1].parts[0].chapter_id;
    expect(again?.previous_answer_problem).toMatch(new RegExp(`chapter ${second}: .*must add up to exactly 120 s`));
    // Its own id, derived from the plan's lease attempt (never the browser's press id).
    const r = called("ai_chat_reserve_turn");
    expect(r.filter((x) => /^pl[0-9a-f]{40}-w2r$/.test(String(x.p_request_id)))).toHaveLength(1);
    expect(r.find((x) => String(x.p_request_id).endsWith("-w2r"))).toMatchObject({ p_retry: true, p_text: "" });
    everyTurnFinished();
    expect((await res.json()).brief.scenes.reduce((a: number, s: { duration_s: number }) => a + s.duration_s, 0)).toBe(1200);
  });

  it("a re-ask still wrong is plan_length_mismatch naming the window; no third ask, nothing priced", async () => {
    setup(1200, Array(10).fill(120));
    state.answer = (parts, data, n) => (data.window.n === 2 ? shortBy(5)(parts, data, n) : exact(parts, data, n));
    const res = await choose();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "plan_length_mismatch",
                                             step: { window: 2, chapter: windowsFor(1200, Array(10).fill(120))[1].parts[0].chapter_n, chapters: 10 } });
    expect(llm.mock.calls.filter((_, i) => dataOf(i).window.n === 2)).toHaveLength(2);
    everyTurnFinished();
    nothingPriced();
  });

  it("a re-ask that answers garbage is invalid_output, not a length mismatch", async () => {
    setup(40, [40]);
    state.answer = (parts, data, n) => (n === 1 ? shortBy(10)(parts, data, n) : ok("I could not do that."));
    const res = await choose();
    expect(await res.json()).toMatchObject({ error: "plan_failed", reason: "invalid_output", step: { window: 1 } });
    expect(llm).toHaveBeenCalledTimes(2);
    nothingPriced();
  });

  it("a re-ask whose reservation meets today's cap is the cap's own refusal: nothing priced, no turn left pending", async () => {
    // Begun with the worst case covered (left == at_most); another tab or workspace took a turn meanwhile, so the re-ask meets the
    // cap. The cap's own refusal, with the turns this plan took (Lens M4).
    setup(60, [60]);
    state.quota = { used: 28, limit: 30 };
    state.reserveRefusal = (_a, n) => (n >= 2 ? { code: "NS429", message: "chat_daily_cap", details: "used=30 limit=30" } : null);
    state.answer = (parts, data, n) => (n === 1 ? shortBy(10)(parts, data, n) : exact(parts, data, n));
    const res = await choose();
    expect(res.status).toBe(429);
    const d = await res.json();
    expect(d).toMatchObject({ error: "chat_daily_cap", used: 30, limit: 30 });
    expect(d.quota).toMatchObject({ limit: 30 });
    expect(llm).toHaveBeenCalledTimes(1);
    everyTurnFinished();
    nothingPriced();
  });
});

describe("plan_over_cap at the boundary", () => {
  // Ten 120 s chapters at 1200 s. NEEDED is the worst case, every window asked again once (Atlas: a plan never stops halfway for
  // the cap), counted from the route's own windows so a change to the packing shows here first.
  const WINDOWS = windowsFor(1200, Array(10).fill(120)).length;
  const NEEDED = 2 * WINDOWS;
  it("left == needed begins the plan, and an answer that adds up takes one turn per window", async () => {
    setup(1200, Array(10).fill(120));
    state.quota = { used: 30 - NEEDED, limit: 30 };
    const res = await choose();
    expect(res.status).toBe(200);
    expect(called("ai_chat_reserve_turn")).toHaveLength(WINDOWS);
  });

  it("left == needed - 1 is refused before any turn or vendor call, with both numbers", async () => {
    setup(1200, Array(10).fill(120));
    state.quota = { used: 30 - NEEDED + 1, limit: 30 };
    const res = await choose();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "plan_over_cap", needed: NEEDED, about: WINDOWS, left: NEEDED - 1 });
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
    nothingPriced();
  });

  it("the lifetime trial is held to the same count: trial_left == needed - 1 is refused, == needed begins", async () => {
    setup(1200, Array(10).fill(120));
    state.quota = { used: 0, limit: null, trial_left: NEEDED - 1 };
    // 0232 fix round: on the trial the refusal says scope "trial" (its remedy is a plan, not tomorrow).
    expect(await (await choose()).json()).toEqual({ error: "plan_over_cap", needed: NEEDED, about: WINDOWS, left: NEEDED - 1, scope: "trial" });
    state.quota = { used: 0, limit: null, trial_left: NEEDED };
    expect((await choose({ request_id: "press55555" })).status).toBe(200);
  });

  it("nothing left is the database's own refusal (chat_daily_cap), said as today, with no vendor call", async () => {
    setup(1200, Array(10).fill(120));
    state.quota = { used: 30, limit: 30 };
    state.reserveRefusal = () => ({ code: "NS429", message: "chat_daily_cap", details: "used=30 limit=30" });
    const res = await choose();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "chat_daily_cap", used: 30, limit: 30 });
    expect(llm).not.toHaveBeenCalled();
    nothingPriced();
  });
});

describe("an old stored payload", () => {
  it("scenes that add up are drafted as they are: no plan turn, no vendor call", async () => {
    setup(60, [], { chapters: [], scenes: [storedScene(20), storedScene(20), storedScene(20)] });
    const res = await choose();
    expect(res.status).toBe(200);
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
    expect(savedScenes().map((s) => s.planned_seconds)).toEqual([20, 20, 20]);
    expect(savedScenes()[2]).not.toHaveProperty("clip_params");
  });

  it("scenes that do not add up and no chapters: an old proposal, said as one (ask again), nothing spent", async () => {
    setup(60, [], { chapters: [], scenes: [storedScene(20), storedScene(20)] });
    const res = await choose();
    expect(res.status).toBe(409);
    // Lens L4: not "no longer on screen" while it is on screen.
    expect(await res.json()).toEqual({ error: "proposal_outdated" });
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
    nothingPriced();
  });

  it("scenes that do not add up but chapters that do: the scenes are dropped and the outline is planned afresh", async () => {
    setup(60, [30, 30], { scenes: [storedScene(20), storedScene(20)] });
    const res = await choose();
    expect(res.status).toBe(200);
    expect(called("ai_chat_reserve_turn")).toHaveLength(1);
    expect((await res.json()).brief.scenes.reduce((a: number, s: { duration_s: number }) => a + s.duration_s, 0)).toBe(60);
  });

  it("a stored 35 s scene (longer than a film takes) is not drafted even when the scenes add up", async () => {
    setup(60, [], { chapters: [], scenes: [storedScene(35), storedScene(25)] });
    expect((await choose()).status).toBe(409);
    nothingPriced();
  });
});

describe("a long-kind outline", () => {
  it("takes the Run now path unchanged: no plan turn, no vendor call, no film draft, a brief saved with its price state", async () => {
    setup(600, [300, 300], {}, "long");
    const res = await choose();
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.brief).toMatchObject({ kind: "long", target_seconds: 600, price: { state: "failed" } });
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
    expect(called("ai_chat_quota")).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
    expect(called("create_film_draft")).toHaveLength(0);
    expect(called("ai_chat_save_brief")[0]).toMatchObject({ p_step: "ready" });
  });

  it("a long session with no channel is refused as channel_required, before anything", async () => {
    setup(600, [300, 300], {}, "long");
    state.session = { ...state.session!, channel_id: null };
    const res = await choose();
    expect(await res.json()).toEqual({ error: "channel_required" });
    expect(called("ai_chat_save_brief")).toHaveLength(0);
  });
});

describe("shots from the draft's clip model", () => {
  const clip = (durations: number[] | undefined) => {
    state.clipModel = "clip-model-a";
    state.clipSpec = { output: "video", unit: "second", limits: { max_prompt_chars: 2000, max_concurrent_per_org: 2 }, ...(durations ? { durations_s: durations } : {}) };
  };
  const oneScene = (d: number): Answer => (parts) => ok({ chapters: [{ id: parts[0].id, scenes: [{ title: "x", duration_s: d, visual_prompt: "v" }] }] });

  it("a clip model whose spec lists no lengths: no shot_count on any scene (nothing split on a guess)", async () => {
    setup(30, [30]);
    clip(undefined);
    state.answer = oneScene(30);
    await choose();
    expect(savedScenes()[0]).toMatchObject({ planned_seconds: 30 });
    expect(savedScenes()[0]).not.toHaveProperty("shot_count");
  });

  it("a clip model not on sale here: no shot_count either", async () => {
    setup(30, [30]);
    state.clipModel = "gone-model";
    state.clipSpec = null;
    state.answer = oneScene(30);
    await choose();
    expect(savedScenes()[0]).not.toHaveProperty("shot_count");
  });

  it("10 s shots: a 30 s scene is 3 shots and a 12 s scene is 2", async () => {
    setup(42, [30, 12]);
    clip([5, 10]);
    state.answer = (parts) => ok({ chapters: parts.map((p) => ({ id: p.id, scenes: [{ title: "x", duration_s: p.seconds, visual_prompt: "v" }] })) });
    await choose();
    expect(savedScenes().map((s) => s.shot_count)).toEqual([3, 2]);
  });

  it("35 s in one scene is a length problem asked again, then a mismatch: never drafted as 3 × 10 s", async () => {
    setup(35, [35]);
    clip([10]);
    state.answer = oneScene(35);
    const res = await choose();
    expect(await res.json()).toMatchObject({ error: "plan_length_mismatch" });
    expect(dataOf(1).previous_answer_problem).toMatch(/scene 1 is 35 s; every scene must be 3 to 30 s/);
    nothingPriced();
  });
});

describe("Unicode and long input", () => {
  it("an Uzbek title with ʻ, Cyrillic and emoji is the person's stored choice, and a Retry recognises it as already stored", async () => {
    const title = "Qoʻriqchi va karvon 🐫 Страж";
    setup(60, [60], { title });
    const first = await choose();
    expect(first.status).toBe(200);
    expect(called("ai_chat_reserve_turn")[0]).toMatchObject({ p_text: title, p_retry: false });
    rpc.mockReset();
    state.session = { ...state.session!, step: "proposing" };
    state.last = { id: 50, role: "user", content: title };
    await choose({ request_id: "press77777" });
    expect(called("ai_chat_reserve_turn")[0]).toMatchObject({ p_text: "", p_retry: true });
  });

  it("a malformed index, or a request id that is not 0199's shape, spends nothing", async () => {
    setup(60, [60]);
    for (const index of [-1, 3, 1.5, "0", null]) {
      const res = await choose({ index });
      expect(res.status).toBe(400);
    }
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });
});

describe("the same choice pressed in a second tab while the first is still writing", () => {
  it("does not write the storyboard a second time: one plan's turns, not two", async () => {
    setup(180, [60, 60, 60]);
    state.trackLast = true;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    state.answer = async (parts, data, n) => { await held; return exact(parts, data, n); };
    const tabA = choose({ request_id: "tabApress1" });
    // Tab A's first call has stored the person's choice (0199) and is waiting on the model.
    await vi.waitFor(() => expect(called("ai_chat_reserve_turn").length).toBeGreaterThan(0));
    // Tab B has no sessionStorage of A's press: its own press, its own id. The last message is now the person's choice.
    const tabB = choose({ request_id: "tabBpress1" });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [a, b] = await Promise.all([tabA, tabB]);
    expect(a.status).toBe(200);
    const windows = windowsFor(180, [60, 60, 60]).length;
    // What a second tab may cost is nothing: 0211's lease refuses it (plan_running) before it reserves or calls anything.
    expect({ reserved: called("ai_chat_reserve_turn").length, vendorCalls: llm.mock.calls.length }).toEqual({ reserved: windows, vendorCalls: windows });
    expect(b.status).toBe(409);
    expect((await b.json()).error).toBe("plan_running");
  });
});
