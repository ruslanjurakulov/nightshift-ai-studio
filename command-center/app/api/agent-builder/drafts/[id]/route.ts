import "server-only";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOperator } from "@/lib/auth/org-roles";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { DRAFT_ID, agentDraftsEnabled, draftRpcFailure } from "@/lib/server/agent-drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
type Params = { params: Promise<{ id: string }> };
function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}
/** The switch is off: the same 404 as a route that does not exist, before the drafts or the database are touched. */
const disabled = () => json({ error: "not_found" }, 404);
/** Operators only until launch, asked before the switch and everything else (the list route says why). */
async function operatorRefusal() {
  const access = await requireOperator();
  return access.ok ? null : json({ error: access.error }, access.status);
}

async function session() {
  const db = await createClient();
  if (!db) return null;
  const { data: { user }, error } = await db.auth.getUser();
  return !error && user ? db : null;
}

/**
 * Read one authenticated owner's draft and one of its kept versions. RLS is authoritative;
 * cross-user IDs are indistinguishable from missing IDs, and so is a version the database pruned.
 */
export async function GET(request: Request, { params }: Params) {
  const refused = await operatorRefusal();
  if (refused) return refused;
  if (!agentDraftsEnabled()) return disabled();
  const { id } = await params;
  if (!DRAFT_ID.test(id)) return json({ error: "invalid_id" }, 400);
  const db = await session();
  if (!db) return json({ error: "unauthorized" }, 401);
  const { data: draft, error: draftError } = await db.from("agent_workflow_drafts")
    .select("id,name,current_version,created_at,updated_at")
    .eq("id", id).maybeSingle();
  if (draftError) return json({ error: "drafts_unavailable" }, 503);
  if (!draft) return json({ error: "not_found" }, 404);

  const requested = new URL(request.url).searchParams.get("version");
  const version = requested === null ? draft.current_version : Number(requested);
  if (!Number.isInteger(version) || version < 1 || version > draft.current_version)
    return json({ error: "invalid_version" }, 400);
  const { data: revision, error: revisionError } = await db
    .from("agent_workflow_draft_versions").select("version,document,created_at")
    .eq("draft_id", id).eq("version", version).maybeSingle();
  if (revisionError) return json({ error: "drafts_unavailable" }, 503);
  if (!revision) return json({ error: "not_found" }, 404);
  return json({ draft, revision }, 200);
}

/** The owner deletes one plan and every version of it (delete_agent_workflow_draft, 0130). Another person's id is not_found. */
export const DELETE = requireSameOrigin(async function DELETE(_request: Request, { params }: Params) {
  const refused = await operatorRefusal();
  if (refused) return refused;
  if (!agentDraftsEnabled()) return disabled();
  const { id } = await params;
  if (!DRAFT_ID.test(id)) return json({ error: "invalid_id" }, 400);
  const db = await session();
  if (!db) return json({ error: "unauthorized" }, 401);
  const { error } = await db.rpc("delete_agent_workflow_draft", { p_draft_id: id });
  if (error) {
    const failure = draftRpcFailure(error);
    return json({ error: failure.error }, failure.status);
  }
  return json({ deleted: id }, 200);
});
