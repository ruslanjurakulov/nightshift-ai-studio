import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakePlanLease } from "./helpers/fakePlanLease";
import { planLimits, planWindows } from "@/lib/brain/plan";
import { readScenario, readSlots } from "@/lib/brain/logic";
import { readStreamLines, type BrainStreamEvent } from "@/lib/brain/stream-events";
import { endAsResponse, viaMode } from "./helpers/brainStreamParity";

/**
 * POST /api/brain/turn as a stream (docs/studio/LIVE_CREATION_PLAN.md §3.1, §3.2, §4 row 3), against a fake database and a fake
 * model. What breaks if these fail: the switch off no longer being today's route byte for byte; a window shown before its checks
 * passed, twice, or out of range; end.body differing from the JSON answer; a refusal that was a plain 409/429 turned into a 200
 * stream; a person who closes the tab mid-plan leaving the plan unsaved, its lease unreleased or its turns unfinished; the lab's fake
 * vendor honoured (or silently ignored) in production.
 */

const lease = fakePlanLease();
vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
const ref = (id: string) => createHash("md5").update(`nightshift-chat-model:${id}`).digest("hex");

const ORG = "11111111-2222-3333-4444-555555555555";
const SESSION = "aaaaaaaa-0000-0000-0000-000000000001";
const FILM = "bbbbbbbb-0000-0000-0000-000000000002";
const RID = "press12345";
const slots = (target: number) => ({ kind: "short", target_seconds: target, aspect: "9:16", style: "noir", language: "English", audience: "teens" });
const outline = (seconds: number[]) => ({
  title: "The lost caravan", idea: "A guard must save a caravan.", story: { logline: "l", conflict: "c" },
  characters: [{ id: "c1", name: "Aziz", description: "a guard", image_prompt: "guard" }],
  locations: [{ id: "l1", name: "Dune", description: "dunes", image_prompt: "dunes" }], props: [],
  chapters: seconds.map((s, i) => ({ id: `ch${i + 1}`, title: `Chapter ${i + 1}`, seconds: s, beats: [{ at_s: 0, text: "beat" }] })),
});

type Part = { id: string; seconds: number };
type Answer = (parts: Part[], data: Record<string, unknown>, call: number) => Record<string, unknown>;
/** A model that obeys: each part as ~10 s wordless scenes within the call's limit, adding up exactly. */
const exact: Answer = (parts, data) => ({ ok: true, tokensIn: 100, tokensOut: 200, text: JSON.stringify({ chapters: parts.map((p) => {
  const room = Math.max(1, Math.floor(Number((data.limits as { max_scenes: number }).max_scenes) / parts.length));
  const k = Math.max(Math.ceil(p.seconds / 30), Math.min(room, Math.ceil(p.seconds / 10)));
  const lens = Array.from({ length: k }, (_, i) => Math.floor(p.seconds / k) + (i < p.seconds % k ? 1 : 0));
  return { id: p.id, scenes: lens.map((d, j) => ({ title: `${p.id}-${j}`, duration_s: d, visual_prompt: `shot of ${p.id}`, character_ids: ["c1"], location_id: "l1", dialogue: [] })) };
}) }) });

