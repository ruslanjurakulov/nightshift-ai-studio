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

  let body: {
    channel_id?: unknown;
    topic?: unknown;
    niche?: unknown;
    duration?: unknown;
    language?: unknown;
    visual_style?: unknown;
    video_provider?: unknown;
    image_provider?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const channelId = typeof body.channel_id === "string" ? body.channel_id.trim() : "";
  if (!channelId) return NextResponse.json({ error: "channel_required" }, { status: 400 });

  // Optional per-run overrides. Empty/absent means "the AI picks / the channel's
  // own setting applies", exactly as before.
  const topic = typeof body.topic === "string" ? body.topic.trim().slice(0, 300) : "";
  const niche = typeof body.niche === "string" ? body.niche.trim().slice(0, 120) : "";
  const language = typeof body.language === "string" ? body.language.trim().slice(0, 40) : "";
  const visualStyle =
    typeof body.visual_style === "string" ? body.visual_style.trim().slice(0, 300) : "";
  // Duration in seconds. Accept a number or a numeric string; clamp to a sane
  // range (30s … 60min) so a stray value never asks the pipeline for an absurd
  // length. 0/NaN/absent means "use the channel's own target".
  const durationRaw =
    typeof body.duration === "number"
      ? body.duration
      : typeof body.duration === "string"
        ? Number(body.duration)
        : NaN;
  const duration =
    Number.isFinite(durationRaw) && durationRaw > 0
      ? Math.min(3600, Math.max(30, Math.round(durationRaw)))
      : undefined;
  // Per-run model routing (validated again in dispatchDailyVideo against the
  // workflow's choice lists; a bad value is simply dropped).
  const videoProvider = typeof body.video_provider === "string" ? body.video_provider.trim() : "";
  const imageProvider = typeof body.image_provider === "string" ? body.image_provider.trim() : "";

  try {
    await dispatchDailyVideo(channelId, {
      topic,
      niche,
      duration,
      language,
      visualStyle,
      videoProvider,
      imageProvider,
    });
    // Audit the on-demand run against its channel (best-effort, never throws).
    // Record only the non-default controls the operator actually set.
    const detail: Record<string, unknown> = {};
    if (topic) detail.topic = topic;
    if (duration) detail.duration = duration;
    if (language) detail.language = language;
    if (visualStyle) detail.visual_style = visualStyle;
    if (videoProvider) detail.video_provider = videoProvider;
    if (imageProvider) detail.image_provider = imageProvider;
    await logAudit({
      action: "agent.run",
      channelId,
      detail: Object.keys(detail).length ? detail : undefined,
    });
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
