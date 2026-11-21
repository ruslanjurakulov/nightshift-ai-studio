/**
 * Settings → "Account and security" and the reset page: the decisions worth
 * pinning, without React.
 *
 * Same stance as lib/signup.ts. Supabase's errors are written for developers
 * and change between releases, so nothing here returns one for display: each is
 * mapped to a small fixed set of outcomes and every outcome has a sentence in
 * all three dictionaries. Passwords are only ever passed along to Supabase —
 * never logged, never stored, never put in a URL.
 */

import { isPlausibleSignupEmail, validateNewPassword, type AuthErrorLike, type PasswordProblem } from "@/lib/signup";

/** Wrong current password attempts allowed per window before the form pauses itself. */
export const REAUTH_MAX_FAILURES = 5;
export const REAUTH_WINDOW_MS = 60_000;

function codeOf(error: AuthErrorLike): string {
  return (error.code ?? "").toLowerCase();
}

function isRateLimit(error: AuthErrorLike): boolean {
  const code = codeOf(error);
  return error.status === 429 || code.startsWith("over_") || /rate limit/i.test(error.message ?? "");
}

/** Re-authenticating with the current password (signInWithPassword) came to: */
export type ReauthOutcome = "wrong_password" | "rate_limited" | "failed";

/**
 * Every refusal to sign in again is "wrong password" to the person — including
 * an unconfirmed address, which cannot be the case for someone already inside —
 * so the form never says more than "that password is not right".
 */
export function classifyReauthError(error: AuthErrorLike): ReauthOutcome {
  if (isRateLimit(error)) return "rate_limited";
  const code = codeOf(error);
  if (code === "invalid_credentials" || code === "email_not_confirmed" || /invalid login credentials|email not confirmed/i.test(error.message ?? ""))
    return "wrong_password";
  return "failed";
}

/** updateUser({ password }) came to: */
export type PasswordUpdateOutcome =
  | "weak_password"
  | "same_password"
  | "session_expired"
  | "second_factor"
  | "rate_limited"
  | "failed";

export function classifyPasswordUpdateError(error: AuthErrorLike): PasswordUpdateOutcome {
  const code = codeOf(error);
  if (isRateLimit(error)) return "rate_limited";
  if (code === "weak_password" || error.name === "AuthWeakPasswordError") return "weak_password";
  if (code === "same_password") return "same_password";
  // An account with two-step verification must change this from a session that has used its code.
  if (code === "insufficient_aal") return "second_factor";
  if (code === "reauthentication_needed" || code === "reauthentication_not_valid" || error.name === "AuthSessionMissingError" || code === "session_not_found" || code === "refresh_token_not_found")
    return "session_expired";
  return "failed";
}

/** updateUser({ email }) came to. An address that is already taken is NOT an outcome: it is reported as sent. */
export type EmailChangeOutcome = "sent" | "invalid_email" | "second_factor" | "session_expired" | "rate_limited" | "failed";

export function classifyEmailChangeError(error: AuthErrorLike): EmailChangeOutcome {
  const code = codeOf(error);
  // Saying "that address is in use" would let anyone with an account test which
  // addresses have one. The page answers exactly as it does for a free address.
  if (code === "email_exists" || code === "user_already_exists" || /already (been )?registered|already exists/i.test(error.message ?? ""))
    return "sent";
  if (isRateLimit(error)) return "rate_limited";
  if (code === "email_address_invalid" || code === "validation_failed") return "invalid_email";
  if (code === "insufficient_aal") return "second_factor";
  if (code === "session_not_found" || code === "refresh_token_not_found" || error.name === "AuthSessionMissingError") return "session_expired";
  return "failed";
}

export type EmailChangeProblem = "email_invalid" | "email_same" | "password_required";

export function validateEmailChange(input: { current: string; next: string; password: string }): EmailChangeProblem | null {
  if (!isPlausibleSignupEmail(input.next)) return "email_invalid";
  if (input.next.trim().toLowerCase() === input.current.trim().toLowerCase()) return "email_same";
  if (!input.password) return "password_required";
  return null;
}

export type PasswordChangeProblem = PasswordProblem | "current_required" | "password_unchanged";

/** The same policy as sign-up (validateNewPassword), plus the current password. */
export function validatePasswordChange(input: { current: string; next: string; confirm: string }): PasswordChangeProblem | null {
  if (!input.current) return "current_required";
  const policy = validateNewPassword(input.next, input.confirm);
  if (policy) return policy;
  if (input.next === input.current) return "password_unchanged";
  return null;
}

/**
 * A client-side throttle for the current-password check: after
 * REAUTH_MAX_FAILURES wrong answers inside the window the form refuses to ask
 * again until the window has passed. It is a courtesy (the server rate-limits
 * sign-ins too), not the defence — but a mistyped password should not be a way
 * to hammer the sign-in endpoint from this page.
 */
export class FailureThrottle {
  private failures: number[] = [];

  constructor(
    private readonly max: number = REAUTH_MAX_FAILURES,
    private readonly windowMs: number = REAUTH_WINDOW_MS,
  ) {}

  private prune(now: number) {
    this.failures = this.failures.filter((t) => now - t < this.windowMs);
  }

  /** Milliseconds to wait before the next attempt, 0 when one may be made. */
  waitMs(now: number = Date.now()): number {
    this.prune(now);
    if (this.failures.length < this.max) return 0;
    return Math.max(0, this.failures[0] + this.windowMs - now);
  }

  fail(now: number = Date.now()) {
    this.prune(now);
    this.failures.push(now);
  }

  reset() {
    this.failures = [];
  }
}

/** Just enough of a Supabase client to check a password: sign in, then drop that sign-in again. */
export interface PasswordCheckClient {
  auth: {
    signInWithPassword(credentials: { email: string; password: string }): PromiseLike<{ error: AuthErrorLike | null }>;
    signOut(options: { scope: "local" }): PromiseLike<unknown>;
  };
}

/**
 * Re-authenticate with the current password (signInWithPassword), as a gate in
 * front of an e-mail or password change.
 *
 * `client` is a throwaway one (lib/supabase/reauth.ts): it holds no session of
 * this browser, so checking the password neither replaces the session the
 * person is using (a two-step-verified one would otherwise drop back to a
 * password-only level) nor writes any cookie. The sign-in it makes is revoked
 * again at once, locally. NOTE this gate is client-side friction, not a
 * server-enforced control: whoever holds the session (a stolen one, an XSS)
 * can call updateUser directly and skip it. The server-side limit is
 * Supabase's "Secure password change" setting. Wrong answers feed `throttle`; past its allowance the
 * password is not even sent. The password is passed to Supabase and nowhere else.
 */
export async function verifyCurrentPassword(
  client: PasswordCheckClient,
  email: string,
  password: string,
  throttle: FailureThrottle,
  now: number = Date.now(),
): Promise<"ok" | "throttled" | ReauthOutcome> {
  if (throttle.waitMs(now) > 0) return "throttled";
  try {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      const outcome = classifyReauthError(error);
      if (outcome === "wrong_password") throttle.fail(now);
      return outcome;
    }
  } catch {
    return "failed";
  }
  throttle.reset();
  try {
    await client.auth.signOut({ scope: "local" });
  } catch {
    /* the throwaway session expires on its own */
  }
  return "ok";
}
