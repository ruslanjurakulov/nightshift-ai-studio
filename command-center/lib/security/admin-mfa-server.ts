import "server-only";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { ADMIN_MFA_ENV, hasVerifiedTotpFactor, parseAdminMfaMode, type AdminMfaMode } from "@/lib/security/admin-mfa";
import { lastSecondFactorAtMs, parseRecentMfaMinutes, recentMfaDecision } from "@/lib/security/recent-mfa";

/**
 * What the server knows about this request's second factor, read the safe way.
 *
 * - The factors come from `auth.getUser()`: the auth server's own answer. They
 *   are NOT read from the session cookie, whose `user` object is unsigned
 *   JSON: a stolen password plus an edited cookie that says "no factors"
 *   would otherwise skip the code.
 * - The level (`aal1` / `aal2`) comes from the session's access token, which
 *   `getUser()` has just had the auth server verify.
 * - Anything unreadable is "password-only": it can only ever ask for MORE.
 */

/** The mode, read on every call (never at import): a restart is enough to change it. */
export function adminMfaMode(): AdminMfaMode {
  return parseAdminMfaMode(process.env.NIGHTSHIFT_ADMIN_MFA);
}

export type MfaUser = Parameters<typeof hasVerifiedTotpFactor>[0] & { id: string };

export interface MfaState {
  userId: string;
  /** The session's level, or null when it could not be read (treated as password-only). */
  aal: string | null;
  hasVerifiedFactor: boolean;
  /** When the session's code was last typed (ms), from the token's `amr`; null = unreadable or never. */
  lastFactorAt: number | null;
}

/**
 * The level and factor state of an already-fetched user (`getUser()`), so the
 * gate costs no extra round trip to the auth server: the level is read from
 * the session the SDK holds locally. null = not signed in, or unreadable.
 */
export async function readMfaState(user: MfaUser | null | undefined): Promise<MfaState | null> {
  if (!user) return null;
  try {
    const supabase = await createClient();
    if (!supabase) return null;
    let aal: string | null = null;
    let lastFactorAt: number | null = null;
    try {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      aal = data?.currentLevel ?? null;
      lastFactorAt = lastSecondFactorAtMs(data?.currentAuthenticationMethods);
    } catch {
      aal = null;
    }
    return { userId: user.id, aal, hasVerifiedFactor: hasVerifiedTotpFactor(user), lastFactorAt };
  } catch {
    return null;
  }
}

const WARN_EVERY_MS = 60 * 60 * 1000;
const warned = new Map<string, number>();

/** For tests only: forget what was already logged. */
export function resetMfaWarnThrottle(): void {
  warned.clear();
}

/**
 * A server-side warning for an admin session that is still password-only although a code is available.
 * No e-mail, no token. At most once per process, per user-id prefix, per hour: in `warn` mode every admin
 * request would otherwise log it.
 */
export function logPasswordOnlyAdmin(userId: string, now: number = Date.now()): void {
  const key = userId.slice(0, 8);
  const last = warned.get(key);
  if (last !== undefined && now - last < WARN_EVERY_MS) return;
  warned.set(key, now);
  console.warn(
    `[admin-mfa] warn: platform admin ${key} is on a password-only (aal1) session and has a verified second factor; ` +
      `${ADMIN_MFA_ENV}=enforce would have blocked this request`,
  );
}

/**
 * The recent-second-factor step-up (lib/security/recent-mfa.ts) for a write that
 * can redirect alerts or the pipeline's credentials. null = carry on; otherwise the
 * 401 `mfa_recent_required` to send. Only `enforce` ever answers anything but null,
 * and only for an aal2 session whose code is older than the window; the way
 * through is to sign out, sign in and type the code.
 */
export async function requireRecentMfa(user: MfaUser | null | undefined, now: number = Date.now()): Promise<NextResponse | null> {
  const mode = adminMfaMode();
  if (mode !== "enforce") return null;
  const state = await readMfaState(user);
  if (!state) return null;
  const verdict = recentMfaDecision({
    mode,
    aal: state.aal,
    lastFactorAt: state.lastFactorAt,
    now,
    windowMinutes: parseRecentMfaMinutes(process.env.NIGHTSHIFT_ADMIN_MFA_RECENT_MINUTES),
  });
  return verdict === "stale"
    ? NextResponse.json({ error: "mfa_recent_required" }, { status: 401, headers: { "cache-control": "no-store" } })
    : null;
}
