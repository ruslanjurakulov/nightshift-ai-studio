import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { dictionaries } from "../lib/i18n";
import { AdminMfaBanner } from "../components/security/AdminMfaBanner";
import type { MfaAction } from "../lib/security/admin-mfa";

/**
 * /login/verify decides on the server, and the operator banner says the right
 * thing in each language. What would break without these: the code page
 * skippable from the browser, a redirect loop with the middleware, an open
 * redirect through `next`, a banner pushing the wrong action.
 */

vi.mock("server-only", () => ({}));

const s = vi.hoisted(() => ({
  user: null as null | { id: string; factors?: Array<{ status: string; factor_type: string }> },
  aal: "aal1" as string,
  aalThrows: false,
  /** The token's TOTP amr timestamp, minutes before now; null = no amr entry. */
  codeAgeMinutes: null as number | null,
  /** What owner_security_get() answers; null = it raises (a non-admin, 42501). */
  security: null as null | { admin_aal2_required: boolean; recent_mfa_minutes: number },
  rpcCalls: 0,
}));

vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => s.user,
  createClient: async () => ({
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: async () => {
          if (s.aalThrows) throw new Error("x");
          const methods =
            s.codeAgeMinutes === null ? [] : [{ method: "totp", timestamp: Math.floor((Date.now() - s.codeAgeMinutes * 60_000) / 1000) }];
          return { data: { currentLevel: s.aal, currentAuthenticationMethods: methods } };
        },
      },
    },
    rpc: async (fn: string) => {
      s.rpcCalls += 1;
      if (fn !== "owner_security_get" || !s.security) return { data: null, error: { code: "42501", message: "only a platform owner" } };
      return { data: { ok: true, settings: s.security, caller: {} }, error: null };
    },
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock("@/components/auth/MfaChallenge", () => ({ MfaChallenge: () => null }));

const { default: VerifyPage } = await import("../app/login/verify/page");

const VERIFIED = [{ status: "verified", factor_type: "totp" }];
const page = (next?: string) => VerifyPage({ searchParams: Promise.resolve({ next }) });

beforeEach(() => {
  s.user = null;
  s.aal = "aal1";
  s.aalThrows = false;
  s.codeAgeMinutes = null;
  s.security = null;
  s.rpcCalls = 0;
  vi.unstubAllEnvs();
  vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "");
});

