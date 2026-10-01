import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCreditExempt } from "../credits";
import { scopeQuery, type ChannelScope } from "../channels";
import {
  STORYBOARD_COLUMNS,
  STORYBOARD_EDIT_COLUMNS,
  isStoryboardId,
  toStoryboard,
  type ReopenState,
  type StoryboardQuote,
  type StoryboardView,
} from "../storyboardReview";
import { creditsEnforced, estimateForChannel, isCreditsMissing, readCreditPrices } from "./credits";

/**
 * Storyboards (migration 0057), read on the server with the signed-in user's
 * client: RLS shows a storyboard to members of its channel's organization and
 * to nobody else. No service key — approving and discarding go through the
 * security-definer functions, which check the caller's right to start runs.
 */

export type StoryboardRead =
  | { ok: true; storyboard: StoryboardView }
  | { ok: false; status: number; error: "not_found" | "storyboard_unavailable" | "read_failed" };

export async function readStoryboard(supabase: SupabaseClient, id: string): Promise<StoryboardRead> {
  if (!isStoryboardId(id)) return { ok: false, status: 404, error: "not_found" };
  let { data, error } = await supabase.from("storyboards").select(STORYBOARD_EDIT_COLUMNS).eq("id", id).maybeSingle();
  if (error && isMissingColumn(error)) {
    // 0057 without 0058: the storyboard reads as before, with no revision —
    // so nothing on the screen offers to edit it.
    ({ data, error } = await supabase.from("storyboards").select(STORYBOARD_COLUMNS).eq("id", id).maybeSingle());
  }
  if (error) {
    // 0057 not applied: say so, never "not found".
    if (isCreditsMissing(error)) return { ok: false, status: 503, error: "storyboard_unavailable" };
    return { ok: false, status: 503, error: "read_failed" };
  }
  const storyboard = toStoryboard(data);
  if (!storyboard) return { ok: false, status: 404, error: "not_found" };
  return { ok: true, storyboard };
}

/** PostgREST's "no such column" (42703) — a migration that adds columns is
 *  not applied yet. Distinct from a missing table (0057 itself not applied). */
function isMissingColumn(error: { code?: string; message?: string }): boolean {
  return error.code === "42703" || /column .* does not exist/i.test(error.message ?? "");
}

/**
 * Whether an approved storyboard whose render did not finish may go back to
 * waiting (0058 storyboard_reopen_check — the same rule reopen_storyboard
 * enforces). Null when it cannot be known (not allowed, 0058 not applied, the
 * read failed): the screen then offers nothing, never a guess.
 */
export async function readReopenState(supabase: SupabaseClient, id: string): Promise<ReopenState | null> {
  if (!isStoryboardId(id)) return null;
  const { data, error } = await supabase.rpc("storyboard_reopen_check", { p_storyboard: id });
  if (error || !data || typeof data !== "object") return null;
  const r = data as Record<string, unknown>;
  if (typeof r.reopenable !== "boolean") return null;
  return { reopenable: r.reopenable, reason: typeof r.reason === "string" ? r.reason : null };
}

/** Waiting storyboards of the channels in scope, newest first. Null when the
 *  read failed — the caller shows that, never an empty list. A database
 *  without 0057 has none waiting. */
export async function listWaitingStoryboards(
  supabase: SupabaseClient,
  scope: ChannelScope,
): Promise<StoryboardView[] | null> {
  const { data, error } = await scopeQuery(
    supabase.from("storyboards").select(STORYBOARD_COLUMNS).eq("status", "ready"),
    scope,
  )
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return isCreditsMissing(error) ? [] : null;
  return (data ?? []).flatMap((r) => {
    const s = toStoryboard(r);
    return s ? [s] : [];
  });
}

/**
 * The price of rendering this storyboard: the same estimate Run now holds
 * (lib/server/credits.ts estimateForChannel — the price list and the channel's
 * own ledger), at the storyboard's own length. Nothing the browser sends sets
 * it. The operator's own organization is "included"; a deployment that does
 * not enforce credits has no price to show for a customer, so the render
 * cannot be approved there (the route says the same).
 */
export async function quoteStoryboard(
  supabase: SupabaseClient,
  storyboard: Pick<StoryboardView, "channelId" | "durationS">,
  orgId: string | null,
): Promise<StoryboardQuote> {
  if (orgId && isCreditExempt(orgId)) return { kind: "included" };
  if (!orgId) {
    const { data, error } = await supabase
      .from("channels")
      .select("org_id")
      .eq("channel_id", storyboard.channelId)
      .maybeSingle();
    if (error) return { kind: "unavailable", reason: "read_failed" };
    if (isCreditExempt(typeof data?.org_id === "string" ? data.org_id : null)) return { kind: "included" };
  }
  if (!creditsEnforced) return { kind: "unavailable", reason: "not_enforced" };
  const { supported, failed, prices } = await readCreditPrices(supabase);
  if (!supported || failed) return { kind: "unavailable", reason: "read_failed" };
  const read = await estimateForChannel(supabase, storyboard.channelId, storyboard.durationS, prices);
  if (!read.ok) return { kind: "unavailable", reason: "read_failed" };
  if (read.estimate.credits === null) return { kind: "unavailable", reason: read.estimate.gap ?? "no_prices" };
  return { kind: "paid", credits: read.estimate.credits };
}
