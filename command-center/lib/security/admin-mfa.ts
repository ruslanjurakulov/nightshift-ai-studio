import { normalizeAal } from "@/lib/security/aal";
import { MFA_VERIFY_PATH } from "@/lib/public-paths";

export { MFA_VERIFY_PATH };

/**
 * The application-layer second-factor gate (docs/security/ADMIN_MFA.md).
 *
 * Pure and client-safe: the decision, and nothing that reads a request. The
 * server half that reads the session is lib/security/admin-mfa-server.ts; the
 * middleware, the app layout, the operator guards and the sign-in page all
 * ask THIS function, so they cannot disagree about who is let through.
 *
 * Supabase Auth reports an Authenticator Assurance Level per session: `aal1`
 * (password, magic link, Google) or `aal2` (a TOTP code was entered this
 * session). A verified factor on the account is what makes aal2 possible.
 *
 * LOCKOUT SAFETY, the one rule everything here bends around: a session is
 * only ever blocked when its account HAS a verified factor, so there is a code
 * that can unblock it. An admin with no factor is never blocked in any mode;
 * they get a banner pushing them to enrol at /security. Break-glass is the
 * environment variable set to `off` (see the doc).
 */

export const ADMIN_MFA_ENV = "NIGHTSHIFT_ADMIN_MFA";

/** `off`: nothing is enforced anywhere (break-glass). `warn` (default): admins are
 *  told, never blocked. `enforce`: an admin with a factor must complete the code. */
export type AdminMfaMode = "off" | "warn" | "enforce";

/**
 * The mode named by the environment. Anything that is not exactly `off` or
 * `enforce` (unset, empty, a typo, `Enforce `) is `warn`: a typo must neither
 * switch the gate off nor start blocking people.
 */
export function parseAdminMfaMode(raw: string | null | undefined): AdminMfaMode {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "off" || value === "enforce" ? value : "warn";
}

export type MfaAction =
  /** Nothing to say or do. */
  | "allow"
  /** Admin, factor enrolled, session still password-only: let through, show the banner, log a warning. */
  | "warn_complete"
  /** Admin with no factor: let through, show the banner that pushes enrolment at /security. */
  | "warn_enrol"
  /** Send to the code page (a page) or answer 401 `mfa_required` (an API route). */
  | "challenge";

export interface MfaInput {
  mode: AdminMfaMode;
  /** A platform owner/admin (is_platform_admin). false = anyone else. */
  admin: boolean;
  /** The session's level as read from its token; anything unreadable counts as password-only. */
  aal: string | null | undefined;
  /** The account has at least one VERIFIED second factor, as the auth server reports it. */
  hasVerifiedFactor: boolean;
}

/**
 * What to do with this session.
 *
 * | mode    | aal2 | aal1, no factor           | aal1 + factor, admin | aal1 + factor, anyone else |
 * |---------|------|---------------------------|----------------------|----------------------------|
 * | off     | allow| allow                     | allow                | allow                      |
 * | warn    | allow| admin: warn_enrol; else allow | warn_complete    | challenge                  |
 * | enforce | allow| admin: warn_enrol; else allow | challenge        | challenge                  |
 *
 * An ordinary account with a factor is challenged in `warn` and `enforce`
 * alike: the mode is the OPERATOR gate's knob, and what an enrolled customer
 * signs up to is "a code at sign-in".
 */
export function mfaDecision({ mode, admin, aal, hasVerifiedFactor }: MfaInput): MfaAction {
  if (mode === "off") return "allow";
  if (normalizeAal(aal) === "aal2") return "allow";
  // Password-only (or unreadable) from here on.
  if (!hasVerifiedFactor) return admin ? "warn_enrol" : "allow";
  if (!admin) return "challenge";
  return mode === "enforce" ? "challenge" : "warn_complete";
}

/** The code page, remembering where the person was going. `next` is validated again there. */
export function mfaVerifyUrl(next?: string | null): string {
  return next ? `${MFA_VERIFY_PATH}?next=${encodeURIComponent(next)}` : MFA_VERIFY_PATH;
}

/**
 * Does this user object (from the auth server, not from a cookie) carry a
 * verified TOTP factor? A factor that was started and never confirmed
 * (`unverified`) is not one: it cannot produce a session, so it must never
 * make anyone's sign-in depend on it.
 */
export function hasVerifiedTotpFactor(
  user: { factors?: ReadonlyArray<{ status?: string | null; factor_type?: string | null }> | null } | null | undefined,
): boolean {
  return (user?.factors ?? []).some(
    (f) => f?.status === "verified" && (f.factor_type === undefined || f.factor_type === null || f.factor_type === "totp"),
  );
}
