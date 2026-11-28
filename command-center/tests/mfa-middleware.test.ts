import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The middleware with the second-factor step, end to end against a fake auth
 * client. What would break without these: an enrolled customer going into the
 * app on a password alone; the code page redirecting to itself; a customer
 * who never enrolled being asked anything; the single admin blocked in the
 * default mode.
 */

type Factor = { status: string; factor_type: string };
const auth = vi.hoisted(() => ({
  user: null as { id: string; factors?: Array<{ status: string; factor_type: string }> } | null,
  aal: "aal1",
  admin: false,
  rpcFails: false,
  calls: { aal: 0, rpc: 0 },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: auth.user } }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => {
          auth.calls.aal += 1;
          return { data: { currentLevel: auth.aal } };
        },
      },
    },
    rpc: async () => {
      auth.calls.rpc += 1;
      return auth.rpcFails ? { data: null, error: { message: "boom" } } : { data: auth.admin, error: null };
    },
  }),
}));
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://project.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));

const { middleware } = await import("@/middleware");
const { resetAdminCache } = await import("@/lib/security/mfa-middleware");

const VERIFIED: Factor[] = [{ status: "verified", factor_type: "totp" }];
const get = (path: string) => middleware(new NextRequest(`https://nightshift.test${path}`));

beforeEach(() => {
  auth.user = null;
  auth.aal = "aal1";
  auth.admin = false;
  auth.rpcFails = false;
  auth.calls = { aal: 0, rpc: 0 };
  resetAdminCache();
  vi.unstubAllEnvs();
  vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("a customer with an authenticator", () => {
  beforeEach(() => {
    auth.user = { id: "c1", factors: VERIFIED };
  });

  it("on a password-only session is sent to the code page, remembering where they were going", async () => {
    const res = await get("/chronos/videos?tab=2");
    const to = new URL(res.headers.get("location") ?? "https://x/");
    expect(to.pathname).toBe("/login/verify");
    expect(to.searchParams.get("next")).toBe("/chronos/videos?tab=2");
  });

  it("an API call from that session is a 401 mfa_required, not a redirect", async () => {
    const res = await get("/api/agent/run");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "mfa_required" });
  });

  it("the code page itself is served (no redirect loop)", async () => {
    const res = await get("/login/verify?next=%2Fchronos");
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("/login and the callback are not touched (the auth flow itself)", async () => {
    expect(new URL((await get("/login")).headers.get("location") ?? "https://x/").pathname).toBe("/");
    expect((await get("/auth/callback")).headers.get("location")).toBeNull();
  });

  it("on an aal2 session the app opens", async () => {
    auth.aal = "aal2";
    const res = await get("/chronos/videos");
    expect(new URL(res.headers.get("location") ?? "https://nightshift.test/chronos/videos").pathname).not.toBe("/login/verify");
  });

  it("/welcome (onboarding, served as 'pass' by the gate) is held for the code too, without a loop", async () => {
    const to = new URL((await get("/welcome")).headers.get("location") ?? "https://x/");
    expect(to.pathname).toBe("/login/verify");
    expect(to.searchParams.get("next")).toBe("/welcome");
    // ...and once the code is in, the same URL opens.
    auth.aal = "aal2";
    const ok = await get("/welcome");
    expect(ok.headers.get("location")).toBeNull();
    expect(ok.status).toBe(200);
  });

  it("/reset-password stays exempt (a recovery session must reach it)", async () => {
    const res = await get("/reset-password");
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("public pages are open to them, signed in", async () => {
    expect((await get("/pricing")).headers.get("location")).toBeNull();
  });
});

describe("a customer who never enrolled", () => {
  it("/welcome opens as before", async () => {
    auth.user = { id: "c5", factors: [] };
    const res = await get("/welcome");
    expect(res.headers.get("location")).toBeNull();
    expect(auth.calls).toEqual({ aal: 0, rpc: 0 });
  });

  it("is never asked, and nothing is looked up for them", async () => {
    auth.user = { id: "c2", factors: [] };
    const res = await get("/chronos/videos");
    expect(new URL(res.headers.get("location") ?? "https://nightshift.test/").pathname).not.toBe("/login/verify");
    expect(auth.calls).toEqual({ aal: 0, rpc: 0 });
    auth.user = { id: "c3" };
    expect((await get("/api/agent/run")).status).not.toBe(401);
  });

  it("an enrolment that was started and never confirmed does not make them wait for a code", async () => {
    auth.user = { id: "c4", factors: [{ status: "unverified", factor_type: "totp" }] };
    const res = await get("/chronos/videos");
    expect(new URL(res.headers.get("location") ?? "https://nightshift.test/").pathname).not.toBe("/login/verify");
  });
});

describe("the admin", () => {
  beforeEach(() => {
    auth.user = { id: "a1", factors: VERIFIED };
    auth.admin = true;
  });
  const goesToCode = async (path = "/chronos/billing") =>
    new URL((await get(path)).headers.get("location") ?? "https://x/").pathname === "/login/verify";

  it("default (unset) mode: an aal1 admin is NOT sent anywhere", async () => {
    expect(await goesToCode()).toBe(false);
    expect((await get("/api/billing/topup")).status).not.toBe(401);
  });

  it("warn: the same", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "warn");
    expect(await goesToCode()).toBe(false);
  });

  it("enforce: pages go to the code, API routes are 401 mfa_required", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enforce");
    expect(await goesToCode()).toBe(true);
    const res = await get("/api/billing/topup");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "mfa_required" });
  });

  it("enforce: an aal2 admin gets in", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enforce");
    auth.aal = "aal2";
    expect(await goesToCode()).toBe(false);
  });

  it("warn (and unset): LOCKOUT SAFETY, an admin with no factor gets in everywhere", async () => {
    auth.user = { id: "a1", factors: [] };
    expect(await goesToCode()).toBe(false);
    expect((await get("/api/billing/topup")).status).not.toBe(401);
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "warn");
    expect((await get("/chronos/billing")).headers.get("location")).toBeNull();
    expect((await get("/api/billing/topup")).status).not.toBe(403);
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "off");
    expect((await get("/chronos/billing")).headers.get("location")).toBeNull();
  });

  it("enforce: /welcome is held for an aal1 admin with a factor; warn lets it through", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enforce");
    expect(await goesToCode("/welcome")).toBe(true);
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "warn");
    expect(await goesToCode("/welcome")).toBe(false);
  });

  it("off: break-glass, an aal1 admin with a factor gets in", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "off");
    expect(await goesToCode()).toBe(false);
  });

  it("a typo in the variable behaves as warn, not enforce", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enfroce");
    expect(await goesToCode()).toBe(false);
  });
});

