import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakePlanLease } from "./helpers/fakePlanLease";
/** 0211's plan lease, as the database keeps it (tests/helpers/fakePlanLease.ts). */
const lease = fakePlanLease();

/**
 * The S1 story grammar through /api/brain/turn, fakes only (the harness is tests/brain-turn-route.test.ts's): the answer to the last
 * card proposes in the same turn; a chip's change is the person's answer, merged whatever the model writes; outlines that break the
 * grammar are asked again once as a turn of their own and then refused by name; a film nobody could hear is never offered Create.
 */

vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
const ref = (id: string) => createHash("md5").update(`nightshift-chat-model:${id}`).digest("hex");

const ORG = "11111111-2222-3333-4444-555555555555";
const SESSION = "aaaaaaaa-0000-0000-0000-000000000001";
const FILM = "bbbbbbbb-0000-0000-0000-000000000002";
const FULL_SHORT = { kind: "short", target_seconds: 60, aspect: "9:16", style: "noir", language: "English", audience: "teens" };
const FULL_LONG = { kind: "long", target_seconds: 300, aspect: "16:9", style: "noir", language: "English", audience: "fans" };
const scen = (o: Record<string, unknown> = {}) => ({ title: "T", idea: "I", story: { logline: "", conflict: "" }, credits: 1,
  scenes: [{ title: "a", duration_s: 30, visual_prompt: "v1" }, { title: "b", duration_s: 30, visual_prompt: "v2" }], ...o });

const state = {
  onSale: ["anthropic-claude-sonnet-5-5"],
  reserve: { data: { call_id: "call-1", used: 3, limit: 30 }, error: null } as { data: unknown; error: unknown },
  session: null as Record<string, unknown> | null,
  payload: null as unknown,
  llm: { ok: true, text: "", tokensIn: 10, tokensOut: 20 } as Record<string, unknown>,
  filmOpen: true,
  /** Answers given in order before state.llm (a re-ask's second answer). */
  queue: [] as Record<string, unknown>[],
};
const rpc = vi.fn();
const llm = vi.fn();

