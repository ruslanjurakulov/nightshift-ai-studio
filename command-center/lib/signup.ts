/**
 * Self-serve sign-up and sign-in: the decisions worth pinning, without React.
 *
 * Supabase's errors are written for developers ("AuthApiError: over_email_send_rate_limit")
 * and change wording between releases, so the pages never show one. Each is
 * mapped to a small fixed set of outcomes, and each outcome has a sentence in
 * all three dictionaries that tells the person what to do next.
 */

/** Matches the Supabase project's minimum; the form asks for it up front so
 *  a short password is refused here, not after a round trip. */
export const PASSWORD_MIN = 8;
/** bcrypt, which Supabase uses, ignores everything past 72 bytes. */
export const PASSWORD_MAX = 72;

export interface SignupInput {
  email: string;
  password: string;
  confirm: string;
  consent: boolean;
}

export type SignupFieldError =
  | "email_invalid"
  | "password_short"
  | "password_long"
  | "password_mismatch"
  | "consent_required";

/** A loose shape check — the confirmation email is the real proof. */
export function isPlausibleSignupEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
}

/** The first thing wrong with the form, in the order the fields appear. */
export function validateSignup(input: SignupInput): SignupFieldError | null {
  if (!isPlausibleSignupEmail(input.email)) return "email_invalid";
  if (input.password.length < PASSWORD_MIN) return "password_short";
  if (new TextEncoder().encode(input.password).length > PASSWORD_MAX) return "password_long";
  if (input.password !== input.confirm) return "password_mismatch";
  if (!input.consent) return "consent_required";
  return null;
}

/** What a sign-up attempt came to, as the page tells it. */
export type SignupOutcome =
  | "check_email"
  | "signed_in"
  | "already_registered"
  | "weak_password"
  | "rate_limited"
  | "email_invalid"
  | "signups_closed"
  | "failed";

export interface AuthErrorLike {
  code?: string | null;
  status?: number | null;
  message?: string | null;
  name?: string | null;
}

function codeOf(error: AuthErrorLike): string {
  return (error.code ?? "").toLowerCase();
}

function isRateLimit(error: AuthErrorLike): boolean {
  const code = codeOf(error);
  return error.status === 429 || code.startsWith("over_") || /rate limit/i.test(error.message ?? "");
}

/** Map a signUp() error to an outcome. Unknown errors are "failed", never echoed. */
export function classifySignupError(error: AuthErrorLike): SignupOutcome {
  const code = codeOf(error);
  if (isRateLimit(error)) return "rate_limited";
  if (code === "user_already_exists" || code === "email_exists" || /already registered/i.test(error.message ?? ""))
    return "already_registered";
  if (code === "weak_password" || error.name === "AuthWeakPasswordError") return "weak_password";
  if (code === "email_address_invalid" || code === "email_address_not_authorized") return "email_invalid";
  if (code === "signup_disabled" || code === "email_provider_disabled") return "signups_closed";
  return "failed";
}

/**
 * Map a successful signUp() response to an outcome.
 *
 * With "Confirm email" on, Supabase answers a sign-up for an address that is
 * already registered with a user that has no identities and sends no mail —
 * so the address cannot be probed through an error. Telling the person to
 * sign in instead is still the honest thing to say: they are the one holding
 * the form, and "check your email" would have them wait for a message that
 * never comes.
 */
export function classifySignupResult(data: {
  user: { identities?: unknown[] | null } | null;
  session: unknown | null;
}): SignupOutcome {
  if (data.session) return "signed_in";
  const identities = data.user?.identities;
  if (data.user && Array.isArray(identities) && identities.length === 0) return "already_registered";
  return "check_email";
}

/** What a sign-in attempt came to. */
export type SignInOutcome = "invalid_credentials" | "email_not_confirmed" | "rate_limited" | "failed";

export function classifySignInError(error: AuthErrorLike): SignInOutcome {
  const code = codeOf(error);
  if (isRateLimit(error)) return "rate_limited";
  if (code === "email_not_confirmed" || /email not confirmed/i.test(error.message ?? "")) return "email_not_confirmed";
  if (code === "invalid_credentials" || /invalid login credentials/i.test(error.message ?? ""))
    return "invalid_credentials";
  return "failed";
}

/**
 * Why /auth/callback sent someone back to /login, as a `?error=` value. Kept to
 * a fixed set so the login page never renders text from the URL.
 */
export const CALLBACK_ERRORS = ["link_expired", "link_invalid"] as const;
export type CallbackError = (typeof CALLBACK_ERRORS)[number];

export function isCallbackError(value: string | null | undefined): value is CallbackError {
  return (CALLBACK_ERRORS as readonly string[]).includes(value ?? "");
}

/** Supabase's own error on the redirect (`error_code=otp_expired` …) → ours. */
export function callbackErrorFor(errorCode: string | null | undefined): CallbackError {
  return errorCode === "otp_expired" ? "link_expired" : "link_invalid";
}
