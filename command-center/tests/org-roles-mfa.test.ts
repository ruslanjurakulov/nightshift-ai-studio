import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The operator guards with the second-factor gate, and the `isOperator()`
 * fail-open fix (audit finding 13).
 *
 * What would break without these: every signed-in account being the operator
 * when the organization lookup says "function missing" in production; an aal1
 * admin passing in `enforce`; the single admin being blocked in the default
 * mode, or in `enforce` without any factor to unblock them.
 */

vi.mock("server-only", () => ({}));

type Factor = { status: string; factor_type: string };
const state: {
  user: { id: string; factors?: Factor[] } | null;
  aal: string | null;
  aalThrows: boolean;
  /** What my_organizations answers. */
  orgs: { data: unknown; error: { code?: string; message?: string } | null } | { throws: true };
  platformAdmin: boolean;
  rpcCalls: string[];
} = { user: null, aal: "aal1", aalThrows: false, orgs: { data: [], error: null }, platformAdmin: false, rpcCalls: [] };

const fakeClient = {
  auth: {
    getUser: async () => ({ data: { user: state.user } }),
    mfa: {
      getAuthenticatorAssuranceLevel: async () => {
        if (state.aalThrows) throw new Error("boom");
        return { data: { currentLevel: state.aal }, error: null };
      },
    },
  },
  rpc: async (fn: string) => {
    state.rpcCalls.push(fn);
    if (fn === "is_platform_admin") return { data: state.platformAdmin, error: null };
    if (fn === "my_organizations") {
      if ("throws" in state.orgs) throw new Error("network");
      return state.orgs;
    }
    return { data: null, error: null };
  },
};

vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => state.user,
  createClient: async () => fakeClient,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/channels-server", () => ({ isChannelInCurrentOrg: async () => true }));
vi.mock("@/lib/auth/roles", async () => {
  const shared = await vi.importActual<typeof import("../lib/auth/roles-shared")>("../lib/auth/roles-shared");
  return { ...shared, resolveRole: async () => "viewer" };
});

const { isOperator, requireOperator, guardOperatorPage, currentMfaAction } = await import("../lib/auth/org-roles");
const { getOrgContext } = await import("../lib/orgs-server");

const VERIFIED: Factor[] = [{ status: "verified", factor_type: "totp" }];
const ORG = [{ id: "o1", name: "O", slug: "o", role: "owner", is_default: false }];
const MISSING = { code: "PGRST202", message: "Could not find the function public.my_organizations in the schema cache" };

function reset() {
  state.user = null;
  state.aal = "aal1";
  state.aalThrows = false;
  state.orgs = { data: ORG, error: null };
  state.platformAdmin = false;
  state.rpcCalls = [];
}