describe("strict enforce: an admin with NO authenticator may open /security and nothing else", () => {
  const to = async (path: string) => new URL((await get(path)).headers.get("location") ?? "https://x/");
  beforeEach(() => {
    resetAdminCache();
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "enforce");
    auth.user = { id: "a9", factors: [] };
    auth.admin = true;
  });

  it("every other page goes to /security", async () => {
    for (const path of ["/chronos/billing", "/command-center", "/all-channels/providers", "/chronos/videos?x=1", "/welcome", "/"]) {
      const target = await to(path);
      expect(target.pathname, path).toBe("/security");
      expect(target.search, path).toBe("");
    }
  });

  it("/security itself, with or without a channel, is not redirected to itself", async () => {
    const bare = await get("/security");
    // the usual channel redirect, never the enrolment redirect
    expect(new URL(bare.headers.get("location") ?? "https://x/").pathname).toBe("/all-channels/security");
    for (const path of ["/chronos/security", "/all-channels/security"]) {
      const res = await get(path);
      expect(res.headers.get("location"), path).toBeNull();
      expect(res.status).toBe(200);
    }
  });

  it("an API route is 403 mfa_enrol_required (not a redirect)", async () => {
    const res = await get("/api/billing/topup");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "mfa_enrol_required" });
  });

  it("lookalikes of /security are not let through", async () => {
    for (const path of ["/chronos/billing/security", "/security/x", "/a/b/security"]) {
      expect((await to(path)).pathname, path).toBe("/security");
    }
    // an API path that ends in /security is still an API path
    expect((await get("/api/security")).status).toBe(403);
  });

  it("a customer with no authenticator is untouched (and the admin lookup is remembered)", async () => {
    auth.admin = false;
    auth.user = { id: "c-strict", factors: [] };
    // An app page that is not itself a redirect (/videos goes to Studio now: lib/studioRoutes ZOMBIE_SECTIONS).
    expect((await get("/chronos/library")).headers.get("location")).toBeNull();
    expect((await get("/api/agent/run")).status).not.toBe(403);
    expect((await get("/chronos/library")).headers.get("location")).toBeNull();
    expect(auth.calls.rpc).toBe(1);
    expect(auth.calls.aal).toBe(0);
  });

  it("a failing admin lookup never blocks anyone (it is a tightening, not a gate)", async () => {
    auth.rpcFails = true;
    auth.user = { id: "c-err", factors: [] };
    expect((await get("/chronos/library")).headers.get("location")).toBeNull();
  });

  it("the same admin with a verified factor is the ordinary enforce case (code page, not /security)", async () => {
    auth.user = { id: "a9", factors: VERIFIED };
    expect((await to("/chronos/billing")).pathname).toBe("/login/verify");
    auth.aal = "aal2";
    expect((await get("/chronos/billing")).headers.get("location")).toBeNull();
  });

  it("warn and off never send a factor-less admin anywhere", async () => {
    for (const mode of ["warn", "off", "", "enfroce"]) {
      vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", mode);
      expect((await get("/chronos/billing")).headers.get("location"), mode).toBeNull();
    }
  });

  it("the public pages and the sign-in flow are not touched", async () => {
    for (const path of ["/pricing", "/reset-password", "/auth/callback"]) {
      expect((await get(path)).headers.get("location"), path).toBeNull();
    }
  });
});

