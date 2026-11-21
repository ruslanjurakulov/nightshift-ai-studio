/**
 * The sign-in second step: ask the browser Supabase client for the code's
 * challenge, verify it, and say in a fixed vocabulary what happened.
 *
 * Client-safe and SDK-shaped only through the small structural types below, so
 * the whole flow runs in tests against a fake (no network, no SDK). Nothing
 * here decides who is allowed anywhere: the session's level is what the
 * server reads (lib/security/admin-mfa-server.ts, the middleware); this only
 * walks the person to aal2.
 */

type AuthError = { code?: string; status?: number; message?: string; name?: string } | null | undefined;

export interface MfaFactor {
  id: string;
  friendlyName: string | null;
}

export interface MfaApi {
  getAuthenticatorAssuranceLevel(): Promise<{
    data: { currentLevel?: string | null; nextLevel?: string | null } | null;
    error: AuthError;
  }>;
  listFactors(): Promise<{
    data: { totp?: Array<{ id: string; friendly_name?: string | null; status?: string }> } | null;
    error: AuthError;
  }>;
  challenge(args: { factorId: string }): Promise<{ data: { id: string } | null; error: AuthError }>;
  verify(args: { factorId: string; challengeId: string; code: string }): Promise<{ data: unknown; error: AuthError }>;
}

export interface MfaClient {
  auth: { mfa: MfaApi; signOut?: (o?: { scope?: "local" | "global" | "others" }) => PromiseLike<unknown> };
}

/** After a password sign-in: is the session finished, or does it need a code? */
export type SignInStep = "done" | "challenge";

/**
 * `challenge` when the session is password-only (aal1) and the account can
 * reach aal2. If the level cannot be read, the answer is `challenge` too: the
 * code page asks the SERVER, which reads it authoritatively and moves on at
 * once when nothing is needed — so an unreadable level can only cost a hop,
 * never skip a code.
 */
export async function signInNextStep(supabase: MfaClient): Promise<SignInStep> {
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return "challenge";
    return data.currentLevel === "aal1" && data.nextLevel === "aal2" ? "challenge" : "done";
  } catch {
    return "challenge";
  }
}

/** The account's verified authenticator apps (Supabase lists only verified TOTP factors under `totp`). */
export async function listTotpFactors(supabase: MfaClient): Promise<MfaFactor[] | null> {
  try {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error || !data) return null;
    return (data.totp ?? [])
      .filter((f) => f.status === undefined || f.status === "verified")
      .map((f) => ({ id: f.id, friendlyName: f.friendly_name ?? null }));
  } catch {
    return null;
  }
}

export type ChallengeFailure =
  /** The code did not match (mistyped, or the phone's clock is off). */
  | "wrong_code"
  /** The challenge ran out before the code arrived: ask again with a fresh one. */
  | "expired"
  /** Too many attempts: wait a little. */
  | "rate_limited"
  /** The factor is gone (removed on another device). */
  | "no_factor"
  /** Anything else, including the network. */
  | "failed";

export type ChallengeResult = { ok: true } | { ok: false; reason: ChallengeFailure };

/** A code is six digits; spaces (authenticator apps group them) and nothing else are forgiven. */
export function cleanCode(raw: string): string | null {
  const code = raw.replace(/\s+/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}

/** Map Supabase's error to the fixed vocabulary. Its wording changes between releases; codes and statuses are used first. */
export function classifyChallengeError(error: AuthError): ChallengeFailure {
  if (!error) return "failed";
  const code = error.code ?? "";
  const text = `${code} ${error.message ?? ""}`.toLowerCase();
  if (code === "mfa_challenge_expired" || /challenge.*expired|expired.*challenge/.test(text)) return "expired";
  if (error.status === 429 || code === "over_request_rate_limit" || /rate.?limit|too many/.test(text)) return "rate_limited";
  if (code === "mfa_factor_not_found" || /factor.*not.*found/.test(text)) return "no_factor";
  if (code === "mfa_verification_failed" || /invalid.*(totp|code)|verification.*failed/.test(text)) return "wrong_code";
  return "failed";
}

/**
 * Challenge and verify, then confirm the session really is aal2 now. Each call
 * makes a FRESH challenge, so a code typed late never meets a stale one.
 */
export async function completeTotpChallenge(supabase: MfaClient, factorId: string, rawCode: string): Promise<ChallengeResult> {
  const code = cleanCode(rawCode);
  if (!code) return { ok: false, reason: "wrong_code" };
  try {
    const challenge = await supabase.auth.mfa.challenge({ factorId });
    if (challenge.error || !challenge.data) return { ok: false, reason: classifyChallengeError(challenge.error) };
    const verified = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code });
    if (verified.error) return { ok: false, reason: classifyChallengeError(verified.error) };
    // Do not take the verify call's word alone: the session must now say aal2.
    const level = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (level.error || level.data?.currentLevel !== "aal2") return { ok: false, reason: "failed" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
