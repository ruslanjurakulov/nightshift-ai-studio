import { hasVerifiedTotpFactor, mfaDecision, type AdminMfaMode, type MfaAction } from "@/lib/security/admin-mfa";

/**
 * The middleware's second-factor check (the request-time half of
 * docs/security/ADMIN_MFA.md). Edge-safe: the Supabase client is passed in and
 * only its structural shape is used, so the whole decision runs in tests
 * against a fake.
 *
 * Cheap on purpose. It only does work for a signed-in session on an account
 * that HAS a verified factor and is not yet aal2 (an aal2 session is finished).
 * Only that rare session pays one extra call: "is this a platform admin?", which
 * decides between the warn banner and the challenge. An account with NO factor
 * costs a call only in `enforce` (the strict enrol-only rule needs to know
 * whether it is an admin), and that answer is remembered for a minute.
 *
 * Every error leans toward asking for the code (password-only, not an admin),
 * and never toward skipping it. The code page is passable by anyone who has
 * their authenticator and has a sign-out for anyone who does not, so leaning
 * that way costs a prompt, never a lockout.
 */
export interface MfaMiddlewareClient {
  auth: {
    mfa: {
      getAuthenticatorAssuranceLevel(): Promise<{ data: { currentLevel?: string | null } | null }>;
    };
  };
  rpc(fn: "is_platform_admin"): PromiseLike<{ data: unknown; error: unknown }>;
}

type MfaMiddlewareUser = (Parameters<typeof hasVerifiedTotpFactor>[0] & { id?: string }) | null | undefined;

/** Is this user a platform admin? Remembered a minute per user per process: the strict `enforce` rule asks it for every
 *  request of an account WITHOUT a factor (most customers), and only a successful answer is remembered. */
const ADMIN_TTL_MS = 60_000;
const ADMIN_CACHE_MAX = 500;
const adminCache = new Map<string, { admin: boolean; at: number }>();

/** For tests only. */
export function resetAdminCache(): void {
  adminCache.clear();
}

async function isAdminCached(supabase: MfaMiddlewareClient, id: string | undefined, now: number): Promise<boolean> {
  const hit = id ? adminCache.get(id) : undefined;
  if (hit && now - hit.at < ADMIN_TTL_MS) return hit.admin;
  try {
    const res = await supabase.rpc("is_platform_admin");
    if (res.error) return false;
    const admin = res.data === true;
    if (id) {
      if (adminCache.size >= ADMIN_CACHE_MAX) adminCache.clear();
      adminCache.set(id, { admin, at: now });
    }
    return admin;
  } catch {
    return false;
  }
}

export async function mfaMiddlewareAction(
  supabase: MfaMiddlewareClient,
  user: MfaMiddlewareUser,
  mode: AdminMfaMode,
  now: number = Date.now(),
): Promise<MfaAction> {
  if (mode === "off") return "allow";
  const hasVerifiedFactor = hasVerifiedTotpFactor(user);
  if (!hasVerifiedFactor) {
    // Strict `enforce`: an admin with no authenticator may reach only /security. Anyone else, and any error in the
    // lookup, is untouched: this is a tightening on top of the other layers, never a reason to block a customer.
    if (mode !== "enforce" || !user) return "allow";
    const admin = await isAdminCached(supabase, user.id, now);
    return mfaDecision({ mode, admin, aal: "aal1", hasVerifiedFactor: false });
  }
  let aal: string | null = null;
  try {
    aal = (await supabase.auth.mfa.getAuthenticatorAssuranceLevel()).data?.currentLevel ?? null;
  } catch {
    aal = null;
  }
  if (aal === "aal2") return "allow";
  let admin = false;
  try {
    const res = await supabase.rpc("is_platform_admin");
    admin = !res.error && res.data === true;
  } catch {
    admin = false;
  }
  return mfaDecision({ mode, admin, aal, hasVerifiedFactor });
}
