/**
 * Text for the dashboard's figures. Pure, locale-aware through lib/number-format.ts (the same text on the server and in every
 * browser, no Intl), and never a number for an unknown: a null is the caller's "not measured" word, not "0" or "-".
 */
import { formatNumber } from "@/lib/number-format";
import { parseStoredTime } from "@/lib/format";

/** A whole count, grouped for the locale. */
export function formatCount(n: number, locale: string): string {
  return formatNumber(Math.round(n), locale, 0);
}

/** Hours with one decimal when under 100 (3.5), whole above: "watch time" is a rough size, not a ledger. */
export function formatHours(hours: number, locale: string): string {
  return formatNumber(hours, locale, hours < 100 ? 1 : 0);
}

/** m:ss for a duration in seconds ("2:05"), h:mm:ss from an hour up. A negative or non-finite value has no text. */
export function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The UTC calendar day of a stored timestamp (YYYY-MM-DD), or null when it cannot be read. UTC, like the readings. */
export function dayOf(iso: string | null | undefined): string | null {
  const d = parseStoredTime(iso);
  return d ? d.toISOString().slice(0, 10) : null;
}

/** A share of the largest value as a whole percent, at least 2 so a small real bar stays visible, at most 100. */
export function barPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value <= 0) return 0;
  return Math.min(100, Math.max(2, Math.round((value / max) * 100)));
}