function table(name: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "limit", "not", "gte", "neq", "is"]) b[m] = () => b;
  b.maybeSingle = async () => {
    if (name === "ai_chat_sessions") return { data: state.session, error: null };
    if (name === "channels") return { data: { org_id: ORG, name: "Chan" }, error: null };
    return { data: null, error: null };
  };
  b.then = (resolve: (v: unknown) => void) =>
    resolve({ data: name === "ai_chat_messages" ? [{ role: "user", content: "hi", payload: state.payload }] : [], error: null });
  return b;
}
const client = {
  from: (t: string) => table(t),
  rpc: async (fn: string, args: unknown) => {
    rpc(fn, args);
    const leased = lease.rpc(fn, args as Record<string, unknown>);
    if (leased) return leased;
    if (fn === "sellable_models") return { data: state.onSale.map((id) => ({ id })), error: null };
    if (fn === "ai_chat_reserve_turn") return state.reserve;
    // The owner's model reaches the server only as a reference (0199): never the id a member could read.
    if (fn === "ai_chat_quota") return { data: { used: 3, limit: 30, model_ref: ref("anthropic-claude-sonnet-5-5") }, error: null };
    if (fn === "create_film_draft") return { data: { film: { id: FILM, version: 1 } }, error: null };
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
vi.mock("@/lib/server/films", () => ({
  filmGate: async () => (state.filmOpen ? { ok: true, supabase: client, userId: "user-1" } : { ok: false, response: new Response(null, { status: 404 }) }),
}));
vi.mock("@/lib/server/brain/facts", () => ({
  readChannelFacts: async () => ({ state: "none", source: null, name: "Chan", statuses: {}, ownRecent: [], competitorTop: [], audienceAsks: [] }),
}));
vi.mock("@/lib/server/brain/quote", () => ({
  chatPricing: async () => ({ ok: true, spendable: 100, quote: async (l: number) => ({ ok: true, credits: ({ 60: 30, 180: 80, 300: 130 } as Record<number, number>)[l] ?? 999 }) }),
}));
vi.mock("@/lib/server/brain/llm", async () => {
  const real = await vi.importActual<typeof import("@/lib/server/brain/llm")>("@/lib/server/brain/llm");
  return { ...real, chatModelConfigured: () => true, callChatModel: (...a: unknown[]) => { llm(...a); return Promise.resolve(state.queue.length ? state.queue.shift()! : state.llm); } };
});

const { POST } = await import("@/app/api/brain/turn/route");
const post = (body: unknown) => POST(new Request("https://x/api/brain/turn", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const turn = () => post({ action: "turn", session: SESSION, text: "a video like this" });
const called = (fn: string) => rpc.mock.calls.filter((c) => c[0] === fn);

beforeEach(() => {
  lease.reset();
  rpc.mockReset();
  llm.mockReset();
  process.env.NIGHTSHIFT_AI_CHAT = "orgs";
  process.env.NIGHTSHIFT_AI_CHAT_ORGS = ORG;
  state.onSale = ["anthropic-claude-sonnet-5-5"];
  state.reserve = { data: { call_id: "call-1", used: 3, limit: 30 }, error: null };
  state.session = { id: SESSION, org_id: ORG, channel_id: "chan-1", model: "anthropic-claude-sonnet-5-5", slots: {}, step: "asking", card: null, brief: {} };
  state.payload = null;
  state.filmOpen = true;
  state.queue = [];
  state.llm = { ok: true, text: JSON.stringify({ reply: "Which kind?", slots: {}, card: { thread_title: "New video", question: "Long or short?", options: ["Long", "Short", "Not sure"] } }), tokensIn: 10, tokensOut: 20 };
});

import { storyOutline } from "./helpers/storyFixtures";

const ANSWER = (o: Record<string, unknown>) => ({ ok: true, text: JSON.stringify({ reply: "Mana", ...o }), tokensIn: 10, tokensOut: 20 });
const dataOf = (call: number) => JSON.parse(String((llm.mock.calls[call] as unknown[])[2]).split("\n")[1]);

describe("S1 story grammar through /api/brain/turn", () => {
  it("A: the answer to the last card comes back WITH the outlines, in one turn: no second message needed", async () => {
    const prev = { kind: "short", target_seconds: 60, aspect: "9:16", style: "multfilm", language: "Uzbek" };
    state.session = { ...state.session!, slots: prev, card: { id: "q-aud", slot: "audience", options: ["Oilalar", "Bolalar", "Kattalar"] } };
    state.llm = ANSWER({ slots: { audience: "Oilalar" }, scenarios: [storyOutline([15, 15, 15, 15]), storyOutline([10, 20, 20, 10])] });
    const d = await (await post({ action: "answer", session: SESSION, card: "q-aud", choice: 1 })).json();
    expect(dataOf(0)).toMatchObject({ ask_next: "audience", open_slots: ["audience"], last_open_slot: true });
    expect(d.step).toBe("proposing");
    expect(d.scenarios).toHaveLength(2);
    expect(d.card).toBeNull();
    expect(called("ai_chat_reserve_turn")).toHaveLength(1);
    expect(llm).toHaveBeenCalledTimes(1);
    // A story outline is counted with the story pacing: 60 s is 2 windows.
    expect(d.scenarios[0].plan_turns).toEqual({ about: 2, at_most: 4 });
  });

  it("B: inferred slots come back marked, and a chip's change is the person's answer whatever the model writes", async () => {
    state.llm = ANSWER({ slots: { kind: "short", target_seconds: 30, style: "multfilm" }, inferred: { aspect: "9:16", language: "Uzbek", audience: "oilalar" },
                         scenarios: [storyOutline([8, 8, 7, 7]), storyOutline([6, 9, 9, 6])] });
    const first = await (await post({ action: "turn", session: SESSION, text: "Uzoq shaharda ishlaydigan ota va qizi haqida 30 soniyalik multfilm" })).json();
    expect(first.slots.inferred).toEqual(["aspect", "language", "audience"]);
    expect(first.step).toBe("proposing");
    // The chip: the server's own option 1 of [16:9, 9:16, 1:1]; the model says 1:1, the person's 16:9 stands.
    state.session = { ...state.session!, slots: first.slots, step: "proposing" };
    state.llm = ANSWER({ slots: { aspect: "1:1" }, scenarios: [storyOutline([8, 8, 7, 7]), storyOutline([6, 9, 9, 6])] });
    const changed = await (await post({ action: "change", session: SESSION, slot: "aspect", choice: 1 })).json();
    expect(changed.slots.aspect).toBe("16:9");
    expect(changed.slots.inferred).toEqual(["language", "audience"]);
    expect(called("ai_chat_reserve_turn")[1][1]).toMatchObject({ p_text: "Shape: 16:9" });
    // A slot that is not an inference (any more), or a value the server cannot make, is refused before any turn.
    state.session = { ...state.session!, slots: changed.slots };
    expect((await post({ action: "change", session: SESSION, slot: "aspect", choice: 2 })).status).toBe(409);
    expect((await post({ action: "change", session: SESSION, slot: "language", own: "Klingon" })).status).toBe(400);
    expect((await post({ action: "change", session: SESSION, slot: "kind", choice: 1 })).status).toBe(409);
    expect(called("ai_chat_reserve_turn")).toHaveLength(2);
  });

  it("C: outlines that break the grammar are asked again ONCE, as their own turn, with the reason; then refused by name", async () => {
    state.session = { ...state.session!, slots: { kind: "short", target_seconds: 60, aspect: "9:16", style: "x", language: "English", audience: "y" } };
    const bad = storyOutline([15, 15, 15, 15], { hook: "" });
    state.queue = [ANSWER({ scenarios: [bad, bad] })];
    state.llm = ANSWER({ scenarios: [storyOutline([15, 15, 15, 15]), storyOutline([15, 15, 15, 15])] });
    const ok = await (await post({ action: "turn", session: SESSION, text: "a story", request_id: "press-12345678" })).json();
    expect(ok.step).toBe("proposing");
    expect(llm).toHaveBeenCalledTimes(2);
    expect(dataOf(1).previous_answer_problem).toMatch(/hook/);
    const reserves = called("ai_chat_reserve_turn").map((c) => c[1] as Record<string, unknown>);
    expect(reserves).toHaveLength(2);
    expect(reserves[1]).toMatchObject({ p_retry: true, p_text: "", p_request_id: "press-12345678-r" });
    expect(called("ai_chat_finish_turn").map((c) => (c[1] as { p_outcome: string }).p_outcome)).toEqual(["invalid_output", "ok"]);

    rpc.mockReset();
    llm.mockReset();
    state.queue = [ANSWER({ scenarios: [bad, bad] })];
    state.llm = ANSWER({ scenarios: [bad, bad] });
    const res = await post({ action: "turn", session: SESSION, text: "a story" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "story_arc_invalid" });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(called("ai_chat_finish_turn").map((c) => (c[1] as { p_outcome: string }).p_outcome)).toEqual(["invalid_output", "invalid_output"]);
  });

  it("G': a voice-over storyboard is drafted with its narration, and the plan says by name why Create is not offered", async () => {
    state.session = { ...state.session!, slots: FULL_SHORT, step: "proposing" };
    const vo = (t: string) => ({ title: t, duration_s: 30, visual_prompt: "v", speech: "voice_over", narration: "Dad left at dawn." });
    state.payload = { scenarios: [scen({ scenes: [vo("a"), vo("b")] }), scen()] };
    const d = await (await post({ action: "choose", session: SESSION, index: 0 })).json();
    expect(d.brief.voice).toEqual({ mode: "narration", blocked: ["voice_unavailable"] });
    const patch = called("save_film")[0][1] as { p_patch: { scenes: Record<string, unknown>[] } };
    expect(patch.p_patch.scenes[0]).toMatchObject({ narration: "Dad left at dawn." });
    expect(patch.p_patch.scenes[0]).not.toHaveProperty("clip_params");
    expect(String(patch.p_patch.scenes[0].visual_prompt)).toContain("No one speaks; mouths closed.");
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain("start_film");
  });

  it("G': a scene spoken in its clip is refused at Create while the cut drops clip sound; a wordless film is not refused", async () => {
    state.session = { ...state.session!, slots: FULL_SHORT, step: "proposing" };
    const talk = (t: string) => ({ title: t, duration_s: 30, visual_prompt: "v", speech: "in_clip", dialogue: [{ character_id: "c1", line: "Hi" }], character_ids: ["c1"] });
    state.payload = { scenarios: [scen({ characters: [{ id: "c1", name: "A", description: "a", image_prompt: "a" }], scenes: [talk("a"), talk("b")] }), scen()] };
    const d = await (await post({ action: "choose", session: SESSION, index: 0 })).json();
    expect(d.brief.voice.blocked).toEqual(["clip_sound_not_kept"]);
    const quiet = (t: string) => ({ title: t, duration_s: 30, visual_prompt: "v", speech: "none" });
    state.payload = { scenarios: [scen({ scenes: [quiet("a"), quiet("b")] }), scen()] };
    const w = await (await post({ action: "choose", session: SESSION, index: 0 })).json();
    expect(w.brief.voice).toEqual({ mode: "off" });
  });
});
