import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakePlanLease } from "./helpers/fakePlanLease";
import { modelText, readScenario, readSlots, unsafeBrief, buildBrief, mergeSlots, type BrainSlots } from "@/lib/brain/logic";
import { planLimits, planNamesVendor, planWindows, readWindow, refsOf, outlineText } from "@/lib/brain/plan";

/**
 * The S1 plan step's fix round (Lens, Breach, Probe and Sentinel on 60540de). What breaks if these fail:
 *   - the plan runs with no lease when 0211 is missing (two tabs, two plans), or an edit made in the film editor mid-plan is
 *     overwritten (plan_superseded), or a refresh after the plan finds no storyboard (M6);
 *   - an outline is begun that no answer could fit into 60 scenes, or two short chapters get one scene between them (M2);
 *   - a style carrying a link, a price or a word the floor refuses reaches every drafted scene (BR01);
 *   - a plan answer says a vendor made the film, or names one the outline never did (BR05), while a film ABOUT a company cannot be
 *     planned at all;
 *   - a price in another currency reaches a picture (BR06); a chapter's start is drawn as 0 s when unknown (M7); a long chapter's
 *     parts are each given the whole chapter's beats (L3).
 */

vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
const ref = (id: string) => createHash("md5").update(`nightshift-chat-model:${id}`).digest("hex");
const lease = fakePlanLease();

const ORG = "11111111-2222-3333-4444-555555555555";
const SESSION = "aaaaaaaa-0000-0000-0000-000000000001";
const FILM = "bbbbbbbb-0000-0000-0000-000000000002";
const SHORT = (target: number, o: Partial<BrainSlots> = {}): BrainSlots => ({ kind: "short", target_seconds: target, aspect: "9:16", style: "noir", language: "English", audience: "teens", ...o });
const outline = (seconds: number[], o: Record<string, unknown> = {}) => ({
  title: "The lost caravan", idea: "A guard must save a caravan.", story: { logline: "l", conflict: "c" },
  characters: [{ id: "c1", name: "Aziz", description: "a guard", image_prompt: "guard" }],
  locations: [{ id: "l1", name: "Dune", description: "dunes", image_prompt: "dunes" }], props: [],
  chapters: seconds.map((s, i) => ({ id: `ch${i + 1}`, title: `Chapter ${i + 1}`, seconds: s, beats: [{ at_s: 0, text: `beat ${i + 1}` }] })),
  ...o,
});

const state = {
  session: null as Record<string, unknown> | null,
  proposal: null as unknown,
  saveFilmError: null as null | { message: string; code?: string },
};
const rpc = vi.fn();
const llm = vi.fn();

function table(name: string) {
  const f: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  for (const m of ["select", "in", "order", "limit", "not", "gte", "neq", "is"]) b[m] = () => b;
  b.eq = (k: string, v: unknown) => { f[k] = v; return b; };
  b.maybeSingle = async () => ({ data: name === "ai_chat_sessions" ? state.session : name === "channels" ? { org_id: ORG, name: "Chan" } : null, error: null });
  b.then = (resolve: (v: unknown) => void) => {
    if (name !== "ai_chat_messages") return resolve({ data: [], error: null });
    return resolve({ data: f.role === "assistant" ? [{ id: 41, payload: state.proposal }] : [{ id: 41, role: "assistant", content: "Pick one" }], error: null });
  };
  return b;
}
const client = {
  from: (t: string) => table(t),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpc(fn, args);
    const leased = lease.rpc(fn, args);
    if (leased) return leased;
    if (fn === "sellable_models") return { data: args.p_capability === "describe" ? [{ id: "anthropic-claude-sonnet-5-5" }] : [], error: null };
    if (fn === "ai_chat_quota") return { data: { used: 3, limit: 30, model_ref: ref("anthropic-claude-sonnet-5-5") }, error: null };
    if (fn === "ai_chat_reserve_turn") return { data: { call_id: `c-${Math.random()}`, used: 4, limit: 30 }, error: null };
    if (fn === "create_film_draft") return { data: { film: { id: FILM, version: 1, clip_model: null }, limits: { max_shots: 3 } }, error: null };
    if (fn === "save_film") return state.saveFilmError ? { data: null, error: state.saveFilmError } : { data: { film: { id: FILM, version: 2 } }, error: null };
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
      const data = JSON.parse(String(a[2]).split("\n").slice(1).join("\n")) as { write_chapters: { id: string; seconds: number }[] };
      return { ok: true, tokensIn: 1, tokensOut: 1, text: JSON.stringify({ chapters: data.write_chapters.map((p) => {
        const k = Math.ceil(p.seconds / 30);
        return { id: p.id, scenes: Array.from({ length: k }, (_, i) => ({ title: `${p.id}-${i}`, visual_prompt: "a shot", duration_s: Math.floor(p.seconds / k) + (i < p.seconds % k ? 1 : 0) })) };
      }) }) };
    },
  };
});

