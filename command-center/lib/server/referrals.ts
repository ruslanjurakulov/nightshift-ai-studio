import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import { isMissingFunction } from "@/lib/orgs";
import { cachedPublicRead } from "@/lib/server/public-read";
import {
  coerceMyReferrals,
  coerceReferralAdmin,
  coerceReferralTerms,
  type MyReferrals,
  type ReferralAdmin,
  type ReferralRead,
  type ReferralTerms,
} from "@/lib/referrals";
import type { RpcClient } from "@/lib/server/friend-invites";

export type { ReferralRead };

/**
 * The server half of the referral programme (migration 0165).
 *
 * Nothing here decides who is paid or how much: referral_settle_locked does, inside the database, under the referrer's own
 * link lock. The Credits page asks claim_referral_rewards() in the member's own session (the anon key and their JWT, never the
 * service key): the database settles THAT person's referrals and answers their counts. No argument reaches the rule; a browser
 * that called the same function would get the same answer and move no more money.
 */

type RpcError = { code?: string; message?: string } | null;

async function rpcRead<T>(client: RpcClient, fn: string, coerce: (raw: unknown) => T | null): Promise<ReferralRead<T> | { state: "error" }> {
  try {
    const { data, error } = await client.rpc(fn);
    if (error) return isMissingFunction(error as RpcError) ? { state: "unsupported" } : { state: "error" };
    const value = coerce(data);
    return value ? { state: "ok", value } : { state: "failed" };
  } catch {
    return { state: "error" };
  }
}

/**
 * The person's own referrals, settled first. When the settle itself fails (a lock wait, a timeout), the plain read still
 * answers: the counts are true as of the last settle, and the next visit (or the hourly job) settles again.
 */
export async function readMyReferrals(client: RpcClient): Promise<ReferralRead<MyReferrals>> {
  const claimed = await rpcRead(client, "claim_referral_rewards", coerceMyReferrals);
  if (claimed.state !== "error") return claimed;
  const read = await rpcRead(client, "my_referrals", coerceMyReferrals);
  return read.state === "error" ? { state: "failed" } : read;
}

/** The operator's numbers and counts; the database refuses anyone else. */
export async function readReferralAdmin(client: RpcClient): Promise<ReferralRead<ReferralAdmin>> {
  const read = await rpcRead(client, "referral_admin", coerceReferralAdmin);
  return read.state === "error" ? { state: "failed" } : read;
}

/**
 * The public terms' numbers (referral_terms(), anon), bounded and shared like every public read (lib/server/public-read.ts).
 * null = could not be read (no backend, a failure, a timeout): the page then shows no number at all.
 */
export async function readReferralTerms(): Promise<ReferralRead<ReferralTerms>> {
  if (!isSupabaseConfigured) return { state: "failed" };
  const kept = await cachedPublicRead<ReferralRead<ReferralTerms>>("referral_terms", async (signal) => {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data, error } = await client.rpc("referral_terms").abortSignal(signal);
    if (error) return isMissingFunction(error as RpcError) ? { state: "unsupported" } : null;
    const value = coerceReferralTerms(data);
    return value ? { state: "ok", value } : null;
  });
  return kept ?? { state: "failed" };
}
