import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { logAudit } from "@/lib/server/audit";
import { dispatchDailyVideo, isGithubConfigured } from "@/lib/server/github-secrets";
import { resolveRunBackend } from "@/lib/runBackend";
import { quoteStoryboard, readStoryboard } from "@/lib/server/storyboards";
import { isStoryboardId, mapStoryboardError } from "@/lib/storyboardReview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Approve & render · N credits" — the priced press for a storyboard that is
 * waiting (migration 0057). The only thing on the storyboard screen that
 * spends: it places the render's credit hold and starts the render.
 *
 * POST `{ max_credits }`: the price the person saw on the button. The price is
 * computed here, on the server, from the storyboard's own length (the stored
 * duration_s, never anything the browser sends) exactly as Run now prices a
 * run; a higher price now is `price_changed` (409) and nothing is held. For a
 * paid render the confirmed price is required — no price, no spend.
 *
 * Who may approve: whoever may press Run now on the channel — an admin of its
 * organization (requireOrgRole here; approve_storyboard() checks the same in
 * the database, which is the guarantee). Credits not enforced on this
 * deployment means a customer's render has nobody paying for it, so it is
 * refused, as on the queue.
 *
 * approve_storyboard() does the rest in one transaction: the storyboard must
 * still be waiting (a second press is 409 and holds nothing), the hold goes
 * through reserve_credits() (balance, plan limit, platform floor), and on the
 * queue backend the render job is inserted with the storyboard's topic, its
 * frozen length and resume. On Actions this route then dispatches the
 * workflow; if that fails, storyboard_dispatch_failed() releases the hold and
 * the storyboard waits again — nothing is charged for a render that never left.
 *
 * Publishing is unchanged: the render ends private and goes through the
 * publish gate, auto-publish and approvals exactly like any run.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isStoryboardId(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { max_credits?: unknown } = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as typeof body;
    else return NextResponse.json({ error: "bad_request" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const mc = body.max_credits;
  if (mc != null && !(typeof mc === "number" && Number.isFinite(mc) && mc >= 0))
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const maxCredits = typeof mc === "number" ? mc : null;

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const read = await readStoryboard(supabase, id);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status });
  const sb = read.storyboard;

  const access = await requireOrgRole({ channelId: sb.channelId }, "admin");
  if (!access.ok) {
    const error = access.error === "not_found" ? "not_found" : access.error;
    return NextResponse.json({ error }, { status: access.status });
  }
  if (sb.status !== "ready") return NextResponse.json({ error: "storyboard_not_ready" }, { status: 409 });

  const backend = resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: process.env.NIGHTSHIFT_RUN_BACKEND });
  if (backend === "actions" && !isGithubConfigured)
    return NextResponse.json({ error: "github_not_configured" }, { status: 503 });

  const quote = await quoteStoryboard(supabase, sb, access.source === "org" ? access.orgId : null);
  let amount: number | null = null;
  if (quote.kind === "unavailable") {
    if (quote.reason === "not_enforced") return NextResponse.json({ error: "credits_not_enforced" }, { status: 403 });
    if (quote.reason === "read_failed") return NextResponse.json({ error: "credits_read_failed" }, { status: 503 });
    return NextResponse.json({ error: "credit_estimate_unavailable", gap: quote.reason }, { status: 409 });
  }
  if (quote.kind === "paid") {
    // The press carries the price it showed; without one nothing is spent.
    if (maxCredits === null) return NextResponse.json({ error: "price_required", credits: quote.credits }, { status: 409 });
    if (quote.credits > maxCredits)
      return NextResponse.json({ error: "price_changed", credits: quote.credits }, { status: 409 });
    amount = quote.credits;
  }
  // "included" is only ever the operator's own organization; the database
  // refuses an unpaid approval for any other (price_required).

  const { data, error } = await supabase.rpc("approve_storyboard", {
    p_storyboard: id,
    p_amount: amount,
    p_backend: backend,
  });
  if (error) {
    const mapped = mapStoryboardError(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
  const res = (data ?? {}) as { credit_ref?: string | null; credits_held?: number | null; render_job_id?: number | null };
  const creditRef = typeof res.credit_ref === "string" ? res.credit_ref : null;
  const held = typeof res.credits_held === "number" ? res.credits_held : null;

  if (backend === "actions") {
    try {
      await dispatchDailyVideo(sb.channelId, {
        topic: sb.topic,
        duration: sb.durationS,
        resume: true,
        creditRef: creditRef ?? undefined,
      });
    } catch {
      // Put it back: release the hold this press placed, and let the
      // storyboard wait for another press. If even that fails, the hold
      // expires back to the balance within three hours (0020).
      const undo = await supabase.rpc("storyboard_dispatch_failed", { p_storyboard: id });
      return NextResponse.json(
        { error: "dispatch_failed", released: !undo.error },
        { status: 502 },
      );
    }
  }

  await logAudit({
    action: "storyboard.approve",
    target: id,
    channelId: sb.channelId,
    detail: {
      backend,
      duration_s: sb.durationS,
      scenes: sb.scenes.length,
      ...(res.render_job_id ? { job_id: res.render_job_id } : {}),
      ...(creditRef ? { credit_ref: creditRef, credits_reserved: held } : {}),
    },
  });
  return NextResponse.json({ ok: true, status: "approved", backend, credits_reserved: held, job_id: res.render_job_id ?? null });
}
