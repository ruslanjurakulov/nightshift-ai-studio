import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { isCreditExempt, runDurationS } from "@/lib/credits";
import { creditsEnforced, estimateForChannel, readCreditAccount, readCreditPrices } from "@/lib/server/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What a Run now of this channel is estimated to cost, before anyone presses
 * it — the same estimate the run route reserves (lib/server/credits.ts), plus
 * the organization's available balance. Read-only, as the signed-in user: a
 * channel they cannot see is simply not found.
 *
 * `estimate` is null when there is no honest basis, with the gap that names
 * the fix; `supported` is false when migration 0020 is not applied.
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

  const { data: ch, error } = await supabase
    .from("channels")
    .select("org_id,agent_config")
    .eq("channel_id", channelId)
    .maybeSingle();
  if (error || !ch) return NextResponse.json({ supported: false, enforced: creditsEnforced });
  const orgId = typeof ch.org_id === "string" ? ch.org_id : null;

  const { supported, prices } = await readCreditPrices(supabase);
  if (!supported || !orgId) return NextResponse.json({ supported: false, enforced: creditsEnforced });

  const durationS = runDurationS(Number.isFinite(dur) && dur > 0 ? dur : undefined, ch.agent_config);
  const [estimate, acct] = await Promise.all([
    estimateForChannel(supabase, channelId, durationS, prices),
    readCreditAccount(supabase, orgId),
  ]);
  return NextResponse.json({
    supported: true,
    enforced: creditsEnforced,
    exempt: isCreditExempt(orgId),
    estimate,
    available: acct.account?.available ?? null,
  });
}
