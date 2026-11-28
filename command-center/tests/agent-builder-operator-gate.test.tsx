import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "../lib/orgs-server";

/**
 * /agent-builder and its draft routes are operators-only until launch (owner decision, 28 Nov). Before this the middleware's
 * "signed in" was the only check, so any customer could open the builder and, with the switch on, save drafts.
 *
 * The real guards run here (guardOperatorPage, requireOperator, the same ones the Providers page and the operator API routes use);
 * only the session, the organization lookup and the database underneath are faked. What would break without these: a customer
 * seeing the builder or reaching a draft route; a customer telling the switch's state from the answer (the role is asked first, so
 * every non-operator gets the same 403 whatever NIGHTSHIFT_AGENT_DRAFTS_ENABLED says); a signed-out visitor no longer sent to
 * /login; and an operator opening the draft routes while the switch is off (it is a second lock, not replaced by the role).
 */

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string; email?: string } | null,
  org: { supported: false, orgs: [], switchable: [], current: null } as unknown,
  platformAdmin: false,
  builderRendered: 0,
  /** Every table read and function call that is not the operator lookup itself: what a refused request must never reach. */
  draftCalls: [] as string[],
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => undefined }),
}));
vi.mock("@/lib/config", () => ({
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  isSupabaseConfigured: true,
}));

function rows(name: string): unknown {
  const q: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => unknown) => res({ data: name === "agent_workflow_drafts" ? [] : null, error: null });
      return () => q;
    },
  });
  return q;
}
const fakeClient = {
  from: (name: string) => {
    state.draftCalls.push(`from:${name}`);
    return rows(name);
  },
  rpc: async (fn: string) => {
    if (fn === "is_platform_admin") return { data: state.platformAdmin, error: null };
    state.draftCalls.push(`rpc:${fn}`);
    return { data: null, error: null };
  },
  auth: {
    getUser: async () => ({ data: { user: state.user }, error: null }),
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" }, error: null }) },
  },
};
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => state.user,
  createClient: async () => fakeClient,
}));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () =>
    state.user ? (state.org as OrgContext) : { supported: false, orgs: [], switchable: [], current: null },
  ORG_COOKIE_OPTIONS: {},
}));
// The builder itself is a large client component and not what is under test: a stub that counts whether it was drawn.
vi.mock("@/components/agent-builder/AgentBuilder", () => ({
  AgentBuilder: () => {
    state.builderRendered += 1;
    return null;
  },
}));

const { default: AgentBuilderPage } = await import("../app/agent-builder/page");
const list = await import("../app/api/agent-builder/drafts/route");
const one = await import("../app/api/agent-builder/drafts/[id]/route");
const { gateDecision } = await import("../lib/public-paths");

const ORG = { id: "0b000000-0000-0000-0000-00000000000b", name: "B", slug: "b", role: "owner" as const, is_default: false };
const ID = "0b000000-0000-4000-8000-00000000000b";
const ORIGIN = "http://localhost";

function signedOut() {
  state.user = null;
  state.platformAdmin = false;
}
/** Signed up and owns their own organization: an admin there, but not the platform operator. */
function customer() {
  state.user = { id: "u-bob", email: "bob@example.test" };
  state.org = { supported: true, orgs: [ORG], switchable: [ORG], current: ORG };
  state.platformAdmin = false;
}
function operator() {
  state.user = { id: "u-op", email: "op@example.test" };
  state.org = { supported: true, orgs: [ORG], switchable: [ORG], current: ORG };
  state.platformAdmin = true;
}

const routes = () => [
  list.GET(),
  list.POST(new Request(`${ORIGIN}/api/agent-builder/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ document: {} }),
  }) as never),
  one.GET(new Request(`${ORIGIN}/api/agent-builder/drafts/${ID}`), { params: Promise.resolve({ id: ID }) }),
  one.DELETE(new Request(`${ORIGIN}/api/agent-builder/drafts/${ID}`, { method: "DELETE", headers: { origin: ORIGIN } }),
    { params: Promise.resolve({ id: ID }) }),
];

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NIGHTSHIFT_AGENT_DRAFTS_ENABLED", "on");
  signedOut();
  state.builderRendered = 0;
  state.draftCalls = [];
});

describe("the /agent-builder page", () => {
  it("a customer gets the public 404 and nothing of the builder is drawn", async () => {
    customer();
    await expect(AgentBuilderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.builderRendered).toBe(0);
  });

  it("the platform operator gets the builder", async () => {
    operator();
    const { renderToStaticMarkup } = await import("react-dom/server");
    renderToStaticMarkup(await AgentBuilderPage());
    expect(state.builderRendered).toBe(1);
  });

  it("signed out: the middleware still sends the visitor to /login, and the page itself redirects there too", async () => {
    expect(gateDecision("/agent-builder", false)).toBe("to-login");
    await expect(AgentBuilderPage()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(state.builderRendered).toBe(0);
  });
});

describe("the draft routes", () => {
  it("a customer gets requireOperator's 403 forbidden from every route, before any draft is read or written", async () => {
    customer();
    for (const res of await Promise.all(routes())) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    expect(state.draftCalls).toEqual([]);
  });

  it.each(["on", "off", ""])("a customer gets the same 403 with the switch %j: the answer does not tell whether it is on", async (flag) => {
    customer();
    vi.stubEnv("NIGHTSHIFT_AGENT_DRAFTS_ENABLED", flag);
    for (const res of await Promise.all(routes())) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    expect(state.draftCalls).toEqual([]);
  });

  it("signed out: 401 unauthorized from every route, switch on or off", async () => {
    vi.stubEnv("NIGHTSHIFT_AGENT_DRAFTS_ENABLED", "off");
    for (const res of await Promise.all(routes())) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    vi.stubEnv("NIGHTSHIFT_AGENT_DRAFTS_ENABLED", "on");
    for (const res of await Promise.all(routes())) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(state.draftCalls).toEqual([]);
  });

  it("an operator with the switch off still gets the public 404: the role does not replace the flag", async () => {
    operator();
    vi.stubEnv("NIGHTSHIFT_AGENT_DRAFTS_ENABLED", "off");
    for (const res of await Promise.all(routes())) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(state.draftCalls).toEqual([]);
  });

  it("an operator with the switch on reaches the drafts", async () => {
    operator();
    const res = await list.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ drafts: [] });
    expect(state.draftCalls).toContain("from:agent_workflow_drafts");
  });
});