beforeEach(() => {
  reset();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function setMode(mode: string | undefined) {
  if (mode === undefined) vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "");
  else vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", mode);
}

describe("isOperator fails closed when the organization lookup fails", () => {
  it("PRODUCTION: 'function missing' (PGRST202) does not make a normal signed-in user the operator", async () => {
    vi.stubEnv("NODE_ENV", "production");
    state.user = { id: "u-normal" };
    state.orgs = { data: null, error: MISSING };
    expect((await getOrgContext()).unavailable).toBe(true);
    expect(await isOperator()).toBe(false);
  });

  it.each([
    ["Postgres 42883", { code: "42883", message: "function does not exist" }],
    ["a generic RPC error", { code: "XX000", message: "boom" }],
    ["a message-only 'does not exist'", { message: "function public.my_organizations() does not exist" }],
  ])("PRODUCTION: %s -> not the operator", async (_n, error) => {
    vi.stubEnv("NODE_ENV", "production");
    state.user = { id: "u-normal" };
    state.orgs = { data: null, error };
    expect(await isOperator()).toBe(false);
  });

  it("PRODUCTION: the lookup throwing -> not the operator", async () => {
    vi.stubEnv("NODE_ENV", "production");
    state.user = { id: "u-normal" };
    state.orgs = { throws: true };
    expect(await isOperator()).toBe(false);
  });

  it("PRODUCTION: requireOperator answers 403 to that user (never ok)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    state.user = { id: "u-normal" };
    state.orgs = { data: null, error: MISSING };
    expect(await requireOperator()).toEqual({ ok: false, status: 403, error: "forbidden" });
  });

  it("PRODUCTION: guardOperatorPage 404s that user", async () => {
    vi.stubEnv("NODE_ENV", "production");
    state.user = { id: "u-normal" };
    state.orgs = { data: null, error: MISSING };
    await expect(guardOperatorPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("PRODUCTION: a real platform admin still is the operator when the lookup works", async () => {
    vi.stubEnv("NODE_ENV", "production");
    state.user = { id: "u-admin" };
    state.platformAdmin = true;
    expect(await isOperator()).toBe(true);
  });

  it("outside production, a database without 0018 is still the pre-0018 world (unchanged for local development)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    state.user = { id: "u-dev" };
    state.orgs = { data: null, error: MISSING };
    expect((await getOrgContext()).supported).toBe(false);
    expect((await getOrgContext()).unavailable).toBeUndefined();
    expect(await isOperator()).toBe(true);
  });

  it("nobody signed in is never the operator", async () => {
    vi.stubEnv("NODE_ENV", "production");
    state.user = null;
    expect(await isOperator()).toBe(false);
  });
});

describe("currentMfaAction", () => {
  const admin = (factors: Factor[], aal: string | null) => {
    state.user = { id: "u-admin-1234567", factors };
    state.aal = aal;
    state.platformAdmin = true;
  };

  it("default (unset) is warn: an aal1 admin with a factor is let through with the banner, and a warning is logged", async () => {
    setMode(undefined);
    admin(VERIFIED, "aal1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await currentMfaAction(state.user)).toBe("warn_complete");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("[admin-mfa]");
    expect(line).toContain("u-admin-"); // an id prefix only
    expect(line).not.toContain("u-admin-1234567");
    expect(line).not.toMatch(/@/);
  });

  it("warn: an admin with NO factor gets the enrol banner, never a block", async () => {
    setMode("warn");
    admin([], "aal1");
    expect(await currentMfaAction(state.user)).toBe("warn_enrol");
  });

  it("enforce: aal1 admin WITH a factor is challenged", async () => {
    setMode("enforce");
    admin(VERIFIED, "aal1");
    expect(await currentMfaAction(state.user)).toBe("challenge");
  });

  it("enforce: LOCKOUT SAFETY, an admin with NO factor is not blocked (enrol banner)", async () => {
    setMode("enforce");
    admin([], "aal1");
    expect(await currentMfaAction(state.user)).toBe("warn_enrol");
  });

  it("enforce: an admin with only an UNVERIFIED enrolment is not blocked either", async () => {
    setMode("enforce");
    admin([{ status: "unverified", factor_type: "totp" }], "aal1");
    expect(await currentMfaAction(state.user)).toBe("warn_enrol");
  });

  it("enforce: aal2 passes, without asking who the admin is", async () => {
    setMode("enforce");
    admin(VERIFIED, "aal2");
    expect(await currentMfaAction(state.user)).toBe("allow");
    expect(state.rpcCalls).not.toContain("is_platform_admin");
  });

  it("enforce: an unreadable level counts as password-only (asks for the code)", async () => {
    setMode("enforce");
    admin(VERIFIED, "aal1");
    state.aalThrows = true;
    expect(await currentMfaAction(state.user)).toBe("challenge");
  });

  it("off: break-glass, nothing is read and nothing is asked", async () => {
    setMode("off");
    admin(VERIFIED, "aal1");
    expect(await currentMfaAction(state.user)).toBe("allow");
    expect(state.rpcCalls).toEqual([]);
  });

  it("a typo in the variable is warn, not enforce", async () => {
    setMode("enforced");
    admin(VERIFIED, "aal1");
    expect(await currentMfaAction(state.user)).toBe("warn_complete");
  });

  it("a customer with a factor and a password-only session is challenged in warn and enforce; one without is untouched", async () => {
    state.platformAdmin = false;
    for (const mode of ["warn", "enforce"]) {
      setMode(mode);
      state.user = { id: "c1", factors: VERIFIED };
      state.aal = "aal1";
      expect(await currentMfaAction(state.user)).toBe("challenge");
      state.user = { id: "c2", factors: [] };
      expect(await currentMfaAction(state.user)).toBe("allow");
    }
  });

  it("an adminHint spares the second lookup", async () => {
    setMode("enforce");
    admin(VERIFIED, "aal1");
    expect(await currentMfaAction(state.user, true)).toBe("challenge");
    expect(state.rpcCalls).not.toContain("is_platform_admin");
  });

  it("signed out is allow (the other guards own that case)", async () => {
    setMode("enforce");
    state.user = null;
    expect(await currentMfaAction(null)).toBe("allow");
  });
});

describe("requireOperator and guardOperatorPage in each mode", () => {
  function operatorSession(factors: Factor[], aal: string) {
    state.user = { id: "u-admin-1234567", factors };
    state.aal = aal;
    state.platformAdmin = true;
  }

  it("warn (default): the single admin is never blocked, with or without a factor, aal1 or aal2", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setMode(undefined);
    for (const factors of [VERIFIED, []])
      for (const aal of ["aal1", "aal2"]) {
        operatorSession(factors, aal);
        expect(await requireOperator()).toEqual({ ok: true });
        await expect(guardOperatorPage()).resolves.toBe(true);
      }
  });

  it("enforce: aal1 + factor -> 401 mfa_required on API, redirect to the code page on a page", async () => {
    setMode("enforce");
    operatorSession(VERIFIED, "aal1");
    expect(await requireOperator()).toEqual({ ok: false, status: 401, error: "mfa_required" });
    await expect(guardOperatorPage()).rejects.toThrow("NEXT_REDIRECT:/login/verify");
  });

  it("enforce: aal2 passes", async () => {
    setMode("enforce");
    operatorSession(VERIFIED, "aal2");
    expect(await requireOperator()).toEqual({ ok: true });
    await expect(guardOperatorPage()).resolves.toBe(true);
  });

  it("enforce: an admin with no factor is NOT locked out (the rule that protects the only admin)", async () => {
    setMode("enforce");
    operatorSession([], "aal1");
    expect(await requireOperator()).toEqual({ ok: true });
    await expect(guardOperatorPage()).resolves.toBe(true);
  });

  it("off: passes whatever the session", async () => {
    setMode("off");
    operatorSession(VERIFIED, "aal1");
    expect(await requireOperator()).toEqual({ ok: true });
  });

  it("a non-operator is still 403, not 401 mfa_required (nothing leaks about factors)", async () => {
    setMode("enforce");
    state.user = { id: "c", factors: VERIFIED };
    state.aal = "aal1";
    state.platformAdmin = false;
    expect(await requireOperator()).toEqual({ ok: false, status: 403, error: "forbidden" });
  });
});