describe("a signed-out visitor", () => {
  it("is sent to /login as before, and asked nothing about a second factor", async () => {
    const res = await get("/chronos/videos");
    expect(new URL(res.headers.get("location") ?? "https://x/").pathname).toBe("/login");
    expect(auth.calls).toEqual({ aal: 0, rpc: 0 });
    const verify = await get("/login/verify");
    expect(new URL(verify.headers.get("location") ?? "https://x/").pathname).toBe("/login");
  });
});

/**
 * The one staleness rule the code page, the recent-MFA step-up and admin_mfa_state()
 * (0107: `v_age > recent_mfa_minutes * 60`) share. What would break: the page sending a
 * session the database calls stale straight back to the refusal (the owner AI loop), or
 * asking for a code the database does not want.
 */
describe("the shared second-factor staleness rule", () => {
  const MIN = 60_000;
  const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);

  it("479 minutes inside a 480-minute window is fresh; 481 is stale; exactly 480 is fresh (as the database)", async () => {
    const { isSecondFactorStale } = await import("../lib/security/admin-mfa");
    expect(isSecondFactorStale(NOW - 479 * MIN, NOW, 480)).toBe(false);
    expect(isSecondFactorStale(NOW - 481 * MIN, NOW, 480)).toBe(true);
    expect(isSecondFactorStale(NOW - 480 * MIN, NOW, 480)).toBe(false);
  });

  it("an unreadable code time or an unknown window is not stale (the database passes an unreadable age too)", async () => {
    const { isSecondFactorStale } = await import("../lib/security/admin-mfa");
    expect(isSecondFactorStale(null, NOW, 480)).toBe(false);
    expect(isSecondFactorStale(NOW - 10_000 * MIN, NOW, null)).toBe(false);
  });

  it("the code page: aal1 + factor asks; stale aal2 + factor asks; fresh aal2 does not; no factor never does", async () => {
    const { verifyPageNeedsCode } = await import("../lib/security/admin-mfa");
    const base = { now: NOW, windowMinutes: 480 };
    expect(verifyPageNeedsCode({ ...base, aal: "aal1", hasVerifiedFactor: true, lastFactorAt: null })).toBe(true);
    expect(verifyPageNeedsCode({ ...base, aal: "aal2", hasVerifiedFactor: true, lastFactorAt: NOW - 481 * MIN })).toBe(true);
    expect(verifyPageNeedsCode({ ...base, aal: "aal2", hasVerifiedFactor: true, lastFactorAt: NOW - 479 * MIN })).toBe(false);
    for (const aal of ["aal1", "aal2", null]) {
      expect(verifyPageNeedsCode({ ...base, aal, hasVerifiedFactor: false, lastFactorAt: NOW - 10_000 * MIN })).toBe(false);
    }
  });
});
