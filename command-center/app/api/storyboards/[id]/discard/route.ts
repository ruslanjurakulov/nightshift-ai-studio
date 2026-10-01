import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { logAudit } from "@/lib/server/audit";
import { readStoryboard } from "@/lib/server/storyboards";
import { isStoryboardId, mapStoryboardError } from "@/lib/storyboardReview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Discard" — the storyboard is not rendered (migration 0057). Nothing is
 * spent and nothing is held: a waiting storyboard's planning hold was
 * released when its run paused. Same right as approving (the Run now rule);
 * discard_storyboard() checks it again and refuses a storyboard that is no
 * longer waiting (409).
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
  if (sb.status !== "ready") return NextResponse.json({ error: "storyboard_not_ready" }, { status: 409 });

  const { error } = await supabase.rpc("discard_storyboard", { p_storyboard: id });
  if (error) {
    const mapped = mapStoryboardError(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
  await logAudit({ action: "storyboard.discard", target: id, channelId: sb.channelId, detail: { scenes: sb.scenes.length } });
  return NextResponse.json({ ok: true, status: "discarded" });
}
