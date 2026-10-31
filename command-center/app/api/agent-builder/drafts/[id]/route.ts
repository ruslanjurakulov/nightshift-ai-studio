import "server-only";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}
/**
 * Read one authenticated owner's draft and version history. RLS is authoritative;
 * cross-user IDs are indistinguishable from missing IDs.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NIGHTSHIFT_AGENT_DRAFTS_ENABLED !== "true")
    return json({ error: "agent_drafts_disabled" }, 503);
  const { id } = await params;
  if (!UUID.test(id)) return json({ error: "invalid_id" }, 400);
  const db = await createClient();
  if (!db) return json({ error: "unauthorized" }, 401);
  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) return json({ error: "unauthorized" }, 401);
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
