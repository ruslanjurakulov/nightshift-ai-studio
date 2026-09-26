import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { logAudit } from "@/lib/server/audit";
import { dispatchDailyVideo, isGithubConfigured } from "@/lib/server/github-secrets";
import { isSupabaseConfigured } from "@/lib/config";
import { buildRenderJobInsert, isRunConfigured, resolveRunBackend } from "@/lib/runBackend";
import { creditsEnforced, reserveRunCredits } from "@/lib/server/credits";
import { isChannelInCurrentOrg } from "@/lib/channels-server";

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
 *
 * Backend (server env NIGHTSHIFT_RUN_BACKEND, lib/runBackend.ts): "actions"
 * (default) dispatches the workflow as above; "queue" instead inserts one
 * `render_jobs` row (migration 0017) that the VPS worker picks up and runs with
 * the same command the workflow would (docs/WORKER_VPS.md). The insert goes
 * through the signed-in user's RLS-checked client — this app never holds the
 * service key — and 0017's insert policy accepts only what this route sends:
 * a 'daily' job, no privacy (so private), no resume or repair, filed as the
 * caller. Neither backend asks for more than the other.
 *
 * Credits (server env NIGHTSHIFT_CREDITS_ENFORCE, migration 0020): when on, a
 * run for a channel outside the operator's own organization first reserves its
 * estimated cost through reserve_credits() — as the signed-in user, never the
 * service key — and only then dispatches or queues, carrying the hold's id
 * (`credit_ref`). Not enough credits is a 402 that says how many are needed.
 * The runner settles the hold when the run ends (tools/queue_worker.py,
 * tools/credits_settle.py). If the dispatch or insert fails after the hold was
 * taken, the browser cannot release it (release is service-only); it expires
 * back to the balance within three hours, and the response says so.
 */

export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const backend = resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: process.env.NIGHTSHIFT_RUN_BACKEND });
  return NextResponse.json({
    configured: isRunConfigured(backend, { github: isGithubConfigured, supabase: isSupabaseConfigured }),
    backend,
  });
}

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Spending money to produce a video is an owner/admin action.
  if (!(await requireRole("admin"))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const backend = resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: process.env.NIGHTSHIFT_RUN_BACKEND });
  if (backend === "actions" && !isGithubConfigured)
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
  // Only a channel of the organization being viewed. The Actions dispatch has
  // no database check of its own, and a platform admin's RLS reaches every
  // tenant: running another organization's channel takes switching to it.
  if (!(await isChannelInCurrentOrg(channelId)))
    return NextResponse.json({ error: "channel_not_found" }, { status: 404 });

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

  const opts = { topic, niche, duration, language, visualStyle, videoProvider, imageProvider };

  // Pay first (enforced deployments only), then run. The hold's id travels
  // with the run so its runner can settle exactly this hold.
  let creditRef: string | null = null;
  let creditsHeld: number | null = null;
  if (creditsEnforced) {
    const supabase = await createClient();
    if (!supabase) return NextResponse.json({ error: "credits_unavailable" }, { status: 503 });
    const credit = await reserveRunCredits(supabase, channelId, duration, backend === "queue" ? "rj" : "gh");
    if (!credit.ok) return NextResponse.json(credit.body, { status: credit.status });
    creditRef = credit.creditRef;
    creditsHeld = creditRef ? credit.estimate?.credits ?? null : null;
  }
  const heldNote = creditRef ? { credits_held: creditsHeld } : {};

  if (backend === "queue") {
    const supabase = await createClient();
    if (!supabase) return NextResponse.json({ error: "queue_unavailable", ...heldNote }, { status: 503 });
    const row = buildRenderJobInsert(channelId, opts, user.id, creditRef);
    const { data, error } = await supabase.from("render_jobs").insert(row).select("id").single();
    if (error || !data) {
      // A missing table is "0017 not applied yet" — say so, never claim it queued.
      const missing = error?.code === "42P01" || /PGRST205|does not exist/i.test(error?.message ?? "");
      return NextResponse.json(
        { error: missing ? "queue_unavailable" : "queue_insert_failed", ...heldNote },
        { status: missing ? 503 : 502 },
      );
    }
    await logAudit({
      action: "agent.run",
      channelId,
      detail: {
        backend: "queue",
        job_id: data.id,
        ...row.params,
        ...(creditRef ? { credit_ref: creditRef, credits_reserved: creditsHeld } : {}),
      },
    });
    return NextResponse.json({ ok: true, backend: "queue", job_id: data.id, credits_reserved: creditsHeld });
  }

  try {
    await dispatchDailyVideo(channelId, { ...opts, creditRef: creditRef ?? undefined });
    // Audit the on-demand run against its channel (best-effort, never throws).
    // Record only the non-default controls the operator actually set.
    const detail: Record<string, unknown> = { backend: "actions" };
    if (topic) detail.topic = topic;
    if (duration) detail.duration = duration;
    if (language) detail.language = language;
    if (visualStyle) detail.visual_style = visualStyle;
    if (videoProvider) detail.video_provider = videoProvider;
    if (imageProvider) detail.image_provider = imageProvider;
    if (creditRef) {
      detail.credit_ref = creditRef;
      detail.credits_reserved = creditsHeld;
    }
    await logAudit({
      action: "agent.run",
      channelId,
      detail,
    });
    return NextResponse.json({ ok: true, backend: "actions", credits_reserved: creditsHeld });
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
    return NextResponse.json({ error: reason, ...heldNote }, { status });
  }
}
