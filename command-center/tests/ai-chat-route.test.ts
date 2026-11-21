import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/ai-chat's order is its safety: flag → person → conversation → model → the database's cap → the vendor → the backend's prices →
 * the record. These pin what breaks if a step moves: a dead model or a reached cap must never cost a vendor call; a vendor failure
 * never quietly becomes the other model; a price on a card is the estimator's, never the model's.
 */

vi.mock("server-only", () => ({}));

const ORG = "11111111-2222-3333-4444-555555555555";
const SESSION = "aaaaaaaa-0000-0000-0000-000000000001";
const state = {
  env: { NIGHTSHIFT_AI_CHAT: "orgs", NIGHTSHIFT_AI_CHAT_ORGS: ORG } as Record<string, string>,
  onSale: ["anthropic-claude-sonnet-5-5", "openai-gpt-6-luna"],
  reserve: { data: { call_id: "call-1", used: 3, limit: 40 }, error: null } as { data: unknown; error: unknown },
  session: { id: SESSION, org_id: ORG, channel_id: "chan-1", model: "anthropic-claude-sonnet-5-5", slots: {}, step: "asking" } as Record<string, unknown> | null,
  llm: { ok: true, text: "", tokensIn: 10, tokensOut: 20 } as Record<string, unknown>,
};
const rpc = vi.fn();
const llm = vi.fn();

function table(name: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "limit", "not", "gte"]) b[m] = () => b;
  b.maybeSingle = async () => {
    if (name === "ai_chat_sessions") return { data: state.session, error: null };
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
    if (fn === "ai_chat_reserve_turn") return state.reserve;
    if (fn === "ai_chat_quota") return { data: { used: 0, limit: 40, max_input_chars: 2000 }, error: null };
    return { data: null, error: null };
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, getUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => ({ ok: true, role: "viewer", orgId: ORG, source: "org" }) }));
vi.mock("@/lib/server/same-origin", () => ({ rejectCrossOrigin: () => null }));
vi.mock("@/lib/server/age", () => ({ readAgeState: async () => "adult" }));
vi.mock("@/lib/i18n/server", () => ({ getLocale: async () => "en" }));
vi.mock("@/lib/server/ai-chat/facts", () => ({
  readChannelFacts: async () => ({ state: "none", name: "Chan", ownRecent: [], competitorTop: [], audienceAsks: [] }),
}));
vi.mock("@/lib/server/ai-chat/quote", () => ({
  chatPricing: async () => ({
    ok: true,
    spendable: 100,
    quote: async (l: number) => ({ ok: true, credits: ({ 60: 30, 180: 80, 300: 130, 600: 250 } as Record<number, number>)[l] ?? 999 }),
  }),
}));
vi.mock("@/lib/server/ai-chat/llm", async () => {
  const real = await vi.importActual<typeof import("@/lib/server/ai-chat/llm")>("@/lib/server/ai-chat/llm");
  return { ...real, chatModelConfigured: () => true, callChatModel: (...a: unknown[]) => { llm(...a); return Promise.resolve(state.llm); } };
});

const { GET, POST } = await import("@/app/api/ai-chat/route");
const post = (body: unknown) => POST(new Request("https://x/api/ai-chat", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const turn = () => post({ action: "turn", session: SESSION, text: "a video like this" });
const called = (fn: string) => rpc.mock.calls.filter((c) => c[0] === fn);
const FULL = { length_s: 300, style: "noir", platform: "youtube", language: "English", audience: "history fans" };
const scen = (o: Record<string, unknown> = {}) => ({ title: "T", hook: "H", beats: ["a", "b", "c"], length_s: 300, style: "noir", credits: 1, ...o });

beforeEach(() => {
  rpc.mockReset();
  llm.mockReset();
  for (const [k, v] of Object.entries(state.env)) process.env[k] = v;
  process.env.NIGHTSHIFT_AI_CHAT = "orgs";
  state.onSale = ["anthropic-claude-sonnet-5-5", "openai-gpt-6-luna"];
  state.reserve = { data: { call_id: "call-1", used: 3, limit: 40 }, error: null };
  state.session = { id: SESSION, org_id: ORG, channel_id: "chan-1", model: "anthropic-claude-sonnet-5-5", slots: FULL, step: "asking" };
  state.llm = { ok: true, text: JSON.stringify({ reply: "Two ideas", slots: {}, scenarios: [scen(), scen({ title: "U", length_s: 180 })] }), tokensIn: 10, tokensOut: 20 };
});

describe("/api/ai-chat", () => {
  it("is not there at all when the flag does not open this workspace", async () => {
    process.env.NIGHTSHIFT_AI_CHAT = "off";
    expect((await GET(new Request("https://x/api/ai-chat?channel=chan-1"))).status).toBe(404);
    expect((await turn()).status).toBe(404);
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it("a model that is not on sale is refused before the cap is touched or a vendor is called", async () => {
    state.onSale = ["openai-gpt-6-luna"];
    const res = await turn();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "model_unavailable", reason: "not_on_sale" });
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it("the daily cap is the database's, and a reached cap costs no vendor call", async () => {
    state.reserve = { data: null, error: { code: "NS429", message: "chat_daily_cap", details: "used=40 limit=40" } };
    const res = await turn();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "chat_daily_cap", used: 40, limit: 40 });
    expect(llm).not.toHaveBeenCalled();
  });

  it("prices come from the estimator, the longest fitting length is offered, and the model's price is never read", async () => {
    const res = await turn();
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.step).toBe("proposing");
    expect(d.scenarios.map((s: { price: unknown }) => s.price)).toEqual([
      { state: "priced", credits: 130, fits: false },
      { state: "priced", credits: 80, fits: true },
    ]);
    expect(d.advice["300"]).toEqual({ state: "shorter", length_s: 180, credits: 80 });
    expect(JSON.stringify(d.scenarios)).not.toMatch(/"credits":1[,}]/);
    const fin = called("ai_chat_finish_turn")[0][1] as Record<string, unknown>;
    expect(fin).toMatchObject({ p_call: "call-1", p_outcome: "ok", p_tokens_in: 10, p_tokens_out: 20, p_step: "proposing" });
    // The turn never reached a spend.
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain("reserve_credits");
  });

  it("a vendor failure is that model's failure: recorded, said with its remedy, and never retried on the other model", async () => {
    state.llm = { ok: false, error: "vendor_quota", tokensIn: null, tokensOut: null };
    const res = await turn();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "model_failed", reason: "vendor_quota", model: "anthropic-claude-sonnet-5-5" });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0][0]).toBe("anthropic-claude-sonnet-5-5");
    expect((called("ai_chat_finish_turn")[0][1] as Record<string, unknown>).p_outcome).toBe("vendor_error");
  });

  it("an answer that is not our JSON fails the turn honestly", async () => {
    state.llm = { ok: true, text: "Sure, here you go!", tokensIn: 1, tokensOut: 1 };
    const res = await turn();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "model_answer_invalid" });
    expect((called("ai_chat_finish_turn")[0][1] as Record<string, unknown>).p_outcome).toBe("invalid_output");
  });

  it("asks before it proposes: with slots missing, scenarios are dropped and nothing is priced", async () => {
    state.session = { ...state.session!, slots: {} };
    const d = await (await turn()).json();
    expect(d.step).toBe("asking");
    expect(d.scenarios).toEqual([]);
    expect(d.missing.length).toBeGreaterThan(0);
  });
});
