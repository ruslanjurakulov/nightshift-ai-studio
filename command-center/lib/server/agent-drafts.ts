import "server-only";

/**
 * Agent Builder private drafts (migration 0130, docs/product/AGENT_NODE_BUILDER.md): the web half's switch and how a refusal of the
 * two database functions is answered.
 *
 * Operators only until launch, in three places that agree: the page (guardOperatorPage), every route (requireOperator, asked FIRST,
 * so a customer gets the same 403 whatever the switch says and cannot learn its state), and the database (migration 0234: both draft
 * functions raise operator_only unless is_platform_admin(), so a direct PostgREST call with the browser key is refused too).
 *
 * NIGHTSHIFT_AGENT_DRAFTS_ENABLED — a server env var, default OFF. On for `on`, `1`, `true` or `yes` (any case, surrounding spaces
 * ignored), like the repository's other release switches (lib/server/release-flags.ts). Read on every request, never at import. Off:
 * an operator gets the public 404 before the session's drafts or the database are touched. The switch and the role are two locks,
 * and neither opens the routes alone.
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
  // 0234: the database says this session is not a platform operator (the route asked requireOperator first, so this is a role
  // revoked between the two reads, or a lookup that disagreed): the same 403 the route gives, never a 503 outage.
  if (message === "operator_only") return { status: 403, error: "forbidden" };
  return { status: 503, error: "drafts_unavailable" };
}

export const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
