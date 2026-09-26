import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unitEconomics, type DurationRow, type LedgerRow } from "../unitEconomics";
import {
  coerceAccount,
  estimateRunCredits,
  isCreditExempt,
  newCreditRef,
  parseInsufficient,
  parsePrices,
  resolveCreditsEnforce,
  runDurationS,
  type CreditAccount,
  type CreditEstimate,
  type PriceMap,
} from "../credits";

/**
 * Prepaid credits, read on the server with the signed-in user's client (RLS:
 * migration 0020 shows an organization's credits to its viewers, the price
 * list to every signed-in account). No service key: reserving goes through the
 * security-definer reserve_credits(), which checks the caller's role itself.
 */

/** This deployment's switch (server env NIGHTSHIFT_CREDITS_ENFORCE). */
export const creditsEnforced: boolean = resolveCreditsEnforce({
  NIGHTSHIFT_CREDITS_ENFORCE: process.env.NIGHTSHIFT_CREDITS_ENFORCE,
});

/** A missing table/function means 0020 is not applied — say so, never "0 credits". */
export function isCreditsMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    error.code === "PGRST202" ||
    error.code === "42883" ||
    /does not exist|could not find/i.test(error.message ?? "")
  );
}

export async function readCreditAccount(
  supabase: SupabaseClient,
  orgId: string,
): Promise<{ supported: boolean; account: CreditAccount | null }> {
  const { data, error } = await supabase
    .from("credit_accounts")
    .select("balance,reserved")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return { supported: !isCreditsMissing(error), account: null };
  return { supported: true, account: coerceAccount(data) };
}

export async function readCreditPrices(
  supabase: SupabaseClient,
): Promise<{ supported: boolean; prices: PriceMap }> {
  const { data, error } = await supabase
    .from("credit_prices")
    .select("unit,credits_per_unit,margin,note,updated_at")
    .order("unit");
  if (error) return { supported: !isCreditsMissing(error), prices: {} };
  return { supported: true, prices: parsePrices(data) };
}

/**
 * The estimate for one run of `channelId`: the price list, and this channel's
 * last 30 days of cost ledger (with each video's real length from its Video
 * IR, when it has one) for the history basis. Everything is read as the user,
 * so an estimate can only ever be built from rows they may see.
 */
export async function estimateForChannel(
  supabase: SupabaseClient,
  channelId: string,
  durationS: number | null,
  prices: PriceMap,
): Promise<CreditEstimate> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data } = await supabase
    .from("video_costs")
    .select("unit,quantity,stage,recorded_at,video_id,slug,channel_id,estimated_usd")
    .eq("channel_id", channelId)
    .gte("recorded_at", since)
    .limit(5000);
  const rows = (data ?? []) as LedgerRow[];
  let ue = unitEconomics(rows);
  if (ue.sampleSize > 0 && durationS) {
    const slugs = [...new Set(ue.videos.flatMap((v) => (v.slug ? [v.slug] : [])))];
    if (slugs.length) {
      const { data: d } = await supabase
        .from("videos")
        .select("video_id,slug,channel_id,duration_s:manifest->audio->duration_s")
        .eq("channel_id", channelId)
        .in("slug", slugs);
      if (d?.length) ue = unitEconomics(rows, { durations: d as unknown as DurationRow[] });
    }
  }
  return estimateRunCredits({ prices, durationS, videos: ue.videos });
}

export type RunCreditResult =
  | { ok: true; creditRef: string | null; estimate: CreditEstimate | null; exempt: boolean }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Reserve the credits for one Run now, before anything is dispatched or
 * queued. Only called with NIGHTSHIFT_CREDITS_ENFORCE on; enforcement then
 * fails CLOSED — a database without 0020, or a channel with no organization
 * on record, is a refusal that names the fix, never a free run.
 *
 * The estimate is computed here, on the server, from the price list and the
 * channel's own ledger; nothing the browser sends sets the amount. The hold
 * goes through reserve_credits() as the signed-in user: the function checks
 * they are an admin of the channel's organization, locks the account, and
 * refuses with NS402 when the available balance does not cover it.
 */
export async function reserveRunCredits(
  supabase: SupabaseClient,
  channelId: string,
  requestedDurationS: number | undefined,
  prefix: "rj" | "gh",
): Promise<RunCreditResult> {
  const unavailable = { ok: false as const, status: 503, body: { error: "credits_unavailable" } };
  const { data: ch, error: chErr } = await supabase
    .from("channels")
    .select("org_id,agent_config")
    .eq("channel_id", channelId)
    .maybeSingle();
  if (chErr) return unavailable;
  if (!ch) return { ok: false, status: 404, body: { error: "channel_not_found" } };
  const orgId = typeof ch.org_id === "string" ? ch.org_id : null;
  if (!orgId) return unavailable;
  if (isCreditExempt(orgId)) return { ok: true, creditRef: null, estimate: null, exempt: true };

  const { supported, prices } = await readCreditPrices(supabase);
  if (!supported) return unavailable;
  const estimate = await estimateForChannel(supabase, channelId, runDurationS(requestedDurationS, ch.agent_config), prices);
  if (estimate.credits === null)
    return { ok: false, status: 409, body: { error: "credit_estimate_unavailable", gap: estimate.gap } };

  const creditRef = newCreditRef(prefix, crypto.randomUUID());
  const { data, error } = await supabase.rpc("reserve_credits", {
    p_org: orgId,
    p_job_id: creditRef,
    p_amount: estimate.credits,
  });
  if (error) {
    const short = parseInsufficient(error);
    if (short)
      return {
        ok: false,
        status: 402,
        body: { error: "insufficient_credits", needed: short.needed ?? estimate.credits, available: short.available },
      };
    if (isCreditsMissing(error)) return unavailable;
    if (error.code === "42501") return { ok: false, status: 403, body: { error: "forbidden" } };
    return { ok: false, status: 502, body: { error: "credit_reserve_failed" } };
  }
  const exempt = !!(data && typeof data === "object" && (data as { exempt?: unknown }).exempt === true);
  return { ok: true, creditRef: exempt ? null : creditRef, estimate, exempt };
}
