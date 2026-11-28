import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOperator } from "@/lib/auth/org-roles";
import { importWorkflowDraft } from "@/lib/agent-draft";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { readJsonBodyCapped } from "@/lib/server/json-body";
import { DRAFT_ID, agentDraftsEnabled, draftRpcFailure } from "@/lib/server/agent-drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
/** The draft itself is capped at 150 KB (lib/agent-draft.ts, migration 0130); the envelope adds an id and a version. */
const BODY_LIMIT = 180_000;

async function session() {
  const db = await createClient();
  if (!db) return null;
  const { data: { user }, error } = await db.auth.getUser();
  return !error && user ? db : null;
}
function response(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers });
}
/** The switch is off: the same 404 as a route that does not exist, before the drafts or the database are touched. */
const disabled = () => response({ error: "not_found" }, 404);
/**
 * Operators only until launch, like the /agent-builder page (and the database, migration 0234). Asked FIRST, before the switch:
 * asked after it, a customer told 404 from 403 and so learned whether the switch was on (Breach, PR #960). Now every non-operator
 * gets requireOperator's own answer (401 signed out, 403 a customer) whatever the switch, ids or bodies say. The switch is still a
 * second lock: an operator gets the 404 while it is off.
 */
async function operatorRefusal() {
  const access = await requireOperator();
  return access.ok ? null : response({ error: access.error }, access.status);
}

/** List ONLY the signed-in author's own draft metadata via owner-id RLS. */
export async function GET() {
  const refused = await operatorRefusal();
  if (refused) return refused;
  if (!agentDraftsEnabled()) return disabled();
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
  const refused = await operatorRefusal();
  if (refused) return refused;
  if (!agentDraftsEnabled()) return disabled();
  const db = await session();
  if (!db) return response({ error: "unauthorized" }, 401);
  const parsed = await readJsonBodyCapped(req, BODY_LIMIT);
  if (!parsed.ok) return response({ error: parsed.reason === "too_large" ? "payload_too_large" : "invalid_json" }, parsed.reason === "too_large" ? 413 : 400);
  const payload: unknown = parsed.value;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return response({ error: "invalid_request" }, 400);
  const request = payload as Record<string, unknown>;
  if (request.id !== null && request.id !== undefined && (typeof request.id !== "string" || !DRAFT_ID.test(request.id)))
    return response({ error: "invalid_draft_id" }, 400);
  // Versions keep counting after the oldest are pruned (the database keeps the newest 30), so only the integer range is checked here.
  if (request.expectedVersion !== null && request.expectedVersion !== undefined &&
      (typeof request.expectedVersion !== "number" || !Number.isInteger(request.expectedVersion) ||
       request.expectedVersion < 0 || request.expectedVersion > 2_147_483_647))
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
    const failure = draftRpcFailure(error);
    return response({ error: failure.error }, failure.status);
  }
  const saved = Array.isArray(data) ? data[0] : null;
  if (!saved || typeof saved.saved_id !== "string")
    return response({ error: "invalid_save_response" }, 502);
  return response({ id: saved.saved_id, version: saved.saved_version }, 200);
});
