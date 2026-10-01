import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { logAudit } from "@/lib/server/audit";
import { readStoryboard } from "@/lib/server/storyboards";
import { isStoryboardId, mapStoryboardError } from "@/lib/storyboardReview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Re-open" — an approved storyboard whose render did not finish goes back to
 * waiting, so it can be edited and approved again (migration 0058). Spends
 * nothing and starts nothing.
 *
 * reopen_storyboard() decides, under the storyboard's row lock: refused while
 * a render of that approval may still start or be running, while its credit
 * hold has not gone back to the balance, or once a render finished
 * (409 render_in_progress / hold_not_released / render_unverifiable /
 * render_finished). A released hold never starts again, so the old approval
 * can never render — approving again places a new hold. Same right as
 * approving (the Run now rule).
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isStoryboardId(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const read = await readStoryboard(supabase, id);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status });
  const sb = read.storyboard;

  const access = await requireOrgRole({ channelId: sb.channelId }, "admin");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  if (sb.status !== "approved") return NextResponse.json({ error: "storyboard_not_ready" }, { status: 409 });

  const { error } = await supabase.rpc("reopen_storyboard", { p_storyboard: id });
  if (error) {
    const mapped = mapStoryboardError(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
  await logAudit({ action: "storyboard.reopen", target: id, channelId: sb.channelId, detail: { scenes: sb.scenes.length } });
  return NextResponse.json({ ok: true, status: "ready" });
}
