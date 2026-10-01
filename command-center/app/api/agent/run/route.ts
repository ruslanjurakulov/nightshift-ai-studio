import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { isOperator, isPlatformAdmin, requireOrgRole } from "@/lib/auth/org-roles";
import { getOrgContext } from "@/lib/orgs-server";
import { logAudit } from "@/lib/server/audit";
import { dispatchDailyVideo, isGithubConfigured } from "@/lib/server/github-secrets";
import { isSupabaseConfigured } from "@/lib/config";
import { buildRenderJobInsert, isRunConfigured, resolveRunBackend } from "@/lib/runBackend";
import { creditsEnforced, reserveRunCredits, runCreditRefFor } from "@/lib/server/credits";
import { IDEMPOTENCY_KEY_RE } from "@/lib/creative/operations";
import { isCreditExempt } from "@/lib/credits";
import { readConnectedAccounts } from "@/lib/connectedAccounts";
import { acceptedHint } from "@/lib/publish";

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
 *
 * Who may run (lib/auth/org-roles.ts): an owner/admin of the ORGANIZATION that
 * owns the channel — the same rule reserve_credits() applies — so a customer
 * organization's admin can run their own channel. The platform's owner/admin
 * keep that role in every organization, as RLS already gives them. With
 * credits NOT enforced, a run outside the operator's own organization would
 * spend the operator's providers for free, so on Actions it stays a
 * platform-admin action until the deployment switches credits on — and on the
 * queue it is refused for everyone: since migration 0041 the database and the
 * worker refuse a customer organization's job without its credit hold, so the
 * route says why instead of failing the insert.
 *
 * A queued paid run carries the length its hold was priced for
 * (params.duration, lib/credits.ts frozenRunDurationS) — never "the channel's
 * target", which the worker would read again at run time.
 *
 * Optional, for the Assistant's confirmed plan: `idempotency_key` makes the
 * hold's reference stable for (user, channel, key) — a replayed step is
 * refused by reserve_credits() as `run_already_started` (409) and nothing
 * new is held or dispatched — and `max_credits` is the price the person
 * confirmed: a higher estimate is `price_changed` (409), nothing held. Both
 * act on the credit hold, so they apply where credits are enforced; without
 * them the route behaves exactly as before.
 */

export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Which backend runs the operator's pipeline is for someone who can run
  // something here: a member of the organization being viewed, or the
  // operator — not any account that signed up.
  const org = await getOrgContext();
  if (!org.current && !(await isOperator())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const backend = resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: process.env.NIGHTSHIFT_RUN_BACKEND });
  return NextResponse.json({
    configured: isRunConfigured(backend, { github: isGithubConfigured, supabase: isSupabaseConfigured }),
    backend,
  });
}

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    channel_id?: unknown;
    topic?: unknown;
    niche?: unknown;
    duration?: unknown;
    language?: unknown;
    visual_style?: unknown;
    video_provider?: unknown;
    image_provider?: unknown;
    tts_model?: unknown;
    voice_id?: unknown;
    publish_hint?: unknown;
    idempotency_key?: unknown;
    max_credits?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const channelId = typeof body.channel_id === "string" ? body.channel_id.trim() : "";
  if (!channelId) return NextResponse.json({ error: "channel_required" }, { status: 400 });
  const idemKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (body.idempotency_key != null && !IDEMPOTENCY_KEY_RE.test(idemKey))
    return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  const mc = body.max_credits;
  if (mc != null && !(typeof mc === "number" && Number.isFinite(mc) && mc >= 0))
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const maxCredits = typeof mc === "number" ? mc : null;
  // Spending money to produce a video is an owner/admin action — in the
  // channel's organization. Only a channel of the organization being viewed:
  // the Actions dispatch has no database check of its own, and a platform
  // admin's RLS reaches every tenant, so running another organization's
  // channel takes switching to it (404, not 403, so ids do not leak).
  const access = await requireOrgRole({ channelId }, "admin");
  if (!access.ok) {
    const error = access.error === "not_found" ? "channel_not_found" : access.error;
    return NextResponse.json({ error }, { status: access.status });
  }
  // A customer organization's run is paid for with its credits. Without
  // enforcement nothing would pay, so only the operator may start one.
  const backend = resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: process.env.NIGHTSHIFT_RUN_BACKEND });
  const customerRun = access.source === "org" && !isCreditExempt(access.orgId);
  if (!creditsEnforced && customerRun && (backend === "queue" || !(await isPlatformAdmin())))
    return NextResponse.json({ error: "credits_not_enforced" }, { status: 403 });

  if (backend === "actions" && !isGithubConfigured)
    return NextResponse.json({ error: "github_not_configured" }, { status: 503 });

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
  const ttsModel = typeof body.tts_model === "string" ? body.tts_model.trim() : "";
  const voiceId = typeof body.voice_id === "string" ? body.voice_id.trim() : "";

  // "Making this for:" — optional, and kept only when it names one of this
  // organization's own connected accounts (read with the caller's RLS).
  const publishHint =
    body.publish_hint == null || body.publish_hint === ""
      ? null
      : acceptedHint(body.publish_hint, await readConnectedAccounts().catch(() => []));
  if (body.publish_hint != null && body.publish_hint !== "" && !publishHint)
    return NextResponse.json({ error: "publish_hint_unknown" }, { status: 400 });

  const opts = {
    topic,
    niche,
    duration,
    language,
    visualStyle,
    videoProvider,
    imageProvider,
    ttsModel,
    voiceId,
    ...(publishHint ? { publishHint } : {}),
  };

  // Pay first (enforced deployments only), then run. The hold's id travels
  // with the run so its runner can settle exactly this hold.
  let creditRef: string | null = null;
  let creditsHeld: number | null = null;
  let frozenDurationS: number | null = null;
  if (creditsEnforced) {
    const supabase = await createClient();
    if (!supabase) return NextResponse.json({ error: "credits_unavailable" }, { status: 503 });
    const prefix = backend === "queue" ? "rj" : "gh";
    const credit = await reserveRunCredits(supabase, channelId, duration, prefix, {
      maxCredits,
      creditRef: idemKey ? runCreditRefFor(prefix, user.id, channelId, idemKey) : null,
    });
    if (!credit.ok) return NextResponse.json(credit.body, { status: credit.status });
    creditRef = credit.creditRef;
    creditsHeld = creditRef ? credit.estimate?.credits ?? null : null;
    frozenDurationS = creditRef ? credit.durationS : null;
  }
  const heldNote = creditRef ? { credits_held: creditsHeld } : {};

  if (backend === "queue") {
    const supabase = await createClient();
    if (!supabase) return NextResponse.json({ error: "queue_unavailable", ...heldNote }, { status: 503 });
    // The job runs the length its hold was priced for, and nothing else.
    const runOpts = frozenDurationS !== null ? { ...opts, duration: frozenDurationS } : opts;
    const row = buildRenderJobInsert(channelId, runOpts, user.id, creditRef);
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
    if (ttsModel) detail.tts_model = ttsModel;
    if (voiceId) detail.voice_id = voiceId;
    if (publishHint) detail.publish_hint = publishHint;
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
