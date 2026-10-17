import { formatAgo, naWord } from "@/lib/date-format";

/** Formatting helpers. Everything renders "N/A" for null/undefined so the UI
 *  always distinguishes real data from missing data. */

/**
 * Parse a timestamp the bot stored.
 *
 * `event_log` and the state store write `datetime.utcnow().isoformat()` — UTC,
 * but with no `Z` and no offset. JavaScript reads such a bare string as *local*
 * time, so in a UTC+5 browser every timestamp read five hours older than it was:
 * a poll that had just finished showed as "5h ago". The times were never wrong
 * in the database; only the reading of them was, and only away from UTC.
 *
 * A string that already carries a zone (`Z`, `+05:00`) is left exactly as it is,
 * so a value from Postgres `timestamptz` still parses correctly.
 */
export function parseStoredTime(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const text = String(iso).trim();
  // Date-only ("2026-09-05") is already treated as UTC by the spec — appending
  // a Z to it would be redundant, and appending to a zoned value would corrupt it.
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) || !text.includes("T");
  const parsed = new Date(zoned ? text : text + "Z");
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Milliseconds since the epoch for a stored timestamp, or null when unparseable. */
export function storedMs(iso: string | null | undefined): number | null {
  return parseStoredTime(iso)?.getTime() ?? null;
}

export function num(value: number | null | undefined): string {
  return value === null || value === undefined ? "N/A" : value.toLocaleString();
}

export function decimal(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? "N/A" : value.toFixed(digits);
}

/**
 * How long ago a stored timestamp was: "10h ago", "10 ч назад", "10 soat oldin". Pass the viewer's locale
 * (useI18n().locale on the client, getDictionary().locale on the server); without one it reads English, as it
 * always did, so a caller not yet migrated is unchanged. Tables, not Intl: lib/date-format.ts.
 */
export function relativeTime(iso: string | null | undefined, locale?: string): string {
  if (!iso) return naWord(locale);
  const then = storedMs(iso);
  if (then === null) return iso;
  const diff = Date.now() - then;
  const s = Math.max(0, Math.round(diff / 1000));
  const ago = (n: number, unit: "second" | "minute" | "hour" | "day") => formatAgo(n, unit, locale) ?? (formatAgo(n, unit, "en") as string);
  if (s < 60) return ago(s, "second");
  const m = Math.round(s / 60);
  if (m < 60) return ago(m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return ago(h, "hour");
  return ago(Math.round(h / 24), "day");
}

export function timeOfDay(iso: string | null | undefined): string {
  if (!iso) return "--:--:--";
  const d = parseStoredTime(iso);
  if (d === null) return "--:--:--";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function isToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = parseStoredTime(iso);
  if (d === null) return false;
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

/** Human label + tone for an event/agent status string. */
export function statusTone(status: string | null | undefined): "ok" | "run" | "fail" | "idle" {
  switch ((status ?? "").toLowerCase()) {
    case "completed":
    case "success":
      return "ok";
    case "running":
      return "run";
    case "failed":
    case "error":
      return "fail";
    default:
      return "idle";
  }
}
