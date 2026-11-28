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
  /** save_film's scenes (0166 film_read), when a test needs them. */
  savedScenes: null as { id: string; position: number }[] | null,
  /** ai_chat_save_sheets' answer (0249); null answers like any other call here (applied, nothing to say). */
  sheetsAnswer: null as { data: unknown; error: unknown } | null,
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
    if (fn === "save_film") return { data: { film: { id: FILM, version: 2 }, ...(state.savedScenes ? { scenes: state.savedScenes } : {}) }, error: null };
    if (fn === "quote_film") return { data: { priced: true, total: 240, quote_id: `fq-2-${"a".repeat(32)}`, startable: true, available: 500 }, error: null };
    if (fn === "ai_chat_save_sheets" && state.sheetsAnswer) return state.sheetsAnswer;
    // Before 0249 the database has no brief_too_large outcome: finish_turn refuses it as invalid_params.
    if (fn === "ai_chat_finish_turn" && size.finishError && (args as { p_outcome?: string }).p_outcome === "brief_too_large") {
      return { data: null, error: { code: "NS400", message: "invalid_params" } };
    }
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
/** When set, the turn's BRIEF measures over the database's 262144 bytes (lib/brain/brief-size), whatever it holds. */
const size = vi.hoisted(() => ({ over: false, finishError: false }));
vi.mock("@/lib/brain/brief-size", async () => {
  const real = await vi.importActual<typeof import("@/lib/brain/brief-size")>("@/lib/brain/brief-size");
  return { ...real, briefBytes: (b: unknown) => (size.over ? real.BRIEF_MAX_BYTES + 1 : real.briefBytes(b)) };
});
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
  state.savedScenes = null;
  state.sheetsAnswer = null;
  size.over = false;
  size.finishError = false;
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
    expect(called("ai_chat_reserve_turn")[1][1]).toMatchObject({ p_text: "Shape: Landscape 16:9" });
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

  it("G': a stored storyboard that speaks where only a wordless film can be made is refused by name, and nothing is saved", async () => {
    state.session = { ...state.session!, slots: FULL_SHORT, step: "proposing" };
    const vo = (t: string) => ({ title: t, duration_s: 30, visual_prompt: "v", speech: "voice_over", narration: "Dad left at dawn." });
    state.payload = { scenarios: [scen({ scenes: [vo("a"), vo("b")] }), scen()] };
    const res = await post({ action: "choose", session: SESSION, index: 0 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "speech_not_available" });
    expect(called("save_film")).toHaveLength(0);
    expect(called("quote_film")).toHaveLength(0);
  });

  it("G': a wordless storyboard is drafted with no clip audio and no narration, and Create is not blocked", async () => {
    state.session = { ...state.session!, slots: FULL_SHORT, step: "proposing" };
    const quiet = (t: string) => ({ title: t, duration_s: 30, visual_prompt: "v", speech: "none", speech_intent: "voice_over" });
    state.payload = { scenarios: [scen({ scenes: [quiet("a"), quiet("b")] }), scen()] };
    const d = await (await post({ action: "choose", session: SESSION, index: 0 })).json();
    expect(d.brief.voice).toEqual({ mode: "off" });
    const patch = called("save_film")[0][1] as { p_patch: { scenes: Record<string, unknown>[] } };
    for (const sc of patch.p_patch.scenes) {
      expect(sc).not.toHaveProperty("clip_params");
      expect(sc.narration).toBe("");
      expect(String(sc.visual_prompt)).toContain("No text, no letters, no signage.");
    }
    expect(d.film_quote.quote_id).toMatch(/^fq-/);
  });

  it("M2: a first answer that took over 120 s is not asked again: refused by name at once, with the one message it used", async () => {
    state.session = { ...state.session!, slots: { kind: "short", target_seconds: 60, aspect: "9:16", style: "x", language: "English", audience: "y" } };
    const bad = storyOutline([15, 15, 15, 15], { hook: "" });
    const now = Date.now;
    let t = 0;
    Date.now = () => (t += 130_000);
    try {
      state.llm = ANSWER({ scenarios: [bad, bad] });
      const res = await post({ action: "turn", session: SESSION, text: "a story" });
      expect(await res.json()).toMatchObject({ error: "story_arc_invalid", used: 1 });
      expect(llm).toHaveBeenCalledTimes(1);
    } finally { Date.now = now; }
  });

  it("a chip's change that ends in story_arc_invalid still stores the person's choice", async () => {
    const slots = { kind: "short", target_seconds: 60, style: "x", aspect: "9:16", language: "English", audience: "y", inferred: ["aspect"] };
    state.session = { ...state.session!, slots, step: "proposing" };
    const bad = storyOutline([15, 15, 15, 15], { hook: "" });
    state.queue = [ANSWER({ scenarios: [bad, bad] })];
    state.llm = ANSWER({ scenarios: [bad, bad] });
    const res = await post({ action: "change", session: SESSION, slot: "aspect", choice: 1 });
    expect(await res.json()).toMatchObject({ error: "story_arc_invalid", used: 2, slots: { aspect: "16:9" } });
    const fin = called("ai_chat_finish_turn").map((c) => c[1] as Record<string, unknown>);
    expect(fin[fin.length - 1]).toMatchObject({ p_outcome: "ok", p_text: "", p_slots: expect.objectContaining({ aspect: "16:9" }) });
  });

  it("a language chip is stored by its name in the app's language (en here), the value merged being the server's", async () => {
    const slots = { kind: "short", target_seconds: 60, style: "x", aspect: "9:16", language: "English", audience: "y", inferred: ["language"] };
    state.session = { ...state.session!, slots, step: "proposing" };
    state.llm = ANSWER({ scenarios: [storyOutline([15, 15, 15, 15]), storyOutline([15, 15, 15, 15])] });
    await post({ action: "change", session: SESSION, slot: "language", choice: 2 });
    expect(called("ai_chat_reserve_turn")[0][1]).toMatchObject({ p_text: "Language: Russian" });
  });

  it("M3: look sheets too long for any shot are refused before the lease and any turn", async () => {
    state.session = { ...state.session!, slots: FULL_SHORT, step: "proposing" };
    const huge = { face: "f".repeat(160), hair: "h".repeat(160), build: "b".repeat(160), outfit: "o".repeat(160), palette: "p".repeat(160), signature: "s".repeat(160) };
    const o = storyOutline([15, 15, 15, 15], { characters: [1, 2, 3].map((i) => ({ id: `c${i}`, name: `N${i}`, description: "d", image_prompt: "i", look: huge })) });
    state.payload = { scenarios: [o, o] };
    const res = await post({ action: "choose", session: SESSION, index: 0 });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "looks_too_long", limit: 2000, in_frame: 3 });
    expect(called("ai_chat_plan_begin")).toHaveLength(0);
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
  });
});

