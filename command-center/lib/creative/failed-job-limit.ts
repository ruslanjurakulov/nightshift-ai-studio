import type { Dictionary } from "@/lib/i18n";
import { fmt } from "@/lib/i18n/core";

/**
 * 0175: an organization whose creative jobs failed or were refused 5 times in the last 24 hours starts no new one until the window
 * frees. The database's detail is exactly `failed=<n> limit=<l> retry_at=<YYYY-MM-DDTHH:MM:SSZ>` (creative_failed_job_gate):
 * retry_at is when the count drops below the limit, in UTC.
 */
const DETAIL_RE = /^failed=(\d{1,9}) limit=(\d{1,9}) retry_at=(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):(\d{2})Z$/;

export interface FailedJobLimit {
  failed: number;
  limit: number;
  /** The ISO instant the window frees, as the database wrote it (UTC). */
  retryAt: string;
  /** Its date and hh:mm in UTC, as written: shown with "UTC" after it, so the server and the browser render the same words. */
  date: string;
  time: string;
}

/** The database's detail, read; null when it is not exactly that shape (then nothing about the count is known). */
export function parseFailedJobLimit(detail: unknown): FailedJobLimit | null {
  if (typeof detail !== "string") return null;
  const m = DETAIL_RE.exec(detail.trim());
  if (!m) return null;
  return { failed: Number(m[1]), limit: Number(m[2]), retryAt: `${m[3]}T${m[4]}:${m[5]}Z`, date: m[3], time: m[4] };
}

/**
 * The sentence the person reads: how many failed, the limit, when it frees, and what to do. Without a readable detail it says
 * none of the numbers (CLAUDE.md rule 5: an unknown count is never shown as 0, or as anything else).
 */
export function failedJobLimitText(t: Dictionary, detail: unknown): string {
  const p = parseFailedJobLimit(detail);
  const words = t.creative.failedJobLimit;
  return p ? fmt(words.counted, { n: p.failed, limit: p.limit, date: p.date, time: p.time }) : words.unknown;
}
