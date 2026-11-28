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
 * only ever left with NOTHING to do when its account HAS a verified factor, so
 * there is a code that can unblock it. An admin with no factor is never shut
 * out: in `off` and `warn` they get a banner pushing them to enrol at
 * /security; in `enforce` they may reach ONLY /security (where the enrolment
 * lives, so they can always get out of that state) and sign-out, and every
 * other page sends them there. Break-glass is the environment variable set to
 * `off` (or `warn`) (see the doc).
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
  /**
   * `enforce` only: an admin with NO verified factor may reach /security (to enrol one) and nothing else.
   * A page goes to /security, an API route answers 403 `mfa_enrol_required`. The banner still shows there.
   */
  | "enrol_only"
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
 * | mode    | aal2 | aal1, no factor               | aal1 + factor, admin | aal1 + factor, anyone else |
 * |---------|------|-------------------------------|----------------------|----------------------------|
 * | off     | allow| allow                         | allow                | allow                      |
 * | warn    | allow| admin: warn_enrol; else allow | warn_complete        | challenge                  |
 * | enforce | allow| admin: enrol_only; else allow | challenge            | challenge                  |
 *
 * An ordinary account with a factor is challenged in `warn` and `enforce`
 * alike: the mode is the OPERATOR gate's knob, and what an enrolled customer
 * signs up to is "a code at sign-in".
 */
export function mfaDecision({ mode, admin, aal, hasVerifiedFactor }: MfaInput): MfaAction {
  if (mode === "off") return "allow";
  if (normalizeAal(aal) === "aal2") return "allow";
  // Password-only (or unreadable) from here on.
  if (!hasVerifiedFactor) return admin ? (mode === "enforce" ? "enrol_only" : "warn_enrol") : "allow";
  if (!admin) return "challenge";
  return mode === "enforce" ? "challenge" : "warn_complete";
}

/**
 * Is the session's second factor older than the window? Mirrors admin_mfa_state()
 * (migration 0107): strictly older than `windowMinutes` is stale, exactly on it is
 * not, and an unreadable time or an unknown window is NOT stale (the database also
 * passes a session whose amr age it cannot read). One rule for every caller, so the
 * code page can never disagree with the database about who must type a code again.
 */
export function isSecondFactorStale(lastFactorAt: number | null, now: number, windowMinutes: number | null): boolean {
  if (lastFactorAt === null || windowMinutes === null || !Number.isFinite(windowMinutes)) return false;
  return now - lastFactorAt > windowMinutes * 60_000;
}

export interface VerifyPageInput {
  aal: string | null | undefined;
  hasVerifiedFactor: boolean;
  /** When the session's code was last typed (ms), from the token's `amr`; null = unreadable. */
  lastFactorAt: number | null;
  now: number;
  /** The database's recent_mfa_minutes while its gate is on; null = no staleness rule applies or it is unknown. */
  windowMinutes: number | null;
}

/**
 * Does /login/verify show the code form? An aal2 session whose code is older than
 * the database's window is treated like a password-only one: the owner AI (and every
 * owner_guard action) refuses it with `stale_mfa` and links here, so sending it
 * straight back made a loop the owner could never leave (found live 2026-11-21).
 * LOCKOUT SAFETY: an account with no verified factor never gets the form, whatever
 * its session says; there is no code it could type.
 */
export function verifyPageNeedsCode({ aal, hasVerifiedFactor, lastFactorAt, now, windowMinutes }: VerifyPageInput): boolean {
  if (!hasVerifiedFactor) return false;
  if (normalizeAal(aal) !== "aal2") return true;
  return isSecondFactorStale(lastFactorAt, now, windowMinutes);
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

/**
 * The pages an `enrol_only` admin may still open: the Security page, with or
 * without a channel in front of it (`/security`, `/chronos/security`; the
 * middleware sends `/security` to `/<channel>/security`). Exactly that shape,
 * nothing else: a `security` as a later segment, a longer path or a different
 * first segment (`/api/security`, `/a/b/security`) is not it.
 */
export function isEnrolOnlyPath(pathname: string): boolean {
  return /^\/(?:[^/]+\/)?security\/?$/.test(pathname) && !pathname.startsWith("/api/");
}

/** Where an `enrol_only` admin is sent. */
export const ENROL_PATH = "/security";