describe("character sheets survive a chat turn (Lens H1)", () => {
  it("a turn's BRIEF carries the stored ref_sheets and film_link, read again just before the write", async () => {
    const sheet = { character_id: "c1", stage: null, views: [{ view: "front", prompt: "p", asset_id: "eeeeeeee-0000-4000-8000-000000000001", status: "approved", attempt: 0 }] };
    const link = { film_id: FILM, scenes: [{ brief: "s1", film: "dddddddd-0000-4000-8000-000000000901" }] };
    state.session = { ...state.session!, step: "ready", brief: { kind: "short", ref_sheets: [sheet], film_link: link } };
    await turn();
    const finish = called("ai_chat_finish_turn").find((c) => (c[1] as { p_outcome?: string }).p_outcome === "ok");
    const brief = (finish![1] as { p_brief: Record<string, unknown> }).p_brief;
    expect(brief.ref_sheets).toEqual([expect.objectContaining({ character_id: "c1", views: [expect.objectContaining({ status: "approved" })] })]);
    expect(brief.film_link).toEqual(link);
  });
});

describe("the draft's film link (Lens M3)", () => {
  it("choosing writes which film scene each BRIEF scene became, from save_film's own answer, with the carried sheets", async () => {
    state.session = { ...state.session!, slots: FULL_SHORT, step: "proposing", brief: { ref_sheets: [{ character_id: "c1", stage: null, views: [] }] } };
    const quiet = (t: string) => ({ title: t, duration_s: 30, visual_prompt: "v", speech: "none" });
    state.payload = { scenarios: [scen({ scenes: [quiet("a"), quiet("b")] }), scen()] };
    state.savedScenes = [{ id: "dddddddd-0000-4000-8000-000000000902", position: 1 }, { id: "dddddddd-0000-4000-8000-000000000901", position: 0 }];
    const d = await (await post({ action: "choose", session: SESSION, index: 0 })).json();
    const saves = called("ai_chat_save_brief").map((c) => (c[1] as { p_brief: Record<string, unknown> }).p_brief);
    const last = saves[saves.length - 1];
    expect(last.film_link).toEqual({ film_id: FILM, scenes: [
      { brief: d.brief.scenes[0].id, film: "dddddddd-0000-4000-8000-000000000901" }, { brief: d.brief.scenes[1].id, film: "dddddddd-0000-4000-8000-000000000902" }] });
    expect(last.ref_sheets).toEqual([{ character_id: "c1", stage: null, views: [] }]);
  });
});

