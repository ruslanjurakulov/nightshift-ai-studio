import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/brain, the panel's read before any press, with the customer chat on Gemini Flash. What would break: the panel told the
 * model is "available" to someone Google's conditions refuse (under 18 or unanswered, a blocked or unreadable country), so they type,
 * press, and get a generic "try again" (rule 6); a refusal with no remedy the panel can word; the read itself spending (a reserve or a
 * vendor call); Claude's customers asked for their age or address, which they never were.
 */

vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
import { CHAT_GATE_CODES, isChatGateError, type ChatGateCode } from "@/lib/brain/chat-gate";
const ref = (id: string) => createHash("md5").update(`nightshift-chat-model:${id}`).digest("hex");

const ORG = "11111111-2222-3333-4444-555555555555";
const GEMINI = "gemini-3.6-flash";

const state = {
  model: GEMINI,
  age: "adult" as string,
  country: { country: "UZ", why: "found" } as { country: string | null; why: string },
};
const rpc = vi.fn();
const ageRead = vi.fn();
const llm = vi.fn();

function table(name: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "limit", "not", "gte", "neq", "is"]) b[m] = () => b;
  b.maybeSingle = async () => (name === "channels" ? { data: { org_id: ORG, name: "Chan" }, error: null } : { data: null, error: null });
  b.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  return b;
}
const client = {
  from: (t: string) => table(t),
  rpc: async (fn: string, args: unknown) => {
    rpc(fn, args);
    if (fn === "sellable_models") return { data: [{ id: GEMINI }, { id: "anthropic-claude-sonnet-5-5" }], error: null };
    if (fn === "ai_chat_quota") return { data: { used: 3, limit: 30, max_input_chars: 2000, model_ref: ref(state.model) }, error: null };
    return { data: null, error: null };
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, getUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => ({ ok: true, role: "editor", orgId: ORG, source: "org" }) }));
vi.mock("@/lib/server/age", () => ({ readAgeAnswer: async () => { ageRead(); return state.age; } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));
vi.mock("@/lib/server/geo", () => ({ readCountry: () => state.country }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: ORG, role: "owner" } }) }));
vi.mock("@/lib/server/brain/llm", async () => {
  const real = await vi.importActual<typeof import("@/lib/server/brain/llm")>("@/lib/server/brain/llm");
  return { ...real, callChatModel: (...a: unknown[]) => { llm(...a); return Promise.resolve({ ok: false, error: "vendor_error", tokensIn: null, tokensOut: null }); } };
});

const { GET } = await import("@/app/api/brain/route");
const read = async () => {
  const res = await GET(new Request("https://x/api/brain?channel=chan-1"));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  rpc.mockReset();
  ageRead.mockReset();
  llm.mockReset();
  process.env.NIGHTSHIFT_AI_CHAT = "orgs";
  process.env.NIGHTSHIFT_AI_CHAT_ORGS = ORG;
  process.env.AI_CHAT_GEMINI_API_KEY = "test-gemini-key";
  process.env.AI_CHAT_ANTHROPIC_API_KEY = "test-anthropic-key";
  state.model = GEMINI;
  state.age = "adult";
  state.country = { country: "UZ", why: "found" };
});

describe("GET /api/brain says the gate's verdict before any press", () => {
  it("an adult in a served country: the model is available and nothing stands in the way", async () => {
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body).toMatchObject({ model: "available", gate: null });
  });

  it.each([
    ["age none", { age: "none" }, "adult_attestation_required", "confirm_age"],
    ["age unread", { age: "unknown" }, "age_unavailable", "retry"],
    ["0192 not applied", { age: "absent" }, "age_unavailable", "retry"],
    ["a blocked country", { country: { country: "RU", why: "found" } }, "country_blocked", "not_in_region"],
    ["an unreadable country", { country: { country: null, why: "no_address" } }, "country_unverified", "contact_support"],
    ["a country not in the table", { country: { country: null, why: "not_in_table" } }, "country_unverified", "contact_support"],
  ] as const)("%s: the verdict is %s with the remedy %s, and the read spends nothing", async (_n, patch, code, remedy) => {
    Object.assign(state, patch);
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.gate).toEqual({ code, remedy });
    // The model's own state is unchanged: the refusal is this person's, said by `gate`, not a model that is down.
    expect(body.model).toBe("available");
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain("ai_chat_reserve_turn");
    expect(llm).not.toHaveBeenCalled();
  });

  it("an under-18 answer is said too (adult_only_service), with support as the remedy", async () => {
    state.age = "minor";
    expect((await read()).body.gate).toEqual({ code: "adult_only_service", remedy: "contact_support" });
  });

  it("every one of the gate's four codes has a verdict this route can return", async () => {
    const seen = new Set<string>();
    const cases: Array<Partial<typeof state>> = [
      { age: "none" }, { age: "unknown" }, { country: { country: "RU", why: "found" } }, { country: { country: null, why: "no_address" } },
    ];
    for (const c of cases) {
      state.age = "adult";
      state.country = { country: "UZ", why: "found" };
      Object.assign(state, c);
      seen.add(String(((await read()).body.gate as { code: string }).code));
    }
    expect([...seen].sort()).toEqual([...CHAT_GATE_CODES].sort());
    const typed: ChatGateCode[] = [...CHAT_GATE_CODES];
    expect(typed.every(isChatGateError)).toBe(true);
    expect(isChatGateError("model_failed")).toBe(false);
  });

  it("on Claude nobody is asked their age or address, and the verdict is null whatever they are", async () => {
    state.model = "anthropic-claude-sonnet-5-5";
    state.age = "none";
    state.country = { country: null, why: "no_address" };
    const { body } = await read();
    expect(body).toMatchObject({ model: "available", gate: null });
    expect(ageRead).not.toHaveBeenCalled();
  });
});
