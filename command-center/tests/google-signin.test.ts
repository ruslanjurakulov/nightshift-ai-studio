import { describe, expect, it } from "vitest";
import {
  GOOGLE_ERRORS,
  googleCallbackError,
  googleGate,
  googleRedirectTo,
  isGoogleError,
  type GoogleUserLike,
} from "@/lib/google-signin";
import { siteEn } from "@/lib/i18n/site/en";
import { siteRu } from "@/lib/i18n/site/ru";
import { siteUz } from "@/lib/i18n/site/uz";

const q = (s: string) => new URLSearchParams(s);

describe("googleRedirectTo", () => {
  it("is this origin's callback with a safe next and the Google marker", () => {
    const u = new URL(googleRedirectTo("https://nightshift-ai.studio", "/all-channels/command-center", "/welcome"));
    expect(u.origin).toBe("https://nightshift-ai.studio");
    expect(u.pathname).toBe("/auth/callback");
    expect(u.searchParams.get("next")).toBe("/all-channels/command-center");
    expect(u.searchParams.get("provider")).toBe("google");
  });

  it.each([
    "https://evil.example/x",
    "//evil.example",
    "/\\evil.example",
    "/auth/callback?next=/x",
    "javascript:alert(1)",
    "/a/..//evil.example",
    null,
    undefined,
    "",
  ])("never carries %j off this origin: falls back", (raw) => {
    const u = new URL(googleRedirectTo("https://nightshift-ai.studio", raw as string | null, "/welcome"));
    expect(u.searchParams.get("next")).toBe("/welcome");
  });

  it("lets an AI app's connection request through sign-in and back", () => {
    const next = "/oauth/authorize?client_id=abc&state=" + "x".repeat(900);
    const u = new URL(googleRedirectTo("https://nightshift-ai.studio", next, "/command-center"));
    expect(u.searchParams.get("next")).toBe(next);
  });
});

describe("googleCallbackError", () => {
  it("maps a cancel on Google's screen", () => {
    expect(googleCallbackError(q("error=access_denied&error_description=User+denied"))).toBe("google_denied");
    expect(googleCallbackError(q("provider=google&error=access_denied&error_code=bad_oauth_callback"))).toBe("google_denied");
  });
  it("maps the provider-address confirmation case", () => {
    expect(googleCallbackError(q("error=server_error&error_code=provider_email_needs_verification"))).toBe("google_unverified");
  });
  it("maps any other error on a Google attempt to a generic failure, never the provider's words", () => {
    expect(googleCallbackError(q("provider=google&error=server_error&error_code=signup_disabled&error_description=Secret+detail"))).toBe(
      "google_failed",
    );
    expect(googleCallbackError(q("provider=google&error=whatever"))).toBe("google_failed");
  });
  it("leaves an expired email link to the email mapping", () => {
    expect(googleCallbackError(q("error=access_denied&error_code=otp_expired"))).toBeNull();
    expect(googleCallbackError(q("error_code=otp_expired"))).toBeNull();
    expect(googleCallbackError(q("code=abc"))).toBeNull();
  });
  it("only ever returns members of the fixed set", () => {
    for (const s of ["error=access_denied", "provider=google&error=x", "error_code=provider_email_needs_verification"]) {
      expect(isGoogleError(googleCallbackError(q(s)))).toBe(true);
    }
    expect(isGoogleError("<script>")).toBe(false);
    expect(isGoogleError(null)).toBe(false);
  });
});

const google = (verified: unknown): GoogleUserLike["identities"] => [
  { provider: "google", identity_data: { email_verified: verified } },
];
const user = (over: Partial<GoogleUserLike> = {}): GoogleUserLike => ({
  email_confirmed_at: "2026-10-11T10:00:00Z",
  identities: google(true),
  ...over,
});

describe("googleGate: the verified-email gate", () => {
  it("lets a verified Google identity with a confirmed user in", () => {
    expect(googleGate(user(), true)).toBeNull();
  });
  it.each([false, undefined, null, "true", 1, "false"])("refuses email_verified = %j", (v) => {
    expect(googleGate(user({ identities: google(v) }), true)).toBe("google_unverified");
  });
  it("refuses a user Supabase has not confirmed, even with the claim true", () => {
    expect(googleGate(user({ email_confirmed_at: null }), true)).toBe("google_unverified");
    expect(googleGate(user({ email_confirmed_at: undefined }), true)).toBe("google_unverified");
  });
  it("checks the Google identity, not the email identity's own flag", () => {
    const u = user({
      identities: [
        { provider: "email", identity_data: { email_verified: true } },
        { provider: "google", identity_data: { email_verified: false } },
      ],
    });
    expect(googleGate(u, true)).toBe("google_unverified");
  });
  it("the marker cannot switch the gate off: an account with a Google identity is checked anyway", () => {
    expect(googleGate(user({ identities: google(false) }), false)).toBe("google_unverified");
  });
  it("is not involved in an ordinary email confirmation", () => {
    expect(googleGate({ email_confirmed_at: "x", identities: [{ provider: "email", identity_data: { email_verified: true } }] }, false)).toBeNull();
    expect(googleGate(null, false)).toBeNull();
  });
  it("a Google attempt with no user, or no Google identity in a listed set, fails", () => {
    expect(googleGate(null, true)).toBe("google_failed");
    expect(googleGate({ email_confirmed_at: "x", identities: [{ provider: "email" }] }, true)).toBe("google_failed");
  });
  it("falls back to the provider claim in user_metadata only when identities are not listed", () => {
    expect(googleGate({ email_confirmed_at: "x", user_metadata: { email_verified: true } }, true)).toBeNull();
    expect(googleGate({ email_confirmed_at: "x", user_metadata: { email_verified: false } }, true)).toBe("google_unverified");
    expect(googleGate({ email_confirmed_at: "x" }, true)).toBe("google_unverified");
  });
});

describe("Google sign-in copy", () => {
  const all = { en: siteEn.auth.google, ru: siteRu.auth.google, uz: siteUz.auth.google };
  it("has the same keys, none empty, in en, ru and uz", () => {
    const keys = Object.keys(all.en).sort();
    for (const [lang, g] of Object.entries(all)) {
      expect(Object.keys(g).sort(), lang).toEqual(keys);
      for (const v of Object.values(g)) expect(v.trim(), lang).not.toBe("");
    }
  });
  it("has a message for every fixed error code", () => {
    for (const code of GOOGLE_ERRORS) expect(isGoogleError(code)).toBe(true);
    for (const g of Object.values(all)) {
      expect(new Set([g.errDenied, g.errUnverified, g.errFailed]).size).toBe(3);
    }
  });
  it("the English button label is the brand wording", () => {
    expect(siteEn.auth.google.button).toBe("Continue with Google");
  });
});