describe("the film link goes through 0249's writer (its trigger keeps a whole-BRIEF write off the link)", () => {
  const choose = async () => {
    state.session = { ...state.session!, slots: FULL_SHORT, step: "proposing", brief: {} };
    const quiet = (t: string) => ({ title: t, duration_s: 30, visual_prompt: "v", speech: "none" });
    state.payload = { scenarios: [scen({ scenes: [quiet("a"), quiet("b")] }), scen()] };
    state.savedScenes = [{ id: "dddddddd-0000-4000-8000-000000000901", position: 0 }, { id: "dddddddd-0000-4000-8000-000000000902", position: 1 }];
    return post({ action: "choose", session: SESSION, index: 0 });
  };

  it("with 0249: written by ai_chat_save_sheets alone (no sheets, no base), right after the BRIEF", async () => {
    state.sheetsAnswer = { data: { ref_sheets: [], film_link: null }, error: null };
    const res = await choose();
    expect(res.status).toBe(200);
    const writes = called("ai_chat_save_sheets").map((c) => c[1] as Record<string, unknown>);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ p_session: SESSION, p_sheets: null, p_base: null, p_film_link: { film_id: FILM } });
    const order = rpc.mock.calls.map((c) => c[0]);
    expect(order.lastIndexOf("ai_chat_save_sheets")).toBeGreaterThan(order.lastIndexOf("ai_chat_save_brief"));
  });

  it("without 0249 (PGRST202): the BRIEF's own copy is the write, and the choice answers as before", async () => {
    state.sheetsAnswer = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    const res = await choose();
    expect(res.status).toBe(200);
    const saves = called("ai_chat_save_brief").map((c) => (c[1] as { p_brief: Record<string, unknown> }).p_brief);
    expect(saves[saves.length - 1].film_link).toMatchObject({ film_id: FILM });
  });

  it("a link 0249 refuses or cannot store is said, never left for attach to read as 'not this film'", async () => {
    state.sheetsAnswer = { data: null, error: { code: "NS400", message: "invalid_film_link" } };
    const res = await choose();
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_film_link");
    state.sheetsAnswer = { data: null, error: { code: "XX000", message: "boom" } };
    const again = await choose();
    expect(again.status).toBe(503);
  });
});

describe("a turn whose own BRIEF is too large to store (Atlas on BR-SW-08)", () => {
  const finishes = () => called("ai_chat_finish_turn").map((c) => c[1] as Record<string, unknown>);

  it("ends the paid call as brief_too_large with its tokens, writes no BRIEF, and answers the remedy's code", async () => {
    size.over = true;
    const res = await turn();
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("brief_too_large");
    const f = finishes();
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ p_outcome: "brief_too_large", p_tokens_in: 10, p_tokens_out: 20, p_brief: null, p_text: null });
  });

  it("before 0249 (no such outcome): the same call is ended output_too_long, also paid, never left pending", async () => {
    size.over = true;
    size.finishError = true;
    const res = await turn();
    expect((await res.json()).error).toBe("brief_too_large");
    expect(finishes().map((f) => f.p_outcome)).toEqual(["brief_too_large", "output_too_long"]);
  });

  it("the panel says the remedy in all three languages: shorten the story or split it into chapters", async () => {
    const { aiChatEn } = await import("@/lib/i18n/ai-chat/en");
    const { aiChatRu } = await import("@/lib/i18n/ai-chat/ru");
    const { aiChatUz } = await import("@/lib/i18n/ai-chat/uz");
    expect(aiChatEn.errors.brief_too_large).toMatch(/Shorten the story or split it into chapters/);
    expect(aiChatRu.errors.brief_too_large).toMatch(/Сократите историю или разделите её на главы/);
    expect(aiChatUz.errors.brief_too_large).toMatch(/Hikoyani qisqartiring yoki uni boblarga boʻling/);
    const { readFileSync } = await import("node:fs");
    const panel = readFileSync(new URL("../components/brain/NightshiftAiPanel.tsx", import.meta.url), "utf8");
    expect(panel).toContain('if (e === "brief_too_large") return c.errors.brief_too_large;');
  });
});
