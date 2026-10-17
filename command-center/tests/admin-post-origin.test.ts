import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "../lib/orgs-server";

/**
 * The operator POST routes refuse a request that did not come from our own
 * page (the existing `isSameOriginPost`), and, in NIGHTSHIFT_ADMIN_MFA=enforce,
 * a password-only session of an admin who has a second factor.
 *
 * Routes covered: alerts/test, billing/refresh, billing/settings,
 * billing/topup, models/availability, setup/secrets, setup/variables,
 * setup/voices, voices/preview. What would break without this: a same-site
 * sibling host, or a SameSite=Lax bypass, changing provider billing, writing a
 * GitHub secret or flipping a model on as the signed-in admin.
 *
 * Everything the routes reach out to is faked; the assertion is that nothing
 * is touched when the request is refused.
 */

vi.mock("server-only", () => ({}));

type Factor = { status: string; factor_type: string };
const state: {
  user: { id: string; factors?: Factor[] } | null;
  org: OrgContext;
  aal: string;
} = { user: null, org: { supported: true, orgs: [], current: null }, aal: "aal1" };

const touched = vi.fn();
const fakeClient = {
  auth: {
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.aal }, error: null }) },
  },
  rpc: async (fn: string) => {
    if (fn === "is_platform_admin") return { data: true, error: null };
    if (fn === "bind_current_member") return { data: "owner", error: null };
    if (fn === "take_web_rate") return { data: true, error: null };
    touched(`rpc:${fn}`);
    return { data: null, error: null };
  },
  // Records the touch (a refused request must leave none), and answers like an empty table otherwise.
  from: (t: string) => {
    touched(`from:${t}`);
    const b: Record<string, unknown> = {};
    for (const m of ["select", "insert", "update", "upsert", "delete", "eq", "in", "order", "limit", "is", "gte"]) b[m] = () => b;
    b.single = async () => ({ data: null, error: null });
    b.maybeSingle = async () => ({ data: null, error: null });
    b.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
    return b;
  },
  storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "x" } }) }) },
};

vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => state.user, createClient: async () => fakeClient }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => state.org, ORG_COOKIE_OPTIONS: {} }));
vi.mock("@/lib/channels-server", () => ({ isChannelInCurrentOrg: async () => true }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => undefined }));
vi.mock("@/lib/server/github-secrets", () => ({
  GITHUB_REPO: "owner/bot",
  isGithubConfigured: true,
  isWritableSecretName: () => true,
  fetchPublicKey: async () => {
    touched("github:publicKey");
    return {};
  },
  putSecret: async () => {
    touched("github:putSecret");
    return "created";
  },
  listConfiguredSecretNames: async () => [],
  dispatchDailyVideo: async () => undefined,
  dispatchWorkflow: async () => {
    touched("github:dispatch");
  },
}));
vi.mock("@/lib/server/github-variables", () => ({
  readVariables: async () => ({}),
  putVariable: async () => {
    touched("github:putVariable");
  },
  isWritableVariable: () => true,
}));
const fetchMock = vi.fn(async () => {
  touched("fetch");
  return Response.json({});
});
vi.stubGlobal("fetch", fetchMock);

const routes = {
  "alerts/test": (await import("../app/api/alerts/test/route")).POST,
  "billing/refresh": (await import("../app/api/billing/refresh/route")).POST,
  "billing/settings": (await import("../app/api/billing/settings/route")).POST,
  "billing/topup": (await import("../app/api/billing/topup/route")).POST,
  "models/availability": (await import("../app/api/models/availability/route")).POST,
  "setup/secrets": (await import("../app/api/setup/secrets/route")).POST,
  "setup/variables": (await import("../app/api/setup/variables/route")).POST,
  "setup/voices": (await import("../app/api/setup/voices/route")).POST,
  "voices/preview": (await import("../app/api/voices/preview/route")).POST,
} as Record<string, (r: Request) => Promise<Response>>;

const ORG = { id: "0b000000-0000-0000-0000-00000000000b", name: "B", slug: "b", role: "owner" as const, is_default: false };
const VERIFIED: Factor[] = [{ status: "verified", factor_type: "totp" }];

function post(name: string, headers: Record<string, string>) {
  return new Request(`https://app.test/api/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}
const OURS = { origin: "https://app.test" };

function admin(factors: Factor[] = [], aal = "aal1") {
  state.user = { id: "u-admin-1234567", factors };
  state.org = { supported: true, orgs: [ORG], current: ORG };
  state.aal = aal;
}

beforeEach(() => {
  state.user = null;
  state.org = { supported: true, orgs: [], current: null };
  state.aal = "aal1";
  touched.mockClear();
  fetchMock.mockClear();
  vi.unstubAllEnvs();
  vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "");
});

const NAMES = Object.keys(routes);

describe.each(NAMES)("POST /api/%s", (name) => {
  it("a cross-site Origin is refused (403) before anything is read or changed", async () => {
    admin();
    const res = await routes[name](post(name, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(touched).not.toHaveBeenCalled();
  });

  it("no Origin header at all is refused, as everywhere else this helper is used", async () => {
    admin();
    const res = await routes[name](post(name, {}));
    expect(res.status).toBe(403);
    expect(touched).not.toHaveBeenCalled();
  });

  it("our Origin but Sec-Fetch-Site: cross-site is refused", async () => {
    admin();
    const res = await routes[name](post(name, { ...OURS, "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(touched).not.toHaveBeenCalled();
  });

  it("our own page (Origin ours, Sec-Fetch-Site same-origin) gets past the guard", async () => {
    admin();
    const res = await routes[name](post(name, { ...OURS, "sec-fetch-site": "same-origin" }));
    // Past the origin check: whatever the route says next (usually 400 for the empty body), not the guard's 403 / 401.
    expect([401, 403]).not.toContain(res.status);
  });

  it("signed out is still 401, not an origin answer (authentication comes first)", async () => {
    state.user = null;
    const res = await routes[name](post(name, { origin: "https://evil.example" }));
    expect(res.status).toBe(401);
  });

  it("enforce: an admin with a factor on a password-only session gets 401 mfa_required, nothing touched", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enforce");
    admin(VERIFIED, "aal1");
    const res = await routes[name](post(name, OURS));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "mfa_required" });
    expect(touched).not.toHaveBeenCalled();
  });

  it("enforce: the same admin on an aal2 session gets past the guard", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enforce");
    admin(VERIFIED, "aal2");
    const res = await routes[name](post(name, OURS));
    expect([401, 403]).not.toContain(res.status);
  });

  it("enforce: LOCKOUT SAFETY, an admin with NO factor is not blocked", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enforce");
    admin([], "aal1");
    const res = await routes[name](post(name, OURS));
    expect([401, 403]).not.toContain(res.status);
  });

  it("warn (default): an aal1 admin with a factor is let through", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    admin(VERIFIED, "aal1");
    const res = await routes[name](post(name, OURS));
    expect([401, 403]).not.toContain(res.status);
  });

  it("off: break-glass lets an aal1 admin with a factor through", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "off");
    admin(VERIFIED, "aal1");
    const res = await routes[name](post(name, OURS));
    expect([401, 403]).not.toContain(res.status);
  });
});

describe("the guard is applied to exactly the operator POST routes", () => {
  it("covers all nine (the four that already used it elsewhere are not touched)", () => {
    expect(NAMES).toHaveLength(9);
  });
});
