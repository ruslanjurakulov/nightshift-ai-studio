/**
 * E-mail preferences (migration 0103): the pure half.
 *
 * The database holds one row per person: whether "your video is ready" e-mails are
 * on (they are, until the person says no), how often the weekly summary comes
 * (never, until the person asks), and the language code the mails are written in.
 * The browser reads and writes them only through email_prefs_get / email_prefs_set;
 * the unsubscribe token never reaches it.
 *
 * Languages here are codes, not a list of three: the app tells the database the
 * language the person last used and the mail renderer picks a template by code,
 * English when it has none. Nothing in this file branches on a particular language.
 */

/** The values email_prefs_set takes for the weekly summary: 0 = off, else days between summaries. */
export const WEEKLY_CHOICES = [0, 7, 14] as const;
export type WeeklyChoice = (typeof WEEKLY_CHOICES)[number];

export interface EmailPrefs {
  /** "Your video is ready" e-mails. */
  ready: boolean;
  /** Days between weekly summaries; null = the summary is off. */
  weeklyEveryDays: 7 | 14 | null;
  /** The language code the mails are written in. */
  locale: string;
  /** False when the person has never saved a choice: these are the defaults. */
  stored: boolean;
}

/** What email_prefs_get answered, as prefs this build can show, or null when it answered something else. */
export function parseEmailPrefs(raw: unknown): EmailPrefs | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.ready !== "boolean") return null;
  const w = o.weekly_every_days;
  if (w !== null && w !== 7 && w !== 14) return null;
  return {
    ready: o.ready,
    weeklyEveryDays: w,
    locale: typeof o.locale === "string" && /^[a-z]{2,3}$/.test(o.locale) ? o.locale : "en",
    stored: o.stored === true,
  };
}

/** The select's value for the weekly summary: "0", "7" or "14". */
export function weeklyValue(p: Pick<EmailPrefs, "weeklyEveryDays">): string {
  return String(p.weeklyEveryDays ?? 0);
}

/** A select value back to the number email_prefs_set takes; null for anything else (nothing is sent). */
export function weeklyFromValue(v: string): WeeklyChoice | null {
  // Number("") is 0: an empty value must never read as "switch the summary off".
  if (!/^\d{1,2}$/.test(v)) return null;
  const n = Number(v);
  return (WEEKLY_CHOICES as readonly number[]).includes(n) ? (n as WeeklyChoice) : null;
}

/** Remembered per browser: the language last told to the database, so the bell does not repeat the call every visit. */
export const LOCALE_SYNC_KEY = "ns_email_locale";

export function localeSyncNeeded(last: string | null, current: string): boolean {
  return /^[a-z]{2,3}$/.test(current) && last !== current;
}

/** The three unsubscribe scopes the public link and route accept. */
export const UNSUBSCRIBE_SCOPES = ["ready", "weekly", "all"] as const;
export type UnsubscribeScope = (typeof UNSUBSCRIBE_SCOPES)[number];

export function isUnsubscribeScope(v: unknown): v is UnsubscribeScope {
  return typeof v === "string" && (UNSUBSCRIBE_SCOPES as readonly string[]).includes(v);
}

/** The token as the e-mails carry it: 64 lowercase hex characters. Anything else is refused before the database is asked. */
export function isUnsubscribeToken(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}
