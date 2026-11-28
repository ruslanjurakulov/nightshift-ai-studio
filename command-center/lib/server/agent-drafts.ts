import "server-only";

/**
 * Agent Builder private drafts (migration 0130, docs/product/AGENT_NODE_BUILDER.md): the web half's switch and how a refusal of the
 * two database functions is answered.
 *
 * NIGHTSHIFT_AGENT_DRAFTS_ENABLED — a server env var, default OFF. On for `on`, `1`, `true` or `yes` (any case, surrounding spaces
 * ignored), like the repository's other release switches (lib/server/release-flags.ts). Read on every request, never at import. Off:
 * every /api/agent-builder/drafts route answers the public 404 before it reads the session or touches the database.
 * On, the routes still serve only a platform operator (requireOperator) until launch, like the /agent-builder page: the switch and
 * the role are two locks, and neither opens the routes alone.
 *
 * This hides the doors only. Once 0130 is applied, a signed-in user can call save_agent_workflow_draft() and
 * delete_agent_workflow_draft() through PostgREST with the browser key whatever this says, within the database's own limits.
 */
export const AGENT_DRAFTS_FLAG = "NIGHTSHIFT_AGENT_DRAFTS_ENABLED";

export function agentDraftsEnabled(raw: string | undefined = process.env.NIGHTSHIFT_AGENT_DRAFTS_ENABLED): boolean {
  return ["on", "1", "true", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}

export type DraftRpcError = { code?: string | null; message?: string | null };

/**
 * A refusal of save_/delete_agent_workflow_draft() as the route answers it. The function's own refusals are the caller's fault (4xx);
 * only something else (the function or table missing, the database down) is a 503.
 */
export function draftRpcFailure(error: DraftRpcError): { status: number; error: string } {
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (code === "40001" || message === "version_conflict") return { status: 409, error: "version_conflict" };
  if (code === "P0002" || message === "draft_not_found") return { status: 404, error: "not_found" };
  if (message === "agent_draft_limit") return { status: 409, error: "draft_limit_reached" };
  if (message === "agent_draft_too_large") return { status: 413, error: "payload_too_large" };
  if (code === "22023") return { status: 400, error: "invalid_agent_draft" };
  if (message === "not_authenticated") return { status: 401, error: "unauthorized" };
  return { status: 503, error: "drafts_unavailable" };
}

export const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
