import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { isChannelInCurrentOrg } from "@/lib/channels-server";
import { logAudit } from "@/lib/server/audit";
import { isMissingTable, nextStatus, parseDecision, type LearningStatus } from "@/lib/learnings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Approve or reject one proposed learning (migration 0014). Admin only; RLS
 * enforces the same and lets the dashboard write the decision columns only.
 *
 * An approved learning is appended to this channel's topic/script prompts on
 * the next run, so the move is guarded twice: `nextStatus` allows only
 * pending -> approved/rejected and approved -> rejected, and the update is
 * conditioned on the status we read, so two admins deciding at once cannot
 * silently overwrite each other (the loser gets 409).
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireRole("admin"))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = parseDecision(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: row, error: readError } = await supabase
    .from("learnings")
    .select("id,channel_id,kind,status")
    .eq("id", parsed.id)
    .maybeSingle();
  if (readError) {
    const missing = isMissingTable(readError);
    return NextResponse.json({ error: missing ? "migration_missing" : "read_failed" }, { status: missing ? 503 : 500 });
  }
  // Another organization's learning reads as missing: deciding it takes
  // switching to that organization first.
  if (!row || !(await isChannelInCurrentOrg(row.channel_id as string | null)))
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  const from = row.status as LearningStatus;
  const to = nextStatus(from, parsed.decision);
  if (!to) return NextResponse.json({ error: "invalid_transition" }, { status: 409 });

  const { data: updated, error } = await supabase
    .from("learnings")
    .update({ status: to, decided_at: new Date().toISOString(), decided_by: user.id })
    .eq("id", parsed.id)
    .eq("status", from)
    .select("id");
  if (error) return NextResponse.json({ error: "save_failed" }, { status: 500 });
  if (!updated || updated.length === 0) return NextResponse.json({ error: "conflict" }, { status: 409 });

  await logAudit({
    action: `learning.${parsed.decision}`,
    target: parsed.id,
    channelId: row.channel_id ?? undefined,
    detail: { kind: row.kind, from, to },
  });
  return NextResponse.json({ ok: true, status: to });
}
