import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { logAudit } from "@/lib/server/audit";
import { dispatchDailyVideo, isGithubConfigured } from "@/lib/server/github-secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Run now" — start this channel's pipeline on demand.
 *
 * GET reports whether on-demand runs are wired at all (the same GitHub
 * forwarding token/repo the Providers board uses), so the button can explain
 * what to configure instead of failing on click.
 *
 * POST takes `{ channel_id }` and dispatches the daily-video workflow for that
 * channel. It spends money and can produce a video, so it is gated on an
 * authenticated user and never runs "all channels" implicitly — a real channel
 * id is required. It does not publish by itself: the dispatch pins privacy to
 * private and the channel's own auto-publish + publish gate still decide the
 * rest, exactly as on a scheduled run.
 */

export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ configured: isGithubConfigured });
}

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Spending money to produce a video is an owner/admin action.
  if (!(await requireRole("admin"))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isGithubConfigured)
    return NextResponse.json({ error: "github_not_configured" }, { status: 503 });

  let body: { channel_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const channelId = typeof body.channel_id === "string" ? body.channel_id.trim() : "";
  if (!channelId) return NextResponse.json({ error: "channel_required" }, { status: 400 });

  try {
    await dispatchDailyVideo(channelId);
    // Audit the on-demand run against its channel (best-effort, never throws).
    await logAudit({ action: "agent.run", channelId });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "github_dispatch_failed";
    const status =
      reason === "github_unauthorized"
        ? 403
        : reason === "github_workflow_not_found"
          ? 404
          : reason === "github_not_configured"
            ? 503
            : 502;
    return NextResponse.json({ error: reason }, { status });
  }
}
