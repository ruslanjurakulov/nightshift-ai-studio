import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { isChannelInCurrentOrg } from "@/lib/channels-server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };
const STATUSES = ["queued", "already_queued", "recent"] as const;

/**
 * POST { channel_id }: the person's "Ask for fresh numbers" on the Brain dashboard. It writes ONE request row through
 * S10's research_request_refresh (p_kind 'own_channel') and stops (CLAUDE.md rule 3): the queue worker reads YouTube on
 * its next poll. A press while one is open returns the open request, so a double press is one request. The channel must
 * be one of the workspace the person has open. Nothing is charged or published.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  let body: { channel_id?: unknown };
  try {
    body = await parseJsonCapped(request);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  }
  const channelId = typeof body.channel_id === "string" ? body.channel_id.trim() : "";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(channelId))
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  if (!(await isChannelInCurrentOrg(channelId)))
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_enabled" }, { status: 503, headers: NO_STORE });
  const { data, error } = await supabase.rpc("research_request_refresh", { p_channel: channelId, p_kind: "own_channel" });
  if (error) {
    // S10 (0199): not_found for a channel the person cannot see, forbidden below the editor role, missing = not applied.
    if (error.code === "PGRST202" || error.code === "42883")
      return NextResponse.json({ error: "not_enabled" }, { status: 503, headers: NO_STORE });
    if (error.code === "P0002") return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    if (error.code === "42501") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
    return NextResponse.json({ error: "failed" }, { status: 502, headers: NO_STORE });
  }
  const out = (data ?? {}) as { ok?: unknown; status?: unknown; error?: unknown; next_at?: unknown };
  if (out.ok === false) {
    // A draft channel (rule 7) has nothing to read yet: the remedy is connecting it, not waiting for tomorrow.
    if (out.error === "not_connected") return NextResponse.json({ error: "not_connected" }, { status: 409, headers: NO_STORE });
    return NextResponse.json({ error: out.error === "daily_limit" ? "daily_limit" : "failed" }, { status: 429, headers: NO_STORE });
  }
  const status = (STATUSES as readonly unknown[]).includes(out.status) ? (out.status as (typeof STATUSES)[number]) : null;
  if (!status) return NextResponse.json({ error: "failed" }, { status: 502, headers: NO_STORE });
  // "recent" names when a new refresh is allowed (S10); passed on only when it is a real timestamp.
  const nextAt = status === "recent" && typeof out.next_at === "string" && !Number.isNaN(Date.parse(out.next_at)) ? out.next_at : null;
  return NextResponse.json(nextAt ? { status, next_at: nextAt } : { status }, { headers: NO_STORE });
});