const { POST: routePost } = await import("@/app/api/brain/turn/route");
// The parity suite (tests/helpers/brainStreamParity): JSON as written, or streamed with end.body read as the answer.
const { viaMode } = await import("./helpers/brainStreamParity");
const POST = (r: Request) => viaMode(routePost, r);
const choose = (index = 0) => POST(new Request("https://x/api/brain/turn", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "choose", session: SESSION, index, request_id: "press12345" }) }));
const called = (fn: string) => rpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Record<string, unknown>);
const setup = (target: number, seconds: number[], slots: Partial<BrainSlots> = {}) => {
  state.session = { id: SESSION, org_id: ORG, channel_id: "chan-1", slots: SHORT(target, slots), step: "proposing", card: null, brief: {} };
  state.proposal = { scenarios: [outline(seconds), outline(seconds, { title: "Other" })] };
};

beforeEach(() => {
  lease.reset();
  rpc.mockReset();
  llm.mockReset();
  state.saveFilmError = null;
  process.env.NIGHTSHIFT_AI_CHAT = "orgs";
  process.env.NIGHTSHIFT_AI_CHAT_ORGS = ORG;
});

describe("the lease (0211) around the plan", () => {
  it("a database without 0211 plans nothing: plan_unavailable, before any draft, turn or vendor call", async () => {
    setup(60, [60]);
    lease.state.missing = true;
    const res = await choose();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "plan_unavailable" });
    expect(called("create_film_draft")).toHaveLength(0);
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it("the storyboard is kept (unpriced) before the draft is saved, and the lease is released as done", async () => {
    setup(60, [60]);
    expect((await choose()).status).toBe(200);
    const order = rpc.mock.calls.map((c) => c[0]);
    const briefs = called("ai_chat_save_brief");
    expect(briefs).toHaveLength(2);
    expect((briefs[0].p_brief as { price: { state: string } }).price.state).toBe("unpriced");
    expect(order.indexOf("ai_chat_save_brief")).toBeLessThan(order.indexOf("save_film"));
    // Saved at the version the draft had when the plan began.
    expect(called("save_film")[0].p_version).toBe(1);
    expect(called("ai_chat_plan_end")).toEqual([{ p_session: SESSION, p_attempt: 1, p_state: "done", p_reason: null }]);
  });

  it("an edit made to the draft meanwhile wins: plan_superseded, no priced BRIEF, the lease ended failed", async () => {
    setup(60, [60]);
    state.saveFilmError = { message: "film_changed", code: "NS409" };
    const res = await choose();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("plan_superseded");
    expect(called("quote_film")).toHaveLength(0);
    expect(called("ai_chat_save_brief").filter((b) => (b.p_brief as { price: { state: string } }).price.state === "priced")).toHaveLength(0);
    expect(called("ai_chat_plan_end")[0]).toMatchObject({ p_state: "failed", p_reason: "plan_superseded" });
  });

  it("a failed plan ends its lease failed, and the next press is attempt 2 with new request ids", async () => {
    setup(60, [60]);
    state.saveFilmError = { message: "something_else" };
    await choose();
    const first = String(called("ai_chat_reserve_turn")[0].p_request_id);
    rpc.mockReset();
    state.saveFilmError = null;
    expect((await choose()).status).toBe(200);
    expect(called("ai_chat_plan_end")[0]).toMatchObject({ p_attempt: 2, p_state: "done" });
    expect(String(called("ai_chat_reserve_turn")[0].p_request_id)).not.toBe(first);
  });

  it("the person's own turns across workspaces (returned by the lease) are held to the same up-front rule", async () => {
    setup(60, [60]);
    lease.state.userLeft = 1;
    const res = await choose();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "plan_over_cap", needed: 2, left: 1, scope: "person" });
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
    expect(called("ai_chat_plan_end")[0]).toMatchObject({ p_state: "failed", p_reason: "plan_over_cap" });
  });
});

