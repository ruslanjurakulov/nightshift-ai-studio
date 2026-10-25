import { NextResponse } from "next/server";
import { getUser, createClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { getChannelContext } from "@/lib/channels-server";
import { fetchTokenStatuses } from "@/lib/server/channel-tokens";
import { youtubeAccounts } from "@/lib/connectedAccounts";
import { resultsDashboardEnabled } from "@/lib/resultsDashboard/flag";
import { DEFAULT_RANGE, parseRange } from "@/lib/resultsDashboard/aggregate";
import { CHANNEL_ID_RE } from "@/lib/publish";
import { loadResults, type OwnChannel } from "@/lib/server/results-dashboard";
import type { ResultsError } from "@/lib/resultsDashboard/payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const fail = (error: ResultsError, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/**
 * The results dashboard's one read (NIGHTSHIFT_RESULTS_DASHBOARD, default off: 404 before anything else is asked).
 *
 * GET `?channel=<channel id>&range=<7 | 28 | 90>`; no `channel` means all channels (a channel whose id is literally "all" is just a channel). Read-only and free: it never publishes, never spends credits and
 * never calls a platform; it reads what the daily analytics poll and the publish worker already stored, under the
 * signed-in member's own session (RLS), and only inside the organization being viewed. A channel that belongs to another
 * organization answers exactly like one that does not exist (404 `not_found`), so the route teaches nobody anything about
 * another tenant's channel ids. A read that fails is `failed`, never an empty dashboard.
 */
export async function GET(request: Request) {
  if (!resultsDashboardEnabled()) return fail("not_found", 404);
  const user = await getUser();
  if (!user) return fail("unauthorized", 401);

  const params = new URL(request.url).searchParams;
  const channelParam = params.get("channel");
  const rangeParam = params.get("range");
  const days = rangeParam === null ? DEFAULT_RANGE : parseRange(rangeParam);
  if (days === null || (channelParam !== null && !CHANNEL_ID_RE.test(channelParam))) return fail("invalid_params", 400);

  const supabase = await createClient();
  if (!supabase) return fail("not_configured", 503);
  const org = await getOrgContext();
  // Before the organizations migration there is no "this organization's rows" to narrow to; failing closed beats guessing.
  if (!org.supported) return fail("not_available", 503);
  if (!org.current) return fail("org_required", 400);

  let channels: OwnChannel[];
  try {
    const ctx = await getChannelContext();
    const tokens = await fetchTokenStatuses();
    const accounts = youtubeAccounts(ctx.channels, ctx.credentials, tokens.available ? tokens.rows : null);
    channels = ctx.channels.map((c) => {
      const account = accounts.find((a) => a.id === c.channel_id);
      return { id: c.channel_id, name: account?.name ?? c.name ?? c.channel_id, connected: account?.connected === true, orgId: c.org_id ?? null };
    });
  } catch {
    return fail("failed", 502);
  }

  try {
    const out = await loadResults({ supabase, orgId: org.current.id, channels, selected: channelParam, days, nowMs: Date.now() });
    if (!out.ok) return fail(out.error, out.error === "not_found" ? 404 : 502);
    return NextResponse.json(out.payload, { headers: NO_STORE });
  } catch {
    return fail("failed", 502);
  }
}
