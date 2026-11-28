import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakePlanLease } from "./helpers/fakePlanLease";
/** 0211's plan lease, as the database keeps it (tests/helpers/fakePlanLease.ts). */
const lease = fakePlanLease();

/**
 * Breach on the S1 story grammar through /api/brain/turn (harness copied from tests/brain-story-route.test.ts; fakes only, no
 * model, no vendor, no database). BR-SG-01 is fixed: a speaking storyboard is never saved, and a blocked film leaves the chat with no quote id.
 */

vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
const ref = (id: string) => createHash("md5").update(`nightshift-chat-model:${id}`).digest("hex");

const ORG = "11111111-2222-3333-4444-555555555555";
const SESSION = "aaaaaaaa-0000-0000-0000-000000000001";
const FILM = "bbbbbbbb-0000-0000-0000-000000000002";
const FULL_SHORT = { kind: "short", target_seconds: 60, aspect: "9:16", style: "noir", language: "English", audience: "teens" };
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
  /** A replayed draft that already has this many scenes (0166 totals.scenes). */
  draftScenes: 0,
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
    if (fn === "create_film_draft") return { data: { film: { id: FILM, version: 1 }, ...(state.draftScenes ? { totals: { scenes: state.draftScenes } } : {}) }, error: null };
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
  state.draftScenes = 0;
  state.llm = { ok: true, text: JSON.stringify({ reply: "Which kind?", slots: {}, card: { thread_title: "New video", question: "Long or short?", options: ["Long", "Short", "Not sure"] } }), tokensIn: 10, tokensOut: 20 };
});



describe("Breach: a film the chat says cannot be heard is never startable from it (FIXED BR-SG-01)", () => {
  it("BR-SG-01: an in-clip storyboard is refused by name before it is saved: no clip audio paid for, no quote id handed back", async () => {
    state.session = { ...state.session!, slots: FULL_SHORT, step: "proposing" };
    const talk = (t: string) => ({ title: t, duration_s: 30, visual_prompt: "v", speech: "in_clip", dialogue: [{ character_id: "c1", line: "Hi" }], character_ids: ["c1"] });
    state.payload = { scenarios: [scen({ characters: [{ id: "c1", name: "A", description: "a", image_prompt: "a" }], scenes: [talk("a"), talk("b")] }), scen()] };
    const res = await post({ action: "choose", session: SESSION, index: 0 });
    // Only a wordless film can be made today (speechAllowed): a speaking storyboard is never saved to be made silent.
    expect(res.status).toBe(409);
    const d = await res.json();
    expect(d).toEqual({ error: "speech_not_available" });
    expect(called("save_film")).toHaveLength(0);
    expect(called("quote_film")).toHaveLength(0);
    expect(JSON.stringify(d)).not.toMatch(/quote_id/);
  });

  it("BR-SG-01 (defence): a draft that already has a speaking storyboard is re-priced with no quote id the browser could start it with", async () => {
    state.session = { ...state.session!, slots: FULL_SHORT, step: "proposing" };
    const talk = (t: string) => ({ title: t, duration_s: 30, visual_prompt: "v", speech: "in_clip", dialogue: [{ character_id: "c1", line: "Hi" }], character_ids: ["c1"] });
    state.payload = { scenarios: [scen({ characters: [{ id: "c1", name: "A", description: "a", image_prompt: "a" }], scenes: [talk("a"), talk("b")] }), scen()] };
    state.draftScenes = 2;
    const d = await (await post({ action: "choose", session: SESSION, index: 0 })).json();
    expect(d.brief.voice.blocked).toEqual(["clip_sound_not_kept"]);
    expect(called("save_film")).toHaveLength(0);
    expect(d.film_quote?.quote_id).toBeUndefined();
    expect(d.film_quote?.startable).toBe(false);
    expect(d.quote?.quote_id ?? null).toBeNull();
  });
});