describe("/login/verify", () => {
  it("signed out: /login", async () => {
    await expect(page("/chronos")).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("password-only session on an account with an authenticator: the code form, for where they were going", async () => {
    s.user = { id: "u", factors: VERIFIED };
    const el = (await page("/chronos/billing")) as { props: { next: string } };
    expect(el.props.next).toBe("/chronos/billing");
  });

  it("an account with no verified factor needs no code: straight on (no loop with the middleware)", async () => {
    s.user = { id: "u", factors: [{ status: "unverified", factor_type: "totp" }] };
    await expect(page("/chronos/billing")).rejects.toThrow("NEXT_REDIRECT:/chronos/billing");
    s.user = { id: "u" };
    await expect(page("/chronos/billing")).rejects.toThrow("NEXT_REDIRECT:/chronos/billing");
  });

  it("an aal2 session is finished: straight on", async () => {
    s.user = { id: "u", factors: VERIFIED };
    s.aal = "aal2";
    await expect(page("/chronos/billing")).rejects.toThrow("NEXT_REDIRECT:/chronos/billing");
  });

  describe("an aal2 session whose code is older than the database's window (the owner AI stale_mfa loop)", () => {
    const GATE_ON = { admin_aal2_required: true, recent_mfa_minutes: 480 };

    it("stale aal2 + verified factor: the code form, returning to /owner/ai (no bounce back to the refusal)", async () => {
      s.user = { id: "u", factors: VERIFIED };
      s.aal = "aal2";
      s.codeAgeMinutes = 481;
      s.security = GATE_ON;
      const el = (await page("/owner/ai")) as { props: { next: string } };
      expect(el.props.next).toBe("/owner/ai");
    });

    it("fresh aal2 (code inside the window): straight on", async () => {
      s.user = { id: "u", factors: VERIFIED };
      s.aal = "aal2";
      s.codeAgeMinutes = 479;
      s.security = GATE_ON;
      await expect(page("/owner/ai")).rejects.toThrow("NEXT_REDIRECT:/owner/ai");
    });

    it("the window is the database's, not a constant: 481 minutes passes under a 600-minute setting", async () => {
      s.user = { id: "u", factors: VERIFIED };
      s.aal = "aal2";
      s.codeAgeMinutes = 481;
      s.security = { admin_aal2_required: true, recent_mfa_minutes: 600 };
      await expect(page("/owner/ai")).rejects.toThrow("NEXT_REDIRECT:/owner/ai");
    });

    it("gate off in the database (it refuses nobody as stale): straight on", async () => {
      s.user = { id: "u", factors: VERIFIED };
      s.aal = "aal2";
      s.codeAgeMinutes = 10_000;
      s.security = { admin_aal2_required: false, recent_mfa_minutes: 480 };
      await expect(page("/owner/ai")).rejects.toThrow("NEXT_REDIRECT:/owner/ai");
    });

    it("window unreadable (not an admin, or the call fails): the old rule, straight on", async () => {
      s.user = { id: "u", factors: VERIFIED };
      s.aal = "aal2";
      s.codeAgeMinutes = 10_000;
      await expect(page("/chronos")).rejects.toThrow("NEXT_REDIRECT:/chronos");
    });

    it("lockout safety: no verified factor is never sent to a code page, however old its session", async () => {
      s.user = { id: "u", factors: [{ status: "unverified", factor_type: "totp" }] };
      s.aal = "aal2";
      s.codeAgeMinutes = 10_000;
      s.security = GATE_ON;
      await expect(page("/owner/ai")).rejects.toThrow("NEXT_REDIRECT:/owner/ai");
      // and the database is not even asked: nothing about it could change the answer
      expect(s.rpcCalls).toBe(0);
    });

    it("an off-site next is still refused for a stale session after the code (safeLoginReturn)", async () => {
      s.user = { id: "u", factors: VERIFIED };
      s.aal = "aal2";
      s.codeAgeMinutes = 481;
      s.security = GATE_ON;
      const el = (await page("//evil.example")) as { props: { next: string } };
      expect(el.props.next).toBe("/command-center");
    });
  });

  it("NIGHTSHIFT_ADMIN_MFA=off (break-glass): no code is asked, even of an enrolled account", async () => {
    vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "off");
    s.user = { id: "u", factors: VERIFIED };
    await expect(page("/chronos/billing")).rejects.toThrow("NEXT_REDIRECT:/chronos/billing");
  });

  it("an unreadable level shows the form (it can only ask for more)", async () => {
    s.user = { id: "u", factors: VERIFIED };
    s.aalThrows = true;
    const el = (await page("/x")) as { props: { next: string } };
    expect(el.props.next).toBe("/x");
  });

  it.each(["//evil.example", "https://evil.example/", "/\\evil.example", "javascript:alert(1)", "/auth/callback"])(
    "next=%s is not followed: the default is used",
    async (bad) => {
      s.user = { id: "u", factors: VERIFIED };
      s.aal = "aal2";
      await expect(page(bad)).rejects.toThrow("NEXT_REDIRECT:/command-center");
    },
  );

  it("a missing next defaults to the app", async () => {
    s.user = { id: "u", factors: VERIFIED };
    s.aal = "aal2";
    await expect(page(undefined)).rejects.toThrow("NEXT_REDIRECT:/command-center");
  });
});

describe("the operator banner", () => {
  const html = (action: MfaAction, locale: "en" | "ru" | "uz", path?: string) =>
    renderToStaticMarkup(createElement(AdminMfaBanner, { action, t: dictionaries[locale].mfa, path }));

  it.each(["allow", "challenge"] as MfaAction[])("draws nothing for %s", (a) => {
    expect(html(a, "en")).toBe("");
  });

  it.each(["en", "ru", "uz"] as const)("%s: 'complete the code' links to the code page for this very page", (loc) => {
    const out = html("warn_complete", loc, "/chronos/billing");
    expect(out).toContain(dictionaries[loc].mfa.bannerComplete);
    expect(out).toContain(dictionaries[loc].mfa.bannerCompleteAction);
    expect(out).toContain('href="/login/verify?next=%2Fchronos%2Fbilling"');
    expect(out).toContain('role="status"');
  });

  it.each(["en", "ru", "uz"] as const)("%s: no factor links to /security to enrol", (loc) => {
    const out = html("warn_enrol", loc);
    expect(out).toContain(dictionaries[loc].mfa.bannerEnrol);
    expect(out).toContain('href="/security"');
  });
});
