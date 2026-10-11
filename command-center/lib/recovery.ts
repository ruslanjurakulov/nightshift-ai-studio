/**
 * Password recovery: the pieces /forgot-password, /auth/callback and
 * /reset-password share. Pure (no Next, no Supabase), so the decisions are
 * unit-tested.
 *
 * The flow: /forgot-password asks Supabase to e-mail a link; the link lands on
 * /auth/callback, which turns it into a recovery session (the PKCE `code`
 * straight away, a `token_hash` only after the "continue as <email>?" step of
 * lib/auth-confirm.ts) and drops a short-lived marker cookie; /reset-password
 * insists on a session AND the marker for that same person before it shows the
 * form. The marker keeps an ordinary signed-in session from landing on a page
 * that asks for no current password — it is a gate on the flow, not the
 * security boundary (the database's own session rules are).
 */

import { AUTH_CALLBACK_PATH, FORGOT_PASSWORD_PATH, RESET_PASSWORD_PATH } from "@/lib/public-paths";

export { FORGOT_PASSWORD_PATH, RESET_PASSWORD_PATH };

export const RECOVERY_COOKIE = "ns_recovery";
/** Long enough to choose a password; a recovery session is not forever. */
export const RECOVERY_MAX_AGE_SECONDS = 900;
/** How long "send again" waits on /forgot-password. */
export const RESEND_COOLDOWN_SECONDS = 60;

/** Why someone was sent back to /forgot-password: a closed set, never text from the URL. */
export const RECOVERY_NOTICES = ["expired", "needs_link"] as const;
export type RecoveryNotice = (typeof RECOVERY_NOTICES)[number];

export function isRecoveryNotice(value: string | null | undefined): value is RecoveryNotice {
  return (RECOVERY_NOTICES as readonly string[]).includes(value ?? "");
}

export interface RecoveryMarker {
  /** The account the recovery session belongs to. */
  uid: string;
  /** Unix seconds. */
  iat: number;
}

export function encodeRecovery(m: RecoveryMarker): string {
  return `${m.uid}.${m.iat}`;
}

/** The marker in a cookie value, or null when absent, malformed, expired or from the future. */
export function decodeRecovery(value: string | null | undefined, nowSeconds = Math.floor(Date.now() / 1000)): RecoveryMarker | null {
  if (!value || value.length > 100) return null;
  const m = /^([0-9a-f-]{36})\.(\d{9,12})$/.exec(value);
  if (!m) return null;
  const iat = Number(m[2]);
  if (nowSeconds - iat > RECOVERY_MAX_AGE_SECONDS || iat - nowSeconds > 60) return null;
  return { uid: m[1], iat };
}

/** Is this marker for the person who is signed in right now? */
export function recoveryMatches(marker: RecoveryMarker | null, userId: string | null | undefined): boolean {
  return Boolean(marker && userId && marker.uid === userId);
}

/** Cookie options for the marker: only /reset-password sees it, never script. */
export function recoveryCookieOptions(maxAge: number = RECOVERY_MAX_AGE_SECONDS) {
  return {
    path: RESET_PASSWORD_PATH,
    maxAge,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

/** Where the e-mailed link comes back to (`origin` is the PUBLIC origin of the site). */
export function recoveryRedirectTo(origin: string): string {
  return `${origin}${AUTH_CALLBACK_PATH}?next=${encodeURIComponent(RESET_PASSWORD_PATH)}`;
}

/** Just enough of the Supabase client to ask for a reset e-mail. */
export interface RecoveryClient {
  auth: {
    resetPasswordForEmail(email: string, options: { redirectTo: string }): PromiseLike<{ error: unknown }>;
  };
}

/**
 * Ask for the reset e-mail, and answer the SAME thing whatever happened.
 *
 * Supabase answers differently for an address with no account, an unconfirmed
 * one, one that was mailed a moment ago (a rate limit that exists only for real
 * accounts) and one that works. Any of those differences, shown, would let
 * anyone test which addresses have accounts. So the provider's answer — error
 * or not, thrown or not — is dropped: the caller shows one neutral message.
 * The only thing a person is told differently is something they can fix on
 * their own side, before anything is sent (a malformed address).
 */
export async function requestPasswordReset(
  supabase: RecoveryClient | null,
  email: string,
  origin: string,
): Promise<"sent" | "invalid_email" | "unavailable"> {
  const address = email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return "invalid_email";
  if (!supabase) return "unavailable";
  try {
    await supabase.auth.resetPasswordForEmail(address, { redirectTo: recoveryRedirectTo(origin) });
  } catch {
    /* dropped on purpose: see above */
  }
  return "sent";
}

/** Whole seconds left of a cooldown that started at `startedAt` (ms), 0 when it is over. */
export function cooldownLeft(startedAt: number | null, nowMs: number, seconds: number = RESEND_COOLDOWN_SECONDS): number {
  if (startedAt === null) return 0;
  return Math.max(0, Math.ceil((startedAt + seconds * 1000 - nowMs) / 1000));
}
