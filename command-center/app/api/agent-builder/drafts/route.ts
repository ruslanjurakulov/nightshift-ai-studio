import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { importWorkflowDraft } from "@/lib/agent-draft";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { readJsonBodyCapped } from "@/lib/server/json-body";

export const runtime = "nodejs";
const ENABLED = process.env.NIGHTSHIFT_AGENT_DRAFTS_ENABLED === "true";
const headers = { "Cache-Control": "no-store" };

async function session() {
  const db = await createClient();
  if (!db) return null;
  const { data: { user }, error } = await db.auth.getUser();
  return !error && user ? db : null;
}
function response(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers });
}

/** List ONLY the signed-in author's own draft metadata via owner-id RLS. */
export async function GET() {
  if (!ENABLED) return response({ error: "agent_drafts_disabled" }, 503);
  const db = await session();
  if (!db) return response({ error: "unauthorized" }, 401);
  const { data, error } = await db.from("agent_workflow_drafts")
    .select("id,name,current_version,created_at,updated_at")
    .order("updated_at", { ascending: false }).limit(50);
  if (error) return response({ error: "drafts_unavailable" }, 503);
  return response({ drafts: data ?? [] }, 200);
}

/** Saves a validated client-side plan atomically; never runs a model. */
export const POST = requireSameOrigin(async function POST(req: NextRequest) {
  if (!ENABLED) return response({ error: "agent_drafts_disabled" }, 503);
  const db = await session();
  if (!db) return response({ error: "unauthorized" }, 401);
  const parsed = await readJsonBodyCapped(req, 180_000);
  if (!parsed.ok) return response({ error: parsed.reason === "too_large" ? "payload_too_large" : "invalid_json" }, parsed.reason === "too_large" ? 413 : 400);
  const payload: unknown = parsed.value;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return response({ error: "invalid_request" }, 400);
  const request = payload as Record<string, unknown>;
  if (request.id !== null && request.id !== undefined &&
      (typeof request.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.id)))
    return response({ error: "invalid_draft_id" }, 400);
  if (request.expectedVersion !== null && request.expectedVersion !== undefined &&
      (typeof request.expectedVersion !== "number" || !Number.isInteger(request.expectedVersion) || request.expectedVersion < 0 || request.expectedVersion > 30))
    return response({ error: "invalid_expected_version" }, 400);
  let document;
  try {
    if (request.document === undefined) return response({ error: "invalid_agent_draft" }, 400);
    document = importWorkflowDraft(JSON.stringify(request.document));
  } catch {
    return response({ error: "invalid_agent_draft" }, 400);
  }
  const { data, error } = await db.rpc("save_agent_workflow_draft", {
    p_draft_id: request.id ?? null,
    p_expected_version: request.expectedVersion ?? null,
    p_document: document,
  });
  if (error) {
    if (error.message === "version_conflict" || error.code === "40001")
      return response({ error: "version_conflict" }, 409);
    if (error.message === "draft_not_found") return response({ error: "not_found" }, 404);
    if (error.message === "agent_draft_limit" || error.message === "draft_version_limit")
      return response({ error: "draft_limit_reached" }, 409);
    return response({ error: "drafts_unavailable" }, 503);
  }
  const saved = Array.isArray(data) ? data[0] : null;
  if (!saved || typeof saved.saved_id !== "string")
    return response({ error: "invalid_save_response" }, 502);
  return response({ id: saved.saved_id, version: saved.saved_version }, 200);
});
