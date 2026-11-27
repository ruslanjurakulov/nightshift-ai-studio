import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/brain/turn with the customer chat on Gemini Flash (owner, 2026-11-22). What would break: a turn reserved or Google called for
 * someone Google's terms exclude (under 18 or unanswered, a blocked or unreadable country); a missing Gemini key answered by Claude;
 * a Gemini failure retried on another model; a refused Start leaving an empty conversation behind.
 */

vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
const ref = (id: string) => createHash("md5").update(`nightshift-chat-model:${id}`).digest("hex");

const ORG = "11111111-2222-3333-4444-555555555555";
const SESSION = "aaaaaaaa-0000-0000-0000-000000000001";
const GEMINI = "gemini-3.6-flash";

const state = {
  model: GEMINI,
  onSale: [GEMINI, "anthropic-claude-sonnet-5-5"],
  age: "adult" as string,
  country: { country: "UZ", why: "found" } as { country: string | null; why: string },
  llm: { ok: true, text: "", tokensIn: 10, tokensOut: 20 } as Record<string, unknown>,
};
const rpc = vi.fn();
const llm = vi.fn();

function table(name: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "limit", "not", "gte", "neq", "is"]) b[m] = () => b;
  b.maybeSingle = async () => {
    if (name === "ai_chat_sessions") return { data: { id: SESSION, org_id: ORG, channel_id: "chan-1", slots: {}, step: "asking", card: null, brief: {} }, error: null };
    if (name === "channels") return { data: { org_id: ORG, name: "Chan" }, error: null };
    return { data: null, error: null };
  };
  b.then = (resolve: (v: unknown) => void) => resolve({ data: name === "ai_chat_messages" ? [{ role: "user", content: "hi" }] : [], error: null });
  return b;
}
const client = {
  from: (t: string) => table(t),
  rpc: async (fn: string, args: unknown) => {
    rpc(fn, args);
    if (fn === "sellable_models") return { data: state.onSale.map((id) => ({ id })), error: null };
    if (fn === "ai_chat_reserve_turn") return { data: { call_id: "call-1", used: 3, limit: 30 }, error: null };
    // The customer chat's model, as 0199 hands it to the server: a reference to ai_chat_settings.model.
    if (fn === "ai_chat_quota") return { data: { used: 3, limit: 30, model_ref: ref(state.model) }, error: null };
    if (fn === "ai_chat_start") return { data: SESSION, error: null };
    return { data: null, error: null };
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, getUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => ({ ok: true, role: "editor", orgId: ORG, source: "org" }) }));
vi.mock("@/lib/server/same-origin", () => ({ rejectCrossOrigin: () => null }));
vi.mock("@/lib/server/age", () => ({
  readAgeState: async () => (state.age === "absent" ? "unknown" : state.age),
  readAgeAnswer: async () => state.age,
}));
// The country as lib/server/geo reads it from the request; Google's list is lib/geo/blocked's own (never a copy in a test).
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));
vi.mock("@/lib/server/geo", () => ({ readCountry: () => state.country }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: ORG, role: "owner" } }) }));
vi.mock("@/lib/i18n/server", () => ({ getLocale: async () => "en" }));
vi.mock("@/lib/server/films", () => ({ filmGate: async () => ({ ok: true, supabase: client, userId: "user-1" }) }));
vi.mock("@/lib/server/brain/facts", () => ({
  readChannelFacts: async () => ({ state: "none", source: null, name: "Chan", statuses: {}, ownRecent: [], competitorTop: [], audienceAsks: [] }),
}));
vi.mock("@/lib/server/brain/quote", () => ({ chatPricing: async () => ({ ok: false }) }));
// The real model table and key check (chatModelConfigured reads AI_CHAT_GEMINI_API_KEY); only the vendor call is recorded.
vi.mock("@/lib/server/brain/llm", async () => {
  const real = await vi.importActual<typeof import("@/lib/server/brain/llm")>("@/lib/server/brain/llm");
  return { ...real, callChatModel: (...a: unknown[]) => { llm(...a); return Promise.resolve(state.llm); } };
});

