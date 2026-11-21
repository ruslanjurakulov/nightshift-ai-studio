import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { frozenRunDurationS, isCreditExempt, runDurationS } from "@/lib/credits";
import { resolveRunBackend } from "@/lib/runBackend";
import { estimateForChannel, readCreditAccount, readCreditPrices } from "@/lib/server/credits";
import { readUsageSummary } from "@/lib/server/usage";
import type { Quote, Spendable } from "@/lib/brain/logic";

/**
 * The prices the chat shows are the Run now form's own: the same estimator (estimateForChannel over credit_rates), the same length
 * rule (a queued run is held for its frozen length), read as the person. So the number on a scenario card is the number the form
 * will show and hold — and the form still re-reads it, and refuses with price_changed if it moved (app/api/agent/run).
 */
export async function chatPricing(
  supabase: SupabaseClient,
  channelId: string,
  orgId: string,
): Promise<{ ok: true; spendable: Spendable; quote: Quote } | { ok: false }> {
  const { data: ch, error } = await supabase.from("channels").select("agent_config").eq("channel_id", channelId).maybeSingle();
  if (error || !ch) return { ok: false };
  const prices = await readCreditPrices(supabase);
  if (prices.failed || !prices.supported) return { ok: false };
  const queue = resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: process.env.NIGHTSHIFT_RUN_BACKEND }) === "queue";
  const quote: Quote = async (lengthS) => {
    const durationS = queue ? frozenRunDurationS(lengthS, ch.agent_config) : runDurationS(lengthS, ch.agent_config);
    const read = await estimateForChannel(supabase, channelId, durationS, prices.prices);
    return read.ok ? { ok: true, credits: read.estimate.credits } : { ok: false };
  };
  if (isCreditExempt(orgId)) return { ok: true, spendable: "exempt", quote };
  const [acct, usage] = await Promise.all([
    readCreditAccount(supabase, orgId),
    readUsageSummary(supabase, orgId).catch(() => ({ state: "failed" as const })),
  ]);
  if (acct.failed) return { ok: true, spendable: "unknown", quote };
  const available = acct.account?.available ?? 0;
  // 0094: with extra credits off, what a run can use is less than the balance. A failed usage read is not "extra on": the
  // spendable figure is then unknown, so nothing reads as "fits" on a guess (Lens on 0209).
  if (usage.state !== "ok") return { ok: true, spendable: "unknown", quote };
  const spendable = !usage.value.extraEnabled ? Math.min(available, usage.value.spendableNow) : available;
  return { ok: true, spendable, quote };
}
