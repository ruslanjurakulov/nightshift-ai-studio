import { storedMs } from "@/lib/format";

/**
 * Worker status (migration 0045): what each background worker reports about
 * itself — read by the operator's Integrations page (`worker_status`, platform
 * owner/admin only through RLS).
 *
 * A heartbeat older than STALE_AFTER_S means the worker is NOT REPORTING; that
 * is never shown as running or ok. A failed read is not "no workers": the page
 * shows the error state (CLAUDE.md #5).
 */

export type WorkerKind = "media" | "creative" | "pipeline" | "other";
export type WorkerState = "starting" | "running" | "failed" | "stopped";
/** What the page shows: a reported state, or "not reporting" for a silent one. */
export type WorkerShown = WorkerState | "notReporting";

export const WORKER_KINDS: readonly WorkerKind[] = ["media", "creative", "pipeline", "other"];
const STATES: readonly WorkerState[] = ["starting", "running", "failed", "stopped"];

export const WORKER_COLUMNS = "worker_id, kind, state, detail, version, started_at, updated_at";

/** The database's own threshold (media_pipeline_state): no heartbeat for longer than this is silence. */
export const STALE_AFTER_S = 120;

export interface WorkerRow {
  workerId: string;
  kind: WorkerKind;
  state: WorkerState;
  detail: string | null;
  version: string | null;
  startedAt: string | null;
  updatedAt: string | null;
}

export interface WorkerView extends WorkerRow {
  shown: WorkerShown;
  /** Seconds since the last report; null when the timestamp is unreadable. */
  ageSeconds: number | null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** Rows as the database returned them, minus any that are not a worker row. */
export function coerceWorkers(data: unknown): WorkerRow[] {
  if (!Array.isArray(data)) return [];
  const out: WorkerRow[] = [];
  for (const r of data) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const workerId = text(o.worker_id);
    const kind = WORKER_KINDS.find((k) => k === o.kind);
    const state = STATES.find((s) => s === o.state);
    if (!workerId || !kind || !state) continue;
    out.push({
      workerId,
      kind,
      state,
      detail: text(o.detail),
      version: text(o.version),
      startedAt: text(o.started_at),
      updatedAt: text(o.updated_at),
    });
  }
  return out;
}

/**
 * A worker that says it is running or starting is believed only while its
 * heartbeat is fresh; with an old or unreadable one it is "not reporting".
 * A reported failure or clean stop stays what it said, with its age.
 */
export function workerView(row: WorkerRow, nowMs: number): WorkerView {
  const at = storedMs(row.updatedAt);
  const ageSeconds = at === null ? null : Math.max(0, Math.round((nowMs - at) / 1000));
  const silent = ageSeconds === null || ageSeconds > STALE_AFTER_S;
  const shown: WorkerShown = (row.state === "running" || row.state === "starting") && silent ? "notReporting" : row.state;
  return { ...row, shown, ageSeconds };
}

/** Media first (it is what customers wait on), then by kind, then by id. */
export function sortWorkers(views: WorkerView[]): WorkerView[] {
  const rank = (k: WorkerKind) => WORKER_KINDS.indexOf(k);
  return [...views].sort((a, b) => rank(a.kind) - rank(b.kind) || a.workerId.localeCompare(b.workerId));
}

/** The table does not exist: migration 0045 has not been applied. */
export function isMissingWorkerTable(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(error && /does not exist|42P01|PGRST205/i.test(`${error.code ?? ""} ${error.message ?? ""}`));
}
