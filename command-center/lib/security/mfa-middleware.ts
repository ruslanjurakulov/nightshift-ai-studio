import { hasVerifiedTotpFactor, mfaDecision, type AdminMfaMode, type MfaAction } from "@/lib/security/admin-mfa";

/**
 * The middleware's second-factor check (the request-time half of
 * docs/security/ADMIN_MFA.md). Edge-safe: the Supabase client is passed in and
 * only its structural shape is used, so the whole decision runs in tests
 * against a fake.
 *
 * Cheap on purpose. It only does work for a signed-in session on an account
 * that HAS a verified factor and is not yet aal2 (an account with no factor is
 * never blocked, so nothing needs asking; an aal2 session is finished). Only
 * that rare session pays one extra call: "is this a platform admin?", which
 * decides between the warn banner and the challenge.
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

export async function mfaMiddlewareAction(
  supabase: MfaMiddlewareClient,
  user: Parameters<typeof hasVerifiedTotpFactor>[0],
  mode: AdminMfaMode,
): Promise<MfaAction> {
  if (mode === "off") return "allow";
  const hasVerifiedFactor = hasVerifiedTotpFactor(user);
  if (!hasVerifiedFactor) return "allow";
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
