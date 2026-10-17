/**
 * The owner's clock: 24 hours, Tashkent time, the same text on the server and in every browser.
 *
 * Why not toLocaleString: it follows the runtime's ICU data and the viewer's zone, so the server (UTC, en-US) printed
 * "11:19 PM" and a phone in Tashkent printed "23:19" (React #418, the page is rebuilt on the client), and "today"
 * reset at 05:00 local because the day was the UTC day. Here the zone is a fixed offset: Asia/Tashkent is UTC+5 all year
 * (Uzbekistan has no daylight saving time since 1991), so no Intl call is needed and nothing depends on the runtime.
 *
 * Text: "bugun 13:53" / "kecha 22:10" / "12 okt 13:53" (uz); "сегодня 13:53" / "вчера 22:10" / "12 окт. 13:53" (ru);
 * "today 13:53" / "yesterday 22:10" / "12 Oct 13:53" (en). No UTC, no AM/PM. Pure; pinned by tests/owner-time.test.ts.
 */

/** Asia/Tashkent: UTC+5, no daylight saving. */
export const OWNER_TIME_ZONE = "Asia/Tashkent";
const OWNER_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Lang = "en" | "ru" | "uz";

function lang(locale: string | undefined): Lang {
  const base = (locale ?? "en").toLowerCase().split(/[-_]/)[0];
  return base === "ru" || base === "uz" ? base : "en";
}

const MONTHS: Record<Lang, readonly string[]> = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  ru: ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."],
  uz: ["yan", "fev", "mar", "apr", "may", "iyn", "iyl", "avg", "sen", "okt", "noy", "dek"],
};
const DAY_WORDS: Record<Lang, { today: string; yesterday: string }> = {
  en: { today: "today", yesterday: "yesterday" },
  ru: { today: "сегодня", yesterday: "вчера" },
  uz: { today: "bugun", yesterday: "kecha" },
};

const two = (n: number) => String(n).padStart(2, "0");

/** The calendar fields of an instant on the owner's wall clock. */
export function ownerParts(ms: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const d = new Date(ms + OWNER_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}

/** Whole days since 1970-01-01 on the owner's calendar: two instants are the same owner day when these match. */
export function ownerDayNumber(ms: number): number {
  return Math.floor((ms + OWNER_OFFSET_MS) / DAY_MS);
}

/** True when `ms` falls on the owner's calendar day of `nowMs`. */
export function isOwnerToday(ms: number, nowMs: number): boolean {
  return ownerDayNumber(ms) === ownerDayNumber(nowMs);
}

/** The instant (ms) the owner's current day began: midnight in Tashkent. */
export function ownerDayStartMs(nowMs: number): number {
  return ownerDayNumber(nowMs) * DAY_MS - OWNER_OFFSET_MS;
}

/** "13:53", or "13:53:41" with seconds. */
export function ownerClock(ms: number, withSeconds = false): string {
  const p = ownerParts(ms);
  return `${two(p.hour)}:${two(p.minute)}${withSeconds ? `:${two(p.second)}` : ""}`;
}

/** "12 okt" / "12 окт." / "12 Oct", with the year when it is not this year's. */
export function ownerDate(ms: number, locale: string | undefined, nowMs: number): string {
  const l = lang(locale);
  const p = ownerParts(ms);
  const year = p.year === ownerParts(nowMs).year ? "" : ` ${p.year}`;
  return `${p.day} ${MONTHS[l][p.month]}${year}`;
}

/** "bugun 13:53" / "kecha 22:10" / "12 okt 13:53" for an instant, relative to `nowMs`. */
export function formatOwnerTime(ms: number, locale: string | undefined, nowMs: number, withSeconds = false): string {
  const l = lang(locale);
  const clock = ownerClock(ms, withSeconds);
  const diff = ownerDayNumber(nowMs) - ownerDayNumber(ms);
  if (diff === 0) return `${DAY_WORDS[l].today} ${clock}`;
  if (diff === 1) return `${DAY_WORDS[l].yesterday} ${clock}`;
  return `${ownerDate(ms, locale, nowMs)} ${clock}`;
}

/** "17 okt 2026" / "17 окт. 2026" / "17 Oct 2026": a full date on the owner's calendar (a confirm sheet's "Date" line). */
export function ownerDateFull(ms: number, locale: string | undefined): string {
  const p = ownerParts(ms);
  return `${p.day} ${MONTHS[lang(locale)][p.month]} ${p.year}`;
}