describe("M2: windows packed by the scenes their parts need", () => {
  const plan = (target: number, seconds: number[]) => planWindows(readScenario(outline(seconds), SHORT(target), { outline: true })!, planLimits(null));

  it("Probe's [10, 10, 1180] is planned, every call with room for each of its parts, and at most 60 scenes in all", () => {
    const w = plan(1200, [10, 10, 1180])!;
    expect(w).not.toBeNull();
    for (const x of w) expect(x.maxScenes).toBeGreaterThanOrEqual(x.parts.reduce((a, p) => a + Math.ceil(p.seconds / 30), 0));
    expect(w.reduce((a, x) => a + x.maxScenes, 0)).toBeLessThanOrEqual(60);
  });

  it("Sentinel's [999, 31 × 5, 46] is planned the same way, or refused before any turn", () => {
    const w = plan(1200, [999, 31, 31, 31, 31, 31, 46]);
    if (w) {
      for (const x of w) {
        expect(x.maxScenes).toBeLessThanOrEqual(15);
        expect(x.maxScenes).toBeGreaterThanOrEqual(x.parts.reduce((a, p) => a + Math.ceil(p.seconds / 30), 0));
      }
      expect(w.reduce((a, x) => a + x.maxScenes, 0)).toBeLessThanOrEqual(60);
    }
  });

  it("an outline that could not fit 60 scenes at the clip model's longest scene is refused up front", () => {
    const o = readScenario(outline([600, 600]), SHORT(1200), { outline: true })!;
    expect(planWindows(o, planLimits({ durations: [3], maxShots: 3 }))).toBeNull();
  });

  it("L3: each part of a long chapter gets its own beats, and where the part before it ended", () => {
    const o = readScenario(outline([400], { chapters: [{ id: "ch1", title: "Long", seconds: 400, beats: [
      { at_s: 10, text: "the ambush" }, { at_s: 210, text: "the chase" }, { at_s: 390, text: "the rescue" }] }] }), SHORT(400), { outline: true })!;
    const parts = planWindows(o, planLimits(null))!.flatMap((x) => x.parts);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].beats.map((b) => b.text)).toEqual(["the ambush"]);
    expect(parts[parts.length - 1].beats.map((b) => b.text)).toContain("the rescue");
    expect(parts[1].previous).toBe("the ambush");
    expect(new Set(parts.flatMap((p) => p.beats.map((b) => b.text))).size).toBe(3);
  });
});

describe("BR01: the style and the audience are the model's words like any other", () => {
  it("a link or a price in them is taken out, and an unsafe style is the floor's", () => {
    const s = mergeSlots({ kind: "short" }, { style: "noir, visit https://evil.example/x, only 5 credits", audience: "fans, 49 GBP off" }).slots;
    expect(s.style).not.toMatch(/https?:|credits/);
    expect(s.audience).not.toMatch(/GBP/);
    const b = buildBrief("s", SHORT(60, { style: "naked noir" }), readScenario(outline([60]), SHORT(60, { style: "naked noir" }))!, "ready");
    expect(unsafeBrief(b)).toBe(true);
  });
});

describe("BR05: a vendor in a plan answer", () => {
  const vendor = (t: string, about = "") => planNamesVendor(t, about);

  it("an authorship claim always fails, in en, ru and uz, Gemini, Google AI and Bard included", () => {
    for (const t of ["Storyboard written by Google Gemini", "made with ChatGPT", "generated using Claude", "powered by Bard",
                     "Gemini wrote this film", "created by Google AI", "Сценарий написан с помощью ChatGPT", "ChatGPT tomonidan yozilgan"]) {
      expect(vendor(t), t).toBe(true);
      // Even when the outline is about that very company.
      expect(vendor(t, "The rise of OpenAI, ChatGPT, Gemini, Claude, Google AI and Bard"), t).toBe(true);
    }
  });

  it("a name the outline does not carry fails; one it does passes: 'The rise of OpenAI' can be planned", () => {
    expect(vendor("A billboard reading OpenAI")).toBe(true);
    expect(vendor("Engineers celebrate in the OpenAI office", "The rise of OpenAI")).toBe(false);
    expect(vendor("Gemini appears on the screen", "The rise of OpenAI")).toBe(true);
  });

  it("held: an outline about OpenAI plans through readWindow", () => {
    const o = readScenario(outline([30], { title: "The rise of OpenAI", idea: "How OpenAI began" }), SHORT(30), { outline: true })!;
    const w = planWindows(o, planLimits(null))![0];
    const answer = JSON.stringify({ chapters: [{ id: "ch1", scenes: [{ duration_s: 30, visual_prompt: "The first OpenAI office, 2015" }] }] });
    expect(readWindow(answer, w, refsOf(o), planLimits(null), outlineText(o)).ok).toBe(true);
  });
});

describe("BR06: a price in any common currency", () => {
  it("is taken out", () => {
    for (const t of ["SALE 49 GBP today", "only ₹499", "pay 500 USDT", "costs 5 bucks", "10 quid", "₺50", "100 KZT", "¥300", "0.01 BTC"]) {
      expect(modelText(t, 200), t).not.toMatch(/\d/);
    }
    // TRY only after a number: before one it is the verb.
    expect(modelText("try 3 more times", 200)).toBe("try 3 more times");
  });
});

describe("M7: an unknown chapter start is absent, never 0", () => {
  it("a long outline's chapters start where the lengths say; without lengths and without a start, none", () => {
    const slots = readSlots({ kind: "long", target_seconds: 300, aspect: "16:9", style: "s", language: "English", audience: "a" });
    const timed = readScenario(outline([100, 200]), slots)!;
    expect(timed.chapters.map((c) => c.start_s)).toEqual([0, 100]);
    const untimed = readScenario({ ...outline([]), chapters: [{ id: "ch1", title: "A", beats: [] }, { id: "ch2", title: "B", start_s: 40, beats: [] }] }, slots)!;
    expect(untimed.chapters[0]).not.toHaveProperty("start_s");
    expect(untimed.chapters[1].start_s).toBe(40);
  });
});
