import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unitEconomics, type DurationRow, type LedgerRow } from "../unitEconomics";
import {
  chargedPrices,
  coerceAccount,
  estimateRunCredits,
  frozenRunDurationS,
  isCreditExempt,
  newCreditRef,
  parseInsufficient,
  parsePrices,
  parseRunLimit,
  resolveCreditsEnforce,
  runDurationS,
  type CreditAccount,
  type CreditEstimate,
  type PriceMap,
} from "../credits";

/**
 * Prepaid credits, read on the server with the signed-in user's client (RLS:
 * migration 0020 shows an organization's credits to its viewers; the price
 * list as charged comes from credit_rates(), 0084, and the raw list with its
 * margins only to a platform owner/admin). No service key: reserving goes through the
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

/**
 * The organization's credit account. Three outcomes that must never blur:
 *  - `supported: false`  — migration 0020 is not applied on this deployment;
 *  - `failed: true`      — the read itself errored: the balance is UNKNOWN
 *                          (`account` is null), never 0;
 *  - otherwise           — a real answer. `hasRow: false` is an organization
 *                          that has never been granted anything: its balance
 *                          really is 0 (account is all zeros), which is a
 *                          different fact from "we could not read it".
 */
export async function readCreditAccount(
  supabase: SupabaseClient,
  orgId: string,
): Promise<{ supported: boolean; failed: boolean; hasRow: boolean; account: CreditAccount | null }> {
  const { data, error } = await supabase
    .from("credit_accounts")
    .select("balance,reserved")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    const missing = isCreditsMissing(error);
    return { supported: !missing, failed: !missing, hasRow: false, account: null };
  }
  return { supported: true, failed: false, hasRow: data != null, account: coerceAccount(data) };
}

export type PriceRead = { supported: boolean; failed: boolean; prices: PriceMap };

/**
 * The price list AS CHARGED — for every estimate, hold and customer screen:
 * credit_rates() (0084) gives each unit's rate with the platform's margin
 * folded in (margin reads 0 here) and never the margin or the note, which are
 * the platform's (BR-G-001). Before 0084 the function is missing and the
 * table is read instead (members could still read it then), folded the same
 * way: every charge works out identically, and no margin leaves this function.
 */
export async function readCreditPrices(supabase: SupabaseClient): Promise<PriceRead> {
  const { data, error } = await supabase.rpc("credit_rates");
  if (!error) return { supported: true, failed: false, prices: parsePrices(data) };
  // A read that errored is unknown, never an empty (free) list.
  if (!isCreditsMissing(error)) return { supported: true, failed: true, prices: {} };
  const legacy = await readCreditPriceList(supabase);
  return { ...legacy, prices: chargedPrices(legacy.prices) };
}

/**
 * The operator's price list — base rate, margin and note — for the price
 * editor and the operator's model board. Since 0084 the table answers a
 * platform owner/admin only: anyone else reads no rows, so this is never a
 * customer's price list (use readCreditPrices).
 */
export async function readCreditPriceList(supabase: SupabaseClient): Promise<PriceRead> {
  const { data, error } = await supabase
    .from("credit_prices")
    .select("unit,credits_per_unit,margin,note,updated_at")
    .order("unit");
  if (error) {
    const missing = isCreditsMissing(error);
    return { supported: !missing, failed: !missing, prices: {} };
  }
  return { supported: true, failed: false, prices: parsePrices(data) };
}

/** An estimate, or the fact that a read behind it failed (never a number from a partial read). */
export type EstimateRead = { ok: true; estimate: CreditEstimate } | { ok: false };

/**
 * The estimate for one run of `channelId`: the price list, and this channel's
 * last 30 days of cost ledger (with each video's real length from its Video
 * IR, when it has one) for the history basis. Everything is read as the user,
 * so an estimate can only ever be built from rows they may see.
 *
 * A ledger read that ERRORS is not an empty ledger: it would fall back to
 * another basis (the per-minute price) and produce a number that then gets
 * held and captured. It returns `{ ok: false }` instead. A ledger that reads
 * fine and is empty keeps its normal behaviour.
 */
export async function estimateForChannel(
  supabase: SupabaseClient,
  channelId: string,
  durationS: number | null,
  prices: PriceMap,
): Promise<EstimateRead> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("video_costs")
    .select("unit,quantity,stage,recorded_at,video_id,slug,channel_id,estimated_usd")
    .eq("channel_id", channelId)
    .gte("recorded_at", since)
    .limit(5000);
  if (error) return { ok: false };
  const rows = (data ?? []) as LedgerRow[];
  let ue = unitEconomics(rows);
  if (ue.sampleSize > 0 && durationS) {
    const slugs = [...new Set(ue.videos.flatMap((v) => (v.slug ? [v.slug] : [])))];
    if (slugs.length) {
      const { data: d, error: dErr } = await supabase
        .from("videos")
        .select("video_id,slug,channel_id,duration_s:manifest->audio->duration_s")
        .eq("channel_id", channelId)
        .in("slug", slugs);
      // Without the real lengths the history basis would silently change.
      if (dErr) return { ok: false };
      if (d?.length) ue = unitEconomics(rows, { durations: d as unknown as DurationRow[] });
    }
  }
  return { ok: true, estimate: estimateRunCredits({ prices, durationS, videos: ue.videos }) };
}