const { POST } = await import("@/app/api/brain/turn/route");
const { REPLY_LANGUAGE_RULE } = await import("@/lib/brain/reply-language");
const { NO_PROFESSIONAL_ADVICE_RULE } = await import("@/lib/brain/prompt");
const post = (body: unknown) => POST(new Request("https://x/api/brain/turn", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const turn = () => post({ action: "turn", session: SESSION, text: "a video about rivers" });
const called = (fn: string) => rpc.mock.calls.filter((c) => c[0] === fn);

beforeEach(() => {
  rpc.mockReset();
  llm.mockReset();
  process.env.NIGHTSHIFT_AI_CHAT = "orgs";
  process.env.NIGHTSHIFT_AI_CHAT_ORGS = ORG;
  process.env.AI_CHAT_GEMINI_API_KEY = "test-gemini-key";
  // A Claude key on the server too: the proof that a Gemini problem is never handed to Claude.
  process.env.AI_CHAT_ANTHROPIC_API_KEY = "test-anthropic-key";
  state.model = GEMINI;
  state.onSale = [GEMINI, "anthropic-claude-sonnet-5-5"];
  state.age = "adult";
  state.country = { country: "UZ", why: "found" };
  state.llm = { ok: true, text: JSON.stringify({ reply: "Which kind?", slots: {}, card: { thread_title: "New video", question: "Long or short?", options: ["Long", "Short", "x"] } }), tokensIn: 10, tokensOut: 20 };
});

describe("/api/brain/turn on Gemini Flash", () => {
  it("an adult in a served country gets one Gemini call, after the turn is reserved", async () => {
    const res = await turn();
    expect(res.status).toBe(200);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0][0]).toBe(GEMINI);
    expect(called("ai_chat_reserve_turn")).toHaveLength(1);
    // The reply-language rule and the meter are the route's own, unchanged: the same system prompt and app language go to Gemini,
    // and its tokens reach the finish.
    expect(llm.mock.calls[0][1]).toContain(REPLY_LANGUAGE_RULE);
    // The no-advice rule travels with it: Gemini is told, in the system text, to send medical, legal and money questions to a professional.
    expect(llm.mock.calls[0][1]).toContain(NO_PROFESSIONAL_ADVICE_RULE);
    expect(String(llm.mock.calls[0][2])).toContain('"app_language":"en"');
    expect(called("ai_chat_finish_turn")[0][1]).toMatchObject({ p_outcome: "ok", p_tokens_in: 10, p_tokens_out: 20 });
  });

  it.each([
    [{ country: "RU", why: "found" }, "country_blocked"],
    [{ country: null, why: "not_in_table" }, "country_unverified"],
    [{ country: null, why: "no_address" }, "country_unverified"],
  ])("a turn from %j is refused (%s) before the cap is touched and before any vendor call", async (country, error) => {
    state.country = country;
    const res = await turn();
    expect(res.status).toBe(451);
    expect(await res.json()).toEqual({ error });
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
    expect(called("ai_chat_finish_turn")).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it.each([
    ["none", 428, "adult_attestation_required"],
    ["unknown", 503, "age_unavailable"],
    ["absent", 503, "age_unavailable"],
  ])("an age answer of %s is refused (%i) before the cap and before Google", async (age, status, error) => {
    state.age = age;
    const res = await turn();
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it("a refused Start opens no conversation", async () => {
    state.country = { country: "BY", why: "found" };
    const res = await post({ action: "start", channel: "chan-1", prompt: "a video about rivers" });
    expect(res.status).toBe(451);
    expect(called("ai_chat_start")).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it("without the Gemini key the chat says its model is not set up; Claude, keyed and on sale, is never tried", async () => {
    delete process.env.AI_CHAT_GEMINI_API_KEY;
    const res = await turn();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "model_unavailable", reason: "not_configured" });
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it("a Gemini failure is recorded as Gemini's and said as 'unavailable'; no other model is called", async () => {
    state.llm = { ok: false, error: "vendor_quota", tokensIn: null, tokensOut: null };
    const res = await turn();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "model_failed", reason: "vendor_quota" });
    expect(llm.mock.calls.map((c) => c[0])).toEqual([GEMINI]);
    expect(called("ai_chat_finish_turn")[0][1]).toMatchObject({ p_outcome: "vendor_error" });
  });

  it("Gemini's safety refusal is content_refused, not charged", async () => {
    state.llm = { ok: false, error: "vendor_refused", tokensIn: 9, tokensOut: null };
    const res = await turn();
    expect(res.status).toBe(422);
    const d = await res.json();
    expect(d.error).toBe("content_refused");
    expect(d.quota.used).toBe(2);
  });

  it("Claude as the customer model keeps today's path: no age or country read beyond the minor check", async () => {
    state.model = "anthropic-claude-sonnet-5-5";
    state.country = { country: "RU", why: "found" };
    state.age = "none";
    const res = await turn();
    expect(res.status).toBe(200);
    expect(llm.mock.calls.map((c) => c[0])).toEqual(["anthropic-claude-sonnet-5-5"]);
  });
});
