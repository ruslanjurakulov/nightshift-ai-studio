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
}));

vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => s.user,
  createClient: async () => ({
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: async () => {
          if (s.aalThrows) throw new Error("x");
          return { data: { currentLevel: s.aal } };
        },
      },
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