const state = {
  session: null as Record<string, unknown> | null,
  proposal: null as unknown,
  onSale: true,
  reserveError: null as unknown,
  answer: exact as Answer,
  delayMs: 5,
  turnLlm: { ok: true, tokensIn: 10, tokensOut: 20, text: JSON.stringify({ reply: "Which kind?", slots: {}, card: { thread_title: "New", question: "Long or short?", options: ["Long", "Short", "Not sure"] } }) } as Record<string, unknown>,
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
    return resolve({ data: [{ id: 41, role: "assistant", content: "Pick one" }], error: null });
  };
  return b;
}
const client = {
  from: (t: string) => table(t),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpc(fn, args);
    const leased = lease.rpc(fn, args);
    if (leased) return leased;
    if (fn === "sellable_models") {
      if (args.p_capability !== "describe") return { data: [], error: null };
      return { data: state.onSale ? [{ id: "anthropic-claude-sonnet-5-5" }] : [], error: null };
    }
    if (fn === "ai_chat_quota") return { data: { used: 3, limit: 30, model_ref: ref("anthropic-claude-sonnet-5-5") }, error: null };
    if (fn === "ai_chat_reserve_turn") {
      if (state.reserveError) return { data: null, error: state.reserveError };
      reserved += 1;
      return { data: { call_id: `call-${reserved}`, used: 3 + reserved, limit: 30 }, error: null };
    }
    if (fn === "create_film_draft") return { data: { film: { id: FILM, version: 1, clip_model: null }, limits: { max_shots: 3 } }, error: null };
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
vi.mock("@/lib/server/brain/quote", () => ({ chatPricing: async () => ({ ok: false }) }));
vi.mock("@/lib/server/brain/google-gate", () => ({ chatModelGate: async () => null }));
vi.mock("@/lib/server/brain/llm", async () => {
  const real = await vi.importActual<typeof import("@/lib/server/brain/llm")>("@/lib/server/brain/llm");
  return {
    ...real, chatModelConfigured: () => true,
    callChatModel: async (...a: unknown[]) => {
      llm(...a);
      if ((a[3] as { size?: string } | undefined)?.size !== "plan") return state.turnLlm;
      const data = JSON.parse(String(a[2]).split("\n").slice(1).join("\n")) as Record<string, unknown>;
      const parts = (data.write_chapters as { id: string; seconds: number }[]).map((p) => ({ id: p.id, seconds: p.seconds }));
      calls += 1;
      const n = calls;
      await new Promise((r) => setTimeout(r, state.delayMs));
      return state.answer(parts, data, n);
    },
  };
});

const { POST } = await import("@/app/api/brain/turn/route");
const req = (body: Record<string, unknown>) => new Request("https://x/api/brain/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const chooseBody = (o: Record<string, unknown> = {}) => ({ action: "choose", session: SESSION, index: 0, request_id: RID, ...o });
const turnBody = (o: Record<string, unknown> = {}) => ({ action: "turn", session: SESSION, text: "a video like this", ...o });
const called = (fn: string) => rpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Record<string, unknown>);
const names = () => rpc.mock.calls.map((c) => c[0] as string);
async function eventsOf(res: Response): Promise<BrainStreamEvent[]> {
  const out: BrainStreamEvent[] = [];
  for await (const e of readStreamLines(res.body!)) out.push(e);
  return out;
}

function setupChoose(target: number, seconds: readonly number[]) {
  state.session = { id: SESSION, org_id: ORG, channel_id: "chan-1", slots: slots(target), step: "proposing", card: null, brief: {} };
  state.proposal = { scenarios: [outline([...seconds]), { ...outline([...seconds]), title: "Other" }] };
}
function setupTurn() {
  state.session = { id: SESSION, org_id: ORG, channel_id: "chan-1", slots: {}, step: "asking", card: null, brief: {} };
}
function reset() {
  lease.reset();
  rpc.mockReset();
  llm.mockReset();
  state.onSale = true;
  state.reserveError = null;
  state.answer = exact;
  state.delayMs = 5;
  calls = 0;
  reserved = 0;
}

beforeEach(() => {
  reset();
  process.env.NIGHTSHIFT_AI_CHAT = "orgs";
  process.env.NIGHTSHIFT_AI_CHAT_ORGS = ORG;
  delete process.env.NIGHTSHIFT_AI_STREAM;
  delete process.env.NIGHTSHIFT_AI_LAB;
  delete process.env.NIGHTSHIFT_AI_FAKE_BASE_URL;
});

/** 1200 s in four 300 s chapters: several windows, each chapter split into parts (the case "chapter n of N" must count right). */
const LONG = [1200, [300, 300, 300, 300]] as const;
const windowsOf = (target: number, seconds: readonly number[]) =>
  planWindows(readScenario(outline([...seconds]), readSlots(slots(target)))!, planLimits(null))!.length;

describe("off: today's route, byte for byte", () => {
  it.each([[undefined, undefined], ["off", undefined], ["lab", undefined], ["lab", "true"], ["nonsense", "1"]])(
    "NIGHTSHIFT_AI_STREAM=%s (lab %s): a press asking for the stream gets the same bytes, headers and database calls as one that does not",
    async (mode, lab) => {
      if (mode !== undefined) process.env.NIGHTSHIFT_AI_STREAM = mode;
      if (lab !== undefined) process.env.NIGHTSHIFT_AI_LAB = lab;
      setupChoose(...LONG);
      const plain = await POST(req(chooseBody()));
      const plainText = await plain.text();
      const plainCalls = names();
      reset();
      setupChoose(...LONG);
      const asked = await POST(req(chooseBody({ stream: true })));
      expect(asked.status).toBe(plain.status);
      expect(asked.headers.get("content-type")).toBe("application/json");
      expect([...asked.headers.entries()]).toEqual([...plain.headers.entries()]);
      expect(await asked.text()).toBe(plainText);
      expect(names()).toEqual(plainCalls);
    });
});

describe("on: the stream", () => {
  beforeEach(() => { process.env.NIGHTSHIFT_AI_STREAM = "on"; });

  it("choose: planning, plan.begun with the real counts, each checked window once, saving, pricing, then end", async () => {
    setupChoose(...LONG);
    const n = windowsOf(...LONG);
    expect(n).toBeGreaterThan(1);
    const res = await POST(req(chooseBody({ stream: true })));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const ev = (await eventsOf(res)).filter((e) => e.type !== "ping");
    const types = ev.map((e) => (e.type === "phase" ? `phase:${e.phase}` : e.type));
    expect(types).toEqual(["phase:planning", "plan.begun", ...Array(n).fill("plan.window"), "phase:saving", "phase:pricing", "end"]);
    const begun = ev[1] as Extract<BrainStreamEvent, { type: "plan.begun" }>;
    // The plan's own worst case and usual count (planTurns), the same numbers the lease reserved.
    expect(begun).toMatchObject({ windows: n, chapters: 4 });
    expect(begun.at_most).toBeGreaterThanOrEqual(n);
    const windows = ev.filter((e) => e.type === "plan.window") as Extract<BrainStreamEvent, { type: "plan.window" }>[];
    expect(windows.map((w) => w.n).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    for (const w of windows) {
      expect(w).toMatchObject({ of: n, index: w.n - 1 });
      // Checked units: each part's scenes add up to its seconds, and every chapter is covered by all of its parts.
      for (const p of w.parts) expect(p.scenes.length).toBeGreaterThan(0);
    }
    const parts = windows.flatMap((w) => w.parts);
    for (const ch of [1, 2, 3, 4]) {
      const mine = parts.filter((p) => p.chapter_n === ch);
      expect(new Set(mine.map((p) => p.part)).size).toBe(mine[0].parts);
      expect(mine.flatMap((p) => p.scenes).reduce((a, s) => a + (s.seconds ?? 0), 0)).toBe(300);
    }
    // Each window is emitted after its turn was finished "ok": as many windows as ok finishes.
    expect(called("ai_chat_finish_turn").filter((f) => f.p_outcome === "ok")).toHaveLength(n);
    const end = ev[ev.length - 1] as Extract<BrainStreamEvent, { type: "end" }>;
    expect(end.status).toBe(200);
    expect(end.body).toMatchObject({ film: { id: FILM, version: 2 }, brief: { price: { state: "priced", total_credits: 240 } } });
  });

  it("end.body is exactly the JSON body, and end.status the JSON status, for an answer and for a failure after the stream began", async () => {
    for (const fail of [false, true]) {
      reset();
      setupChoose(...LONG);
      // A model that answers the second window wrongly twice: the plan fails after windows were already shown.
      if (fail) state.answer = (p, d, call) => (call === 2 || call > windowsOf(...LONG) ? { ok: true, tokensIn: 1, tokensOut: 1, text: "{}" } : exact(p, d, call));
      const json = await viaMode(POST, req(chooseBody()), "json");
      const jsonBody = await json.json();
      reset();
      setupChoose(...LONG);
      if (fail) state.answer = (p, d, call) => (call === 2 || call > windowsOf(...LONG) ? { ok: true, tokensIn: 1, tokensOut: 1, text: "{}" } : exact(p, d, call));
      const raw = await POST(req(chooseBody({ stream: true })));
      expect(raw.status).toBe(200);
      const streamed = await endAsResponse(raw);
      expect(streamed.status).toBe(json.status);
      expect(await streamed.json()).toEqual(jsonBody);
      if (fail) expect(json.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("a window whose own words the safety floor refuses is never shown: the merged storyboard's refusal is only said in end", async () => {
    setupChoose(...LONG);
    state.answer = (p, d, call) => {
      const a = exact(p, d, call);
      if (call !== 2) return a;
      const t = JSON.parse(String(a.text)) as { chapters: { scenes: { visual_prompt: string }[] }[] };
      t.chapters[0].scenes[0].visual_prompt = "batman leaps across the dunes";
      return { ...a, text: JSON.stringify(t) };
    };
    const ev = await eventsOf(await POST(req(chooseBody({ stream: true }))));
    const windows = ev.filter((e) => e.type === "plan.window") as Extract<BrainStreamEvent, { type: "plan.window" }>[];
    expect(windows.length).toBe(windowsOf(...LONG) - 1);
    expect(JSON.stringify(windows)).not.toMatch(/batman/i);
    expect(ev[ev.length - 1]).toMatchObject({ type: "end", status: 422, body: expect.objectContaining({ error: "content_refused" }) });
    expect(called("save_film")).toHaveLength(0);
  });

  it("a turn: thinking when the vendor is called, then end with today's answer", async () => {
    setupTurn();
    const res = await POST(req(turnBody({ stream: true })));
    const ev = (await eventsOf(res)).filter((e) => e.type !== "ping");
    expect(ev.map((e) => e.type)).toEqual(["phase", "end"]);
    expect(ev[0]).toEqual({ type: "phase", phase: "thinking" });
    expect(ev[1]).toMatchObject({ type: "end", status: 200, body: { reply: "Which kind?", step: "asking" } });
  });

  it("a press that does not ask for the stream is answered as JSON even with the switch on", async () => {
    setupTurn();
    const res = await POST(req(turnBody()));
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toMatchObject({ reply: "Which kind?" });
  });

  it("lab streams on the lab server", async () => {
    process.env.NIGHTSHIFT_AI_STREAM = "lab";
    process.env.NIGHTSHIFT_AI_LAB = "1";
    setupTurn();
    const res = await POST(req(turnBody({ stream: true })));
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
  });

  it("a refusal before anything was emitted keeps today's plain JSON and status: a model off sale, a reached cap, a plan already running", async () => {
    setupTurn();
    state.onSale = false;
    let res = await POST(req(turnBody({ stream: true })));
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toMatchObject({ error: "model_unavailable" });

    state.onSale = true;
    state.reserveError = { code: "NS429", message: "chat_daily_cap", details: "used=30 limit=30" };
    res = await POST(req(turnBody({ stream: true })));
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "chat_daily_cap", used: 30, limit: 30 });
    expect(llm).not.toHaveBeenCalled();

    // Another tab's plan holds 0211's lease: plan_running, as today, with nothing emitted or spent.
    state.reserveError = null;
    setupChoose(...LONG);
    state.delayMs = 30;
    const first = POST(req(chooseBody({ stream: true, request_id: "press-first" })));
    await vi.waitFor(() => expect(called("ai_chat_reserve_turn").length).toBeGreaterThan(0));
    res = await POST(req(chooseBody({ stream: true, request_id: "press-second" })));
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toMatchObject({ error: "plan_running" });
    await eventsOf(await first);
  });

  it("a person who leaves mid-plan: the plan still runs to the end, is saved, priced, kept and its lease released as done", async () => {
    setupChoose(...LONG);
    state.delayMs = 25;
    const n = windowsOf(...LONG);
    const res = await POST(req(chooseBody({ stream: true })));
    const reader = res.body!.getReader();
    let seen = "";
    while (!seen.includes("plan.begun")) seen += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    // Nothing had been saved when the reader left.
    expect(called("save_film")).toHaveLength(0);
    await vi.waitFor(() => expect(called("ai_chat_plan_end")).toEqual([{ p_session: SESSION, p_attempt: 1, p_state: "done", p_reason: null }]), { timeout: 5000 });
    expect(called("ai_chat_reserve_turn")).toHaveLength(n);
    expect(called("ai_chat_finish_turn").filter((f) => f.p_outcome === "ok")).toHaveLength(n);
    expect(called("save_film")).toHaveLength(1);
    expect(called("quote_film")).toHaveLength(1);
    const briefs = called("ai_chat_save_brief");
    expect(briefs).toHaveLength(2);
    expect((briefs[1].p_brief as { price: { state: string } }).price.state).toBe("priced");
  });
});

describe("the lab's fake vendor in production", () => {
  it("set without the lab flag: every turn and every choice is refused by name before any turn is reserved or any vendor called", async () => {
    process.env.NIGHTSHIFT_AI_FAKE_BASE_URL = "http://127.0.0.1:9911";
    for (const stream of [undefined, "on"]) {
      if (stream) process.env.NIGHTSHIFT_AI_STREAM = stream;
      setupTurn();
      let res = await POST(req(turnBody({ stream: true })));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "model_unavailable", reason: "fake_vendor_unflagged" });
      setupChoose(...LONG);
      res = await POST(req(chooseBody({ stream: true })));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "model_unavailable", reason: "fake_vendor_unflagged" });
    }
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
    expect(called("ai_chat_plan_begin")).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });
});
