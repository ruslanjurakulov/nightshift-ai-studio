import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { frozenRunDurationS, isCreditExempt, runDurationS } from "@/lib/credits";
import { resolveRunBackend } from "@/lib/runBackend";
import { creditsEnforced, estimateForChannel, readCreditAccount, readCreditPrices } from "@/lib/server/credits";
import { readUsageSummary } from "@/lib/server/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A read behind the estimate errored: unknown, retryable — never "not enabled" or a gap. */
const readFailed = () => NextResponse.json({ error: "credits_read_failed" }, { status: 503 });

/**
 * What a Run now of this channel is estimated to cost, before anyone presses
 * it — the same estimate the run route reserves (lib/server/credits.ts), plus
 * the organization's available balance. Read-only, as the signed-in user: a
 * channel they cannot see is simply not found — and so is a channel of any
 * organization other than the one being viewed (lib/auth/org-roles.ts), which
 * RLS alone would let a platform admin read. Any role in that organization
 * may read its balance, as 0020's RLS already allows.
 *
 * `estimate` is null when there is no honest basis, with the gap that names
 * the fix; `supported` is false when migration 0020 is not applied.
 *
 * "Could not read" is a third thing, never one of those (CLAUDE.md #5): a
 * failed channel, price-list or ledger read is a retryable 503
 * `credits_read_failed` — not `supported: false` (which hides the line), not
 * an estimate with a "price gap". A failed balance read keeps the estimate
 * and says `balanceFailed: true` with `available: null` (unknown); an
 * organization with no account row really has 0 available.
 */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ supported: false, enforced: creditsEnforced });

  const url = new URL(request.url);
  const channelId = (url.searchParams.get("channel") ?? "").trim();
  if (!channelId) return NextResponse.json({ error: "channel_required" }, { status: 400 });
  const dur = Number(url.searchParams.get("duration") ?? "");
  const access = await requireOrgRole({ channelId }, "viewer");
  if (!access.ok) {
    const error = access.error === "not_found" ? "channel_not_found" : access.error;
    return NextResponse.json({ error }, { status: access.status });
  }

  const { data: ch, error } = await supabase
    .from("channels")
    .select("org_id,agent_config")
    .eq("channel_id", channelId)
    .maybeSingle();
  if (error) return readFailed();
  if (!ch) return NextResponse.json({ supported: false, enforced: creditsEnforced });
  const orgId = typeof ch.org_id === "string" ? ch.org_id : null;

  const { supported, failed, prices } = await readCreditPrices(supabase);
  if (failed) return readFailed();
  if (!supported || !orgId) return NextResponse.json({ supported: false, enforced: creditsEnforced });

  // The same length the run route reserves for: on the queue, the frozen one.
  const requested = Number.isFinite(dur) && dur > 0 ? dur : undefined;
  const queue = resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: process.env.NIGHTSHIFT_RUN_BACKEND }) === "queue";
  const durationS = queue ? frozenRunDurationS(requested, ch.agent_config) : runDurationS(requested, ch.agent_config);
  const [read, acct, usage] = await Promise.all([
    estimateForChannel(supabase, channelId, durationS, prices),
    readCreditAccount(supabase, orgId),
    // 0094: with extra credits off, what this run can actually use is less than the balance.
    // A failed or missing read says nothing (the balance is shown as before), never "on".
    readUsageSummary(supabase, orgId).catch(() => ({ state: "failed" as const })),
  ]);
  if (!read.ok) return readFailed();
  const estimate = read.estimate;
  return NextResponse.json({
    supported: true,
    enforced: creditsEnforced,
    exempt: isCreditExempt(orgId),
    estimate,
    available: acct.account?.available ?? null,
    balanceFailed: acct.failed,
    ...(usage.state === "ok" && !usage.value.extraEnabled ? { extraOff: true, spendable: usage.value.spendableNow } : {}),
  });
}
