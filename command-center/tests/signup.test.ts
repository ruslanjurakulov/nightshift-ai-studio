import { describe, expect, it } from "vitest";
import {
  PASSWORD_MIN,
  callbackErrorFor,
  classifySignInError,
  classifySignupError,
  classifySignupResult,
  isCallbackError,
  validateSignup,
} from "@/lib/signup";

const ok = { email: "new@example.com", password: "correct horse", confirm: "correct horse", consent: true };

describe("validateSignup", () => {
  it("accepts a complete form", () => {
    expect(validateSignup(ok)).toBeNull();
  });

  it("refuses an address that is not one", () => {
    expect(validateSignup({ ...ok, email: "new@example" })).toBe("email_invalid");
    expect(validateSignup({ ...ok, email: "" })).toBe("email_invalid");
  });

  it(`asks for at least ${PASSWORD_MIN} characters`, () => {
    const short = "a".repeat(PASSWORD_MIN - 1);
    expect(validateSignup({ ...ok, password: short, confirm: short })).toBe("password_short");
    const exact = "a".repeat(PASSWORD_MIN);
    expect(validateSignup({ ...ok, password: exact, confirm: exact })).toBeNull();
  });

  // bcrypt silently ignores bytes past 72 — a longer password would "work"
  // while only its prefix is checked.
  it("refuses a password bcrypt would truncate", () => {
    const long = "é".repeat(40); // 80 bytes
    expect(validateSignup({ ...ok, password: long, confirm: long })).toBe("password_long");
  });

  it("refuses mismatched passwords", () => {
    expect(validateSignup({ ...ok, confirm: "correct horsE" })).toBe("password_mismatch");
  });

  it("requires consent to the Terms and Privacy Policy", () => {
    expect(validateSignup({ ...ok, consent: false })).toBe("consent_required");
  });
});

describe("classifySignupError — never the raw message", () => {
  it.each([
    [{ status: 429, code: "over_email_send_rate_limit" }, "rate_limited"],
    [{ status: 429 }, "rate_limited"],
    [{ code: "over_request_rate_limit" }, "rate_limited"],
    [{ status: 422, code: "user_already_exists" }, "already_registered"],
    [{ code: "email_exists" }, "already_registered"],
    [{ message: "User already registered" }, "already_registered"],
    [{ code: "weak_password" }, "weak_password"],
    [{ name: "AuthWeakPasswordError" }, "weak_password"],
    [{ code: "email_address_invalid" }, "email_invalid"],
    [{ code: "signup_disabled" }, "signups_closed"],
    [{ code: "email_provider_disabled" }, "signups_closed"],
    [{ status: 500, message: "Database error saving new user" }, "failed"],
    [{}, "failed"],
  ] as const)("%j → %s", (error, outcome) => {
    expect(classifySignupError(error)).toBe(outcome);
  });
});

describe("classifySignupResult", () => {
  it("is 'check your email' when no session comes back", () => {
    expect(classifySignupResult({ user: { identities: [{}] }, session: null })).toBe("check_email");
  });

  // With confirmations on, an address that already has an account comes back
  // as a user with no identities and no email is sent.
  it("recognises an address that is already registered", () => {
    expect(classifySignupResult({ user: { identities: [] }, session: null })).toBe("already_registered");
  });

  it("is signed in straight away when the project does not confirm email", () => {
    expect(classifySignupResult({ user: { identities: [{}] }, session: {} })).toBe("signed_in");
  });
});

describe("sign-in errors", () => {
  it.each([
    [{ code: "invalid_credentials", status: 400 }, "invalid_credentials"],
    [{ message: "Invalid login credentials" }, "invalid_credentials"],
    [{ code: "email_not_confirmed" }, "email_not_confirmed"],
    [{ status: 429 }, "rate_limited"],
    [{ status: 500 }, "failed"],
  ] as const)("%j → %s", (error, outcome) => {
    expect(classifySignInError(error)).toBe(outcome);
  });
});

describe("callback errors", () => {
  it("maps an expired link and everything else to a fixed code", () => {
    expect(callbackErrorFor("otp_expired")).toBe("link_expired");
    expect(callbackErrorFor("bad_code_verifier")).toBe("link_invalid");
    expect(callbackErrorFor(null)).toBe("link_invalid");
  });

  // The login page renders a message only for these codes, never URL text.
  it("accepts only its own codes from the URL", () => {
    expect(isCallbackError("link_expired")).toBe(true);
    expect(isCallbackError("<script>")).toBe(false);
    expect(isCallbackError(null)).toBe(false);
  });
});
