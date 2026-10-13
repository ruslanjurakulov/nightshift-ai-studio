/**
 * What the editor can honestly say about an export — the pure half.
 *
 * Client-safe and unit-tested (tests/editor-export-status.test.ts). It reads
 * ONLY what an export row already carries to the page: its status, when it was
 * asked for and when it finished. The worker reports no progress and no
 * estimate, so none is invented here: a running export shows how long it has
 * been going and says the time left is unknown.
 */
import type { EditorExport, ExportReason } from "@/lib/editor";

/** Poll waits in ms: the first checks are quick, a quiet export is asked less and less often. */
export const POLL_DELAYS_MS = [4000, 6000, 9000, 13000, 20000] as const;

/** The wait before poll number `step` (0-based); the last wait repeats. */
export function pollDelay(step: number): number {
  const i = Math.max(0, Math.min(POLL_DELAYS_MS.length - 1, Math.floor(step) || 0));
  return POLL_DELAYS_MS[i];
}

/** A change in any export's status or file is what resets the poll back to quick. */
export function exportSignature(exports: readonly EditorExport[]): string {
  return exports.map((e) => `${e.id}:${e.status}:${e.assetId ?? ""}`).join("|");
}

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** Whole seconds from the request to `endMs` (never negative); null when the request time is unknown. */
export function elapsedSeconds(createdAt: string | null, endMs: number): number | null {
  const start = ms(createdAt);
  if (start === null) return null;
  return Math.max(0, Math.floor((endMs - start) / 1000));
}

/** How long a finished export took, request to finish; null when either time is missing. */
export function tookSeconds(x: Pick<EditorExport, "createdAt" | "finishedAt">): number | null {
  const end = ms(x.finishedAt);
  return end === null ? null : elapsedSeconds(x.createdAt, end);
}

/** 7 → "0:07", 723 → "12:03", 3723 → "1:02:03". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

/**
 * Failures where the same request would fail the same way (the edit itself or
 * a file is the problem). A retry there only spends one of the day's free
 * exports, so the panel asks for a change first instead of offering it.
 */
const NOT_RETRYABLE: readonly (ExportReason | "other")[] = [
  "invalid_timeline",
  "asset_unavailable",
  "too_long",
  "project_deleted",
];

export function canRetry(reason: EditorExport["reason"]): boolean {
  return !NOT_RETRYABLE.includes(reason ?? "other");
}
