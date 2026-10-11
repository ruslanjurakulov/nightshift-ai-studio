import { describe, expect, it, vi } from "vitest";
import {
  FailureThrottle,
  REAUTH_MAX_FAILURES,
  REAUTH_WINDOW_MS,
  classifyEmailChangeError,
  classifyPasswordUpdateError,
  classifyReauthError,
  validateEmailChange,
  validatePasswordChange,
  verifyCurrentPassword,
  type PasswordCheckClient,
} from "@/lib/account-security";
import { PASSWORD_MAX, PASSWORD_MIN, validateNewPassword, validateSignup } from "@/lib/signup";

describe("one password policy", () => {
  it("sign-up, the reset page and Settings all use validateNewPassword", () => {
    expect(validateNewPassword("a".repeat(PASSWORD_MIN - 1), "a".repeat(PASSWORD_MIN - 1))).toBe("password_short");
    expect(validateNewPassword("ä".repeat(PASSWORD_MAX / 2 + 1), "ä".repeat(PASSWORD_MAX / 2 + 1))).toBe("password_long"); // bytes, not characters
    expect(validateNewPassword("longenough1", "longenough2")).toBe("password_mismatch");
    expect(validateNewPassword("longenough1", "longenough1")).toBeNull();
    const base = { email: "a@b.co", password: "short", confirm: "short", consent: true };
    expect(validateSignup(base)).toBe(validateNewPassword("short", "short"));
  });

  it("Settings adds the current password and refuses an unchanged one", () => {
    expect(validatePasswordChange({ current: "", next: "longenough1", confirm: "longenough1" })).toBe("current_required");
    expect(validatePasswordChange({ current: "old-password", next: "short", confirm: "short" })).toBe("password_short");
    expect(validatePasswordChange({ current: "old-password", next: "longenough1", confirm: "different12" })).toBe("password_mismatch");
    expect(validatePasswordChange({ current: "longenough1", next: "longenough1", confirm: "longenough1" })).toBe("password_unchanged");
    expect(validatePasswordChange({ current: "old-password", next: "longenough1", confirm: "longenough1" })).toBeNull();
  });
});

describe("email change validation", () => {
  it("wants a plausible new address, different from the current one, and the password", () => {
    expect(validateEmailChange({ current: "a@b.co", next: "nope", password: "x" })).toBe("email_invalid");
    expect(validateEmailChange({ current: "a@b.co", next: " A@B.co ", password: "x" })).toBe("email_same");
    expect(validateEmailChange({ current: "a@b.co", next: "c@d.co", password: "" })).toBe("password_required");
    expect(validateEmailChange({ current: "a@b.co", next: "c@d.co", password: "x" })).toBeNull();
  });
});

describe("error mapping never echoes provider text", () => {
  it("re-authentication: every refusal to sign in reads as a wrong password", () => {
    expect(classifyReauthError({ code: "invalid_credentials", message: "Invalid login credentials" })).toBe("wrong_password");
    expect(classifyReauthError({ code: "email_not_confirmed" })).toBe("wrong_password");
    expect(classifyReauthError({ status: 429 })).toBe("rate_limited");
    expect(classifyReauthError({ code: "over_request_rate_limit" })).toBe("rate_limited");
    expect(classifyReauthError({ message: "something odd" })).toBe("failed");
  });
  it("password update", () => {
    expect(classifyPasswordUpdateError({ code: "weak_password" })).toBe("weak_password");
    expect(classifyPasswordUpdateError({ name: "AuthWeakPasswordError" })).toBe("weak_password");
    expect(classifyPasswordUpdateError({ code: "same_password" })).toBe("same_password");
    expect(classifyPasswordUpdateError({ code: "insufficient_aal" })).toBe("second_factor");
    expect(classifyPasswordUpdateError({ name: "AuthSessionMissingError" })).toBe("session_expired");
    expect(classifyPasswordUpdateError({ status: 429 })).toBe("rate_limited");
    expect(classifyPasswordUpdateError({ message: "db exploded" })).toBe("failed");
  });
  it("email change: an address already in use is reported as sent, like a free one", () => {
    for (const e of [{ code: "email_exists" }, { code: "user_already_exists" }, { message: "A user with this email address has already been registered" }])
      expect(classifyEmailChangeError(e)).toBe("sent");
    expect(classifyEmailChangeError({ code: "email_address_invalid" })).toBe("invalid_email");
    expect(classifyEmailChangeError({ code: "over_email_send_rate_limit" })).toBe("rate_limited");
    expect(classifyEmailChangeError({ code: "insufficient_aal" })).toBe("second_factor");
    expect(classifyEmailChangeError({ message: "nope" })).toBe("failed");
  });
});

describe("FailureThrottle", () => {
  it("lets the allowance of wrong answers through, then waits out the window", () => {
    const t = new FailureThrottle();
    for (let i = 0; i < REAUTH_MAX_FAILURES; i++) {
      expect(t.waitMs(1000 + i)).toBe(0);
      t.fail(1000 + i);
    }
    expect(t.waitMs(2000)).toBeGreaterThan(0);
    expect(t.waitMs(1000 + REAUTH_WINDOW_MS - 1)).toBeGreaterThan(0); // the first failure is still inside the window
    expect(t.waitMs(1000 + REAUTH_WINDOW_MS)).toBe(0); // it ages out, so one attempt is allowed again
  });
  it("a right answer clears it", () => {
    const t = new FailureThrottle(2, 60_000);
    t.fail(0);
    t.fail(1);
    expect(t.waitMs(2)).toBeGreaterThan(0);
    t.reset();
    expect(t.waitMs(2)).toBe(0);
  });
});

describe("verifyCurrentPassword", () => {
  const client = (error: unknown) => {
    const signInWithPassword = vi.fn(async () => ({ error: error as never }));
    const signOut = vi.fn(async () => ({}));
    return { c: { auth: { signInWithPassword, signOut } } as PasswordCheckClient, signInWithPassword, signOut };
  };

  it("signs in on a throwaway client, then revokes only that sign-in locally", async () => {
    const { c, signInWithPassword, signOut } = client(null);
    expect(await verifyCurrentPassword(c, "a@b.co", "pw", new FailureThrottle())).toBe("ok");
    expect(signInWithPassword).toHaveBeenCalledWith({ email: "a@b.co", password: "pw" });
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("a wrong password is generic and counts toward the throttle; the sixth is not even sent", async () => {
    const { c, signInWithPassword, signOut } = client({ code: "invalid_credentials", message: "Invalid login credentials" });
    const throttle = new FailureThrottle();
    for (let i = 0; i < REAUTH_MAX_FAILURES; i++) expect(await verifyCurrentPassword(c, "a@b.co", "bad", throttle, 1000 + i)).toBe("wrong_password");
    expect(await verifyCurrentPassword(c, "a@b.co", "bad", throttle, 2000)).toBe("throttled");
    expect(signInWithPassword).toHaveBeenCalledTimes(REAUTH_MAX_FAILURES);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("a rate limit is not counted as a wrong answer; a thrown error is just a failure", async () => {
    const throttle = new FailureThrottle(1, 60_000);
    expect(await verifyCurrentPassword(client({ status: 429 }).c, "a@b.co", "pw", throttle)).toBe("rate_limited");
    expect(throttle.waitMs()).toBe(0);
    const boom = { auth: { signInWithPassword: async () => { throw new Error("net"); }, signOut: async () => ({}) } } as unknown as PasswordCheckClient;
    expect(await verifyCurrentPassword(boom, "a@b.co", "pw", throttle)).toBe("failed");
  });
});
