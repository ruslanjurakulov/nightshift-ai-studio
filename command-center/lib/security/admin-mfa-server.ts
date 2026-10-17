import "server-only";
import { createClient } from "@/lib/supabase/server";
import { ADMIN_MFA_ENV, hasVerifiedTotpFactor, parseAdminMfaMode, type AdminMfaMode } from "@/lib/security/admin-mfa";

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
    try {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      aal = data?.currentLevel ?? null;
    } catch {
      aal = null;
    }
    return { userId: user.id, aal, hasVerifiedFactor: hasVerifiedTotpFactor(user) };
  } catch {
    return null;
  }
}

/** A server-side warning for an admin session that is still password-only although a code is available. No e-mail, no token. */
export function logPasswordOnlyAdmin(userId: string): void {
  console.warn(
    `[admin-mfa] warn: platform admin ${userId.slice(0, 8)} is on a password-only (aal1) session and has a verified second factor; ` +
      `${ADMIN_MFA_ENV}=enforce would have blocked this request`,
  );
}
