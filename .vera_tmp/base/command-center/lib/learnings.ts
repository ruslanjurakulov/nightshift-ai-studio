/**
 * Learning memory (migration 0014, modules/learning_memory.py).
 *
 * The pipeline proposes a learning — one sentence plus the evidence that
 * produced it — as a `pending` row. An admin approves or rejects it here, and
 * only `approved` rows are fed forward into the topic/script prompts. Pure
 * helpers only: shared by the Learning page, the decide route and the tests.
 */

export type LearningStatus = "pending" | "approved" | "rejected";
export type LearningDecision = "approve" | "reject";

export const LEARNING_KINDS = ["topic", "retention", "hook", "experiment"] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

export interface LearningRow {
  id: string;
  channel_id: string;
  kind: string;
  observation: string;
  evidence: Record<string, unknown> | null;
  /** 0..1 sample-size weight, or null when it was not computed — never 0 for "unknown". */
  confidence: number | null;
  status: LearningStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate a decide request body. Returns the decision or an error code. */
export function parseDecision(
  body: unknown,
): { ok: true; id: string; decision: LearningDecision } | { ok: false; error: "bad_id" | "bad_decision" } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id.trim() : "";
  if (!UUID.test(id)) return { ok: false, error: "bad_id" };
  if (b.decision !== "approve" && b.decision !== "reject") return { ok: false, error: "bad_decision" };
  return { ok: true, id, decision: b.decision };
}

/**
 * The status a decision moves a learning to, or null when the move is not
 * allowed. Approving is only for a pending proposal. Rejecting also withdraws
 * an approved one — an approved learning shapes every future prompt, so there
 * must be a way to take it back. Nothing ever returns to pending, and a
 * rejected learning stays rejected (the pipeline will not re-propose its key).
 */
export function nextStatus(current: LearningStatus, decision: LearningDecision): LearningStatus | null {
  if (decision === "approve") return current === "pending" ? "approved" : null;
  return current === "pending" || current === "approved" ? "rejected" : null;
}

/** Group rows by status, keeping each group in the order given. */
export function splitLearnings(rows: LearningRow[]): Record<LearningStatus, LearningRow[]> {
  const out: Record<LearningStatus, LearningRow[]> = { pending: [], approved: [], rejected: [] };
  for (const r of rows) {
    if (r.status === "pending" || r.status === "approved" || r.status === "rejected") out[r.status].push(r);
  }
  return out;
}

/** Confidence as a whole percent, or null when unknown (never shown as 0%). */
export function confidencePct(c: number | null | undefined): number | null {
  if (c === null || c === undefined || !Number.isFinite(c)) return null;
  return Math.round(Math.min(1, Math.max(0, c)) * 100);
}

/**
 * The evidence as short `key: value` lines for display. Scalars only, in the
 * order the pipeline wrote them; nested lists/objects are summarised by size so
 * a long per-video list does not swamp the row. null stays "null" — unknown is
 * shown as unknown.
 */
export function evidenceLines(evidence: Record<string, unknown> | null | undefined, max = 8): string[] {
  if (!evidence || typeof evidence !== "object") return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(evidence)) {
    if (lines.length >= max) break;
    let shown: string;
    if (value === null || value === undefined) shown = "null";
    else if (Array.isArray(value)) shown = `[${value.length}]`;
    else if (typeof value === "object") shown = `{${Object.keys(value as object).length}}`;
    else if (typeof value === "number") shown = String(Number(value.toFixed(4)));
    else shown = String(value);
    lines.push(`${key}: ${shown}`);
  }
  return lines;
}

/**
 * Whether a Supabase error means "migration 0014 not applied yet". Postgres
 * reports 42P01; newer PostgREST answers PGRST205 from its schema cache before
 * the query reaches Postgres. Either is a setup state, not a failure.
 */
export function isMissingTable(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /does not exist|could not find the table/i.test(error.message ?? "");
}
