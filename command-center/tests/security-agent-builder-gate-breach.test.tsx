import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "../lib/orgs-server";

/**
 * Breach, PR #960: the attacks on the operators-only Agent Builder that the PR's own test does not make. The real guards run
 * (guardOperatorPage, requireOperator, currentMfaAction, the middleware's gateDecision); only the session, the organization
 * lookup and the database are faked. What would break without these: an operator whose second factor is still pending opening
 * the builder in `enforce`; a failed operator lookup read as "operator"; a customer telling an existing draft id, a bad id or a
 * body schema apart by the answer, or telling whether NIGHTSHIFT_AGENT_DRAFTS_ENABLED is on (Breach info 1: the role is now asked before
 * the switch); a HEAD/PUT/PATCH/OPTIONS export or a static segment config that serves the builder without
 * the guard; an encoded or trailing-slash path that the middleware lets a signed-out visitor through.
 */

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string; email?: string; factors?: { status: string; factor_type: string }[] } | null,
  org: { supported: false, orgs: [], switchable: [], current: null } as unknown,
  platformAdmin: false as boolean | "error",
  aal: "aal1",
  builderRendered: 0,
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
    if (fn === "is_platform_admin")
      return state.platformAdmin === "error" ? { data: null, error: { message: "boom" } } : { data: state.platformAdmin, error: null };
    state.draftCalls.push(`rpc:${fn}`);
    return { data: null, error: null };
  },
  auth: {
    getUser: async () => ({ data: { user: state.user }, error: null }),
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.aal }, error: null }) },
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
vi.mock("@/components/agent-builder/AgentBuilder", () => ({
  AgentBuilder: () => {
    state.builderRendered += 1;
    return null;
  },
}));

const page = await import("../app/agent-builder/page");
const list = await import("../app/api/agent-builder/drafts/route");
const one = await import("../app/api/agent-builder/drafts/[id]/route");
const { gateDecision, RESERVED_ROOT_SEGMENTS } = await import("../lib/public-paths");

const ORG = { id: "0b000000-0000-0000-0000-00000000000b", name: "B", slug: "b", role: "owner" as const, is_default: false };
const ID = "0b000000-0000-4000-8000-00000000000b";
const ORIGIN = "http://localhost";

function customer() {
  state.user = { id: "u-bob", email: "bob@example.test" };
  state.org = { supported: true, orgs: [ORG], switchable: [ORG], current: ORG };
  state.platformAdmin = false;
}
/** The platform operator, with an authenticator enrolled, who typed the password but not yet the code. */
function operatorMfaPending() {
  state.user = { id: "u-op", email: "op@example.test", factors: [{ status: "verified", factor_type: "totp" }] };
  state.org = { supported: true, orgs: [ORG], switchable: [ORG], current: ORG };
  state.platformAdmin = true;
  state.aal = "aal1";
}

const post = (body: string) =>
  list.POST(new Request(`${ORIGIN}/api/agent-builder/drafts`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body,
  }) as never);
const getOne = (id: string, q = "") =>
  one.GET(new Request(`${ORIGIN}/api/agent-builder/drafts/${id}${q}`), { params: Promise.resolve({ id }) });
const del = (id: string) =>
  one.DELETE(new Request(`${ORIGIN}/api/agent-builder/drafts/${id}`, { method: "DELETE", headers: { origin: ORIGIN } }),
    { params: Promise.resolve({ id }) });
const all = () => [list.GET(), post(JSON.stringify({ document: {} })), getOne(ID), del(ID)];

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NIGHTSHIFT_AGENT_DRAFTS_ENABLED", "on");
  state.user = null;
  state.platformAdmin = false;
  state.aal = "aal1";
  state.builderRendered = 0;
  state.draftCalls = [];
});

describe("an operator whose second factor is pending (NIGHTSHIFT_ADMIN_MFA=enforce)", () => {
  it("the page sends them to the code prompt and draws nothing of the builder", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enforce");
    operatorMfaPending();
    await expect(page.default()).rejects.toThrow("NEXT_REDIRECT:/login/verify");
    expect(state.builderRendered).toBe(0);
  });

  it("every draft route answers 401 mfa_required before any draft is read or written", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enforce");
    operatorMfaPending();
    for (const res of await Promise.all(all())) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "mfa_required" });
    }
    expect(state.draftCalls).toEqual([]);
  });

  it("an operator with no authenticator at all is sent to enrol, not into the builder", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enforce");
    operatorMfaPending();
    state.user!.factors = [];
    await expect(page.default()).rejects.toThrow("NEXT_REDIRECT:/security");
    for (const res of await Promise.all(all())) expect(res.status).toBe(403);
    expect(state.builderRendered).toBe(0);
    expect(state.draftCalls).toEqual([]);
  });
});

