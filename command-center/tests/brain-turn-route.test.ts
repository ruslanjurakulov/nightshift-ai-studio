import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/brain/turn's order is its safety: flag → person → conversation → the owner's model → the database's caps → the vendor → the
 * record; and `choose` prices without spending. These pin what breaks if a step moves: a dead model or a reached cap must never cost
 * a vendor call; a vendor failure never becomes another model; a short film is saved as a DRAFT and quoted, never started; a price
 * is the estimator's or quote_film's, never the model's.
 */

vi.mock("server-only", () => ({}));

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
    if (fn === "sellable_models") return { data: state.onSale.map((id) => ({ id })), error: null };
    if (fn === "ai_chat_reserve_turn") return state.reserve;
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
  return { ...real, chatModelConfigured: () => true, callChatModel: (...a: unknown[]) => { llm(...a); return Promise.resolve(state.llm); } };
});

const { POST } = await import("@/app/api/brain/turn/route");
const post = (body: unknown) => POST(new Request("https://x/api/brain/turn", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const turn = () => post({ action: "turn", session: SESSION, text: "a video like this" });
const called = (fn: string) => rpc.mock.calls.filter((c) => c[0] === fn);

beforeEach(() => {
  rpc.mockReset();
  llm.mockReset();
  process.env.NIGHTSHIFT_AI_CHAT = "orgs";
  process.env.NIGHTSHIFT_AI_CHAT_ORGS = ORG;
  state.onSale = ["anthropic-claude-sonnet-5-5"];
  state.reserve = { data: { call_id: "call-1", used: 3, limit: 30 }, error: null };
  state.session = { id: SESSION, org_id: ORG, channel_id: "chan-1", model: "anthropic-claude-sonnet-5-5", slots: {}, step: "asking", card: null, brief: {} };
  state.payload = null;
  state.filmOpen = true;
  state.llm = { ok: true, text: JSON.stringify({ reply: "Which kind?", slots: {}, card: { thread_title: "New video", question: "Long or short?", options: ["Long", "Short", "Not sure"] } }), tokensIn: 10, tokensOut: 20 };
});

describe("/api/brain/turn", () => {
  it("the owner's model down is refused before the cap is touched, and no other model is tried", async () => {
    state.onSale = ["openai-gpt-6-luna"];
    const res = await turn();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "model_unavailable", reason: "not_on_sale" });
    expect(called("ai_chat_reserve_turn")).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it("a reached cap or a plan without the Brain costs no vendor call", async () => {
    state.reserve = { data: null, error: { code: "NS429", message: "chat_daily_cap", details: "used=30 limit=30" } };
    expect(await (await turn()).json()).toEqual({ error: "chat_daily_cap", used: 30, limit: 30 });
    state.reserve = { data: null, error: { code: "NS402", message: "chat_plan_required" } };
    expect((await turn()).status).toBe(402);
    expect(llm).not.toHaveBeenCalled();
  });

  it("asks the kind first as a card, stores the card and the BRIEF", async () => {
    const d = await (await turn()).json();
    // The kind question's options are the server's own (i18n), whatever the model offered: only what can be made here.
    expect(d.card).toMatchObject({ slot: "kind", options: ["A long YouTube video", "A short film or ad"] });
    const fin = called("ai_chat_finish_turn")[0][1] as Record<string, unknown>;
    expect(fin).toMatchObject({ p_outcome: "ok", p_tokens_in: 10, p_step: "asking" });
    expect((fin.p_card as { slot: string }).slot).toBe("kind");
    expect((fin.p_brief as { version: number; status: string }).status).toBe("drafting");
  });

  it("a vendor failure is recorded with its tokens unknown, says 'unavailable', and is never retried on another model", async () => {
    state.llm = { ok: false, error: "vendor_quota", tokensIn: null, tokensOut: null };
    const res = await turn();
    expect(res.status).toBe(502);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(called("ai_chat_finish_turn")[0][1]).toMatchObject({ p_outcome: "vendor_error", p_tokens_in: null, p_tokens_out: null });
  });

  it("choosing a short scenario saves a DRAFT film and quotes it; it never starts or holds", async () => {
    state.session = { ...state.session!, slots: FULL_SHORT, step: "proposing" };
    state.payload = { scenarios: [scen(), scen({ title: "U" })] };
    const res = await post({ action: "choose", session: SESSION, index: 1 });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.brief.price).toMatchObject({ state: "priced", total_credits: 240, fits: true });
    expect(d.film).toEqual({ id: FILM, version: 2 });
    expect(d.quote.quote_id).toMatch(/^fq-/);
    expect(called("create_film_draft")[0][1]).toMatchObject({ p_org: ORG, p_source_kind: "storyboard" });
    const names = rpc.mock.calls.map((c) => c[0]);
    expect(names).not.toContain("start_film");
    expect(names).not.toContain("reserve_credits");
    expect(JSON.stringify(d.brief)).not.toMatch(/"credits":1[,}]/);
  });

  it("a short film with Film Studio closed is honestly 'not yet', and nothing is created", async () => {
    state.filmOpen = false;
    state.session = { ...state.session!, slots: FULL_SHORT, step: "proposing" };
    state.payload = { scenarios: [scen(), scen()] };
    const res = await post({ action: "choose", session: SESSION, index: 0 });
    expect(await res.json()).toEqual({ error: "short_not_available" });
    expect(called("create_film_draft")).toHaveLength(0);
  });

  it("choosing a long scenario prices it with the Run now estimator and offers the longest length that fits", async () => {
    state.session = { ...state.session!, slots: FULL_LONG, step: "proposing" };
    state.payload = { scenarios: [scen(), scen()] };
    const d = await (await post({ action: "choose", session: SESSION, index: 0 })).json();
    expect(d.brief.price).toEqual({ state: "priced", total_credits: 130, spendable: 100, fits: false, shorter: { target_seconds: 180, credits: 80 } });
    expect(called("create_film_draft")).toHaveLength(0);
  });

  it("an answer must be to the open card", async () => {
    state.session = { ...state.session!, card: { id: "q-1", slot: "kind", options: ["Long", "Short", "x"] } };
    expect((await post({ action: "answer", session: SESSION, card: "q-0", choice: 1 })).status).toBe(409);
    await post({ action: "answer", session: SESSION, card: "q-1", choice: 2 });
    expect(called("ai_chat_reserve_turn")[0][1]).toMatchObject({ p_text: "Short" });
  });
});