export type RunCreditResult =
  | {
      ok: true;
      creditRef: string | null;
      estimate: CreditEstimate | null;
      exempt: boolean;
      /** Queue runs: the length the hold was priced for, which the job must
       *  carry as params.duration. Null for an exempt run or an Actions run. */
      durationS: number | null;
    }
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
 *
 * A queue run ("rj") is priced at its FROZEN length (frozenRunDurationS) and
 * returns it: the job carries exactly that length, so what runs is what was
 * held for (migration 0041 refuses a job the hold does not cover). No length
 * at all is a refusal naming the fix, never a guess. The Actions path ("gh")
 * prices as it always has.
 */
/**
 * A hold reference that is the same every time the same person asks for the
 * same run with the same key (the Assistant's plan step). reserve_credits()
 * refuses a second hold with an existing reference (23505), so a double press
 * or a reload re-sending the step can never hold — or start — a second run.
 * Hashed so the reference carries no user id, and scoped by user and channel
 * so one person's key can never collide with another's.
 */
export function runCreditRefFor(prefix: "rj" | "gh", userId: string, channelId: string, key: string): string {
  const digest = createHash("sha256").update(`assistant-run\n${userId}\n${channelId}\n${key}`).digest("hex");
  return newCreditRef(prefix, digest.slice(0, 48));
}

export interface RunCreditOptions {
  /** The price the person confirmed: a higher estimate is refused (409 price_changed), nothing held. */
  maxCredits?: number | null;
  /** A stable hold reference (runCreditRefFor) instead of a fresh one: a replay is refused, never held twice. */
  creditRef?: string | null;
}

export async function reserveRunCredits(
  supabase: SupabaseClient,
  channelId: string,
  requestedDurationS: number | undefined,
  prefix: "rj" | "gh",
  opts: RunCreditOptions = {},
): Promise<RunCreditResult> {
  const unavailable = { ok: false as const, status: 503, body: { error: "credits_unavailable" } };
  // A read behind the quote errored: unknown, not a gap. Retry; nothing was held.
  const readFailedRun = { ok: false as const, status: 503, body: { error: "credits_read_failed" } };
  const { data: ch, error: chErr } = await supabase
    .from("channels")
    .select("org_id,agent_config")
    .eq("channel_id", channelId)
    .maybeSingle();
  if (chErr) return unavailable;
  if (!ch) return { ok: false, status: 404, body: { error: "channel_not_found" } };
  const orgId = typeof ch.org_id === "string" ? ch.org_id : null;
  if (!orgId) return unavailable;
  if (isCreditExempt(orgId)) return { ok: true, creditRef: null, estimate: null, exempt: true, durationS: null };

  const { supported, failed, prices } = await readCreditPrices(supabase);
  if (!supported) return unavailable;
  // A price list that could not be read is not an empty one: retryable, no hold.
  if (failed) return readFailedRun;
  const frozen = prefix === "rj" ? frozenRunDurationS(requestedDurationS, ch.agent_config) : null;
  if (prefix === "rj" && frozen === null)
    return { ok: false, status: 409, body: { error: "credit_estimate_unavailable", gap: "no_length" } };
  const durationS = prefix === "rj" ? frozen : runDurationS(requestedDurationS, ch.agent_config);
  const read = await estimateForChannel(supabase, channelId, durationS, prices);
  if (!read.ok) return readFailedRun;
  const estimate = read.estimate;
  if (estimate.credits === null)
    return { ok: false, status: 409, body: { error: "credit_estimate_unavailable", gap: estimate.gap } };

  // The person confirmed a price; a run that now costs more is asked again, never held.
  if (typeof opts.maxCredits === "number" && estimate.credits > opts.maxCredits)
    return { ok: false, status: 409, body: { error: "price_changed", credits: estimate.credits } };

  const creditRef = opts.creditRef ?? newCreditRef(prefix, crypto.randomUUID());
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
        body: {
          error: "insufficient_credits",
          needed: short.needed ?? estimate.credits,
          available: short.available,
          // 0094: extra credits are off, so `available` is what the plan side can pay.
          ...(short.extraOff ? { extra_off: true, extra: short.extra ?? null } : {}),
        },
      };
    const busy = parseRunLimit(error);
    if (busy) return { ok: false, status: 429, body: { error: "run_limit", active: busy.active, limit: busy.limit } };
    if (isCreditsMissing(error)) return unavailable;
    // The same stable reference was held before: this run was already started
    // by an earlier press of the same step. Answer that, never a second hold.
    if (error.code === "23505" && opts.creditRef) return { ok: false, status: 409, body: { error: "run_already_started" } };
    if (error.code === "42501") return { ok: false, status: 403, body: { error: "forbidden" } };
    return { ok: false, status: 502, body: { error: "credit_reserve_failed" } };
  }
  const exempt = !!(data && typeof data === "object" && (data as { exempt?: unknown }).exempt === true);
  return { ok: true, creditRef: exempt ? null : creditRef, estimate, exempt, durationS: exempt ? null : frozen };
}