describe("a failed operator lookup is not an operator", () => {
  it("is_platform_admin erroring gives the page's 404 and the routes' 403, never the builder or a draft", async () => {
    customer();
    state.platformAdmin = "error";
    await expect(page.default()).rejects.toThrow("NEXT_NOT_FOUND");
    for (const res of await Promise.all(all())) expect(res.status).toBe(403);
    expect(state.builderRendered).toBe(0);
    expect(state.draftCalls).toEqual([]);
  });
});

describe("what a customer can learn from the answers", () => {
  it("a well-formed id, a malformed id, a version probe and a traversal-shaped id all get the same 403 body", async () => {
    customer();
    const answers = await Promise.all([
      getOne(ID), getOne("not-a-uuid"), getOne(ID, "?version=999999"), getOne("..%2F..%2Fadmin"), del(ID), del("x"),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(state.draftCalls).toEqual([]);
  });

  it("a malformed, wrong-shaped or oversized body gets the same 403: the body schema is never validated for a customer", async () => {
    customer();
    const answers = await Promise.all([
      post("{not json"), post("[]"), post(JSON.stringify({ id: "bad", expectedVersion: -1 })), post("x".repeat(400_000)),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    expect(state.draftCalls).toEqual([]);
  });
});

describe("what a customer can learn about the switch", () => {
  it("off, on or unset: a customer gets the same 403 forbidden from every route (the role is asked before the switch)", async () => {
    customer();
    const bodies = new Set<string>();
    for (const flag of ["off", "on", ""]) {
      vi.stubEnv("NIGHTSHIFT_AGENT_DRAFTS_ENABLED", flag);
      for (const res of await Promise.all(all())) {
        expect(res.status).toBe(403);
        bodies.add(JSON.stringify(await res.json()));
      }
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: "forbidden" })]);
    expect(state.draftCalls).toEqual([]);
  });

  it("only an operator hears the switch is off: the public 404", async () => {
    state.user = { id: "u-op", email: "op@example.test" };
    state.org = { supported: true, orgs: [ORG], switchable: [ORG], current: ORG };
    state.platformAdmin = true;
    vi.stubEnv("NIGHTSHIFT_AGENT_DRAFTS_ENABLED", "off");
    for (const res of await Promise.all(all())) expect(res.status).toBe(404);
    expect(state.draftCalls).toEqual([]);
  });
});

describe("no door around the guard", () => {
  it("the route modules export only the guarded methods: HEAD falls back to the guarded GET, no PUT/PATCH/OPTIONS handler", () => {
    for (const mod of [list, one]) {
      const handlers = Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k)).sort();
      expect(handlers.every((h) => ["DELETE", "GET", "POST"].includes(h))).toBe(true);
      expect(mod).not.toHaveProperty("HEAD");
      expect(mod).not.toHaveProperty("PUT");
      expect(mod).not.toHaveProperty("PATCH");
      expect(mod).not.toHaveProperty("OPTIONS");
      expect((mod as { dynamic?: string }).dynamic).toBe("force-dynamic");
      expect(mod).not.toHaveProperty("revalidate");
    }
  });

  it("the page is rendered per request (an RSC or prefetch fetch runs the same guard), never statically", () => {
    expect((page as { dynamic?: string }).dynamic).toBe("force-dynamic");
    expect(page).not.toHaveProperty("revalidate");
    expect(page).not.toHaveProperty("generateStaticParams");
    expect(page).not.toHaveProperty("generateMetadata");
  });

  it("signed out, no variant of the path is public in the middleware", () => {
    for (const p of [
      "/agent-builder", "/agent-builder/", "/%61gent-builder", "/Agent-Builder", "/agent-builder/x",
      "/api/agent-builder/drafts", "/api/agent-builder/drafts/", `/api/agent-builder/drafts/${ID}`, "/api/agent-builder/%64rafts",
    ]) {
      expect(gateDecision(p, false), p).not.toBe("pass");
    }
  });

  it("no customer can name a channel agent-builder", () => {
    expect(RESERVED_ROOT_SEGMENTS).toContain("agent-builder");
  });
});
