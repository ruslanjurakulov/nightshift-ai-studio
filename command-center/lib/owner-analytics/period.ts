/**
 * The owner analytics hub's period: which instants a view covers, and the window it is compared with.
 *
 * Every boundary is a calendar day in Asia/Tashkent, because that is the owner's day: a sale at 23:30 Tashkent on the
 * 31st belongs to that month in the owner's books, even though it is the 31st 18:30 UTC. Tashkent has had no daylight
 * saving since 1992, so the offset is a constant; doing this with Intl and a zone name would give the same answer at
 * many times the cost, and would make the boundaries depend on the server's tz database.
 *
 * A range is half-open, [from, to): the SQL functions compare `>= from and < to`, so two adjacent periods never count
 * the same payment twice. Pure: no server imports, safe in the browser.
 */

export const TASHKENT_OFFSET_MIN = 5 * 60;
export const TIMEZONE = "Asia/Tashkent";

export const PRESETS = ["today", "7d", "30d", "mtd", "qtd", "ytd", "custom"] as const;
export type Preset = (typeof PRESETS)[number];
export const DEFAULT_PRESET: Preset = "30d";

/** The longest custom range we will ask the database for; a decade of daily buckets is a typo, not a question. */
export const MAX_RANGE_DAYS = 3 * 366;

export interface Period {
  preset: Preset;
  /** Tashkent calendar days, inclusive, YYYY-MM-DD. */
  startDay: string;
  endDay: string;
  /** UTC instants, half-open. */
  from: string;
  to: string;
  days: number;
}

export interface PeriodSelection {
  current: Period;
  /** The equal-length window immediately before `current`, or null when comparison is off. */
  previous: Period | null;
  compare: boolean;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isPreset(v: unknown): v is Preset {
  return typeof v === "string" && (PRESETS as readonly string[]).includes(v);
}

/** A Tashkent calendar day as a UTC-midnight-anchored day number (days since epoch). */
function dayNumber(day: string): number | null {
  const m = DAY_RE.exec(day);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  // 2026-02-30 parses to March 2nd in Date.UTC; a day that does not round-trip is not a day.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.floor(t / DAY_MS);
}

function dayString(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** The Tashkent calendar day an instant falls on. */
export function tashkentDay(at: Date): string {
  return new Date(at.getTime() + TASHKENT_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

/** The UTC instant at which a Tashkent calendar day begins. */
export function tashkentDayStartUtc(day: string): string {
  const n = dayNumber(day);
  if (n === null) throw new Error(`not a day: ${day}`);
  return new Date(n * DAY_MS - TASHKENT_OFFSET_MIN * 60_000).toISOString();
}

export function isDay(v: unknown): v is string {
  return typeof v === "string" && dayNumber(v) !== null;
}

function makePeriod(preset: Preset, startN: number, endN: number): Period {
  const startDay = dayString(startN);
  const endDay = dayString(endN);
  return {
    preset,
    startDay,
    endDay,
    from: tashkentDayStartUtc(startDay),
    to: tashkentDayStartUtc(dayString(endN + 1)),
    days: endN - startN + 1,
  };
}

/**
 * The period for a preset, as of `now`. Custom uses `start`/`end`; a custom range that is missing, reversed, in the
 * future or longer than MAX_RANGE_DAYS falls back to the default preset — and says so through `fellBack`, so the page can
 * tell the owner their range was not used rather than quietly showing another one.
 */
export function resolvePeriod(
  preset: Preset,
  now: Date,
  custom?: { start?: string | null; end?: string | null },
): { period: Period; fellBack: boolean } {
  const todayN = dayNumber(tashkentDay(now)) as number;
  const today = new Date(todayN * DAY_MS);
  const y = today.getUTCFullYear();
  const mo = today.getUTCMonth();
  switch (preset) {
    case "today":
      return { period: makePeriod(preset, todayN, todayN), fellBack: false };
    case "7d":
      return { period: makePeriod(preset, todayN - 6, todayN), fellBack: false };
    case "30d":
      return { period: makePeriod(preset, todayN - 29, todayN), fellBack: false };
    case "mtd":
      return { period: makePeriod(preset, Math.floor(Date.UTC(y, mo, 1) / DAY_MS), todayN), fellBack: false };
    case "qtd":
      return { period: makePeriod(preset, Math.floor(Date.UTC(y, mo - (mo % 3), 1) / DAY_MS), todayN), fellBack: false };
    case "ytd":
      return { period: makePeriod(preset, Math.floor(Date.UTC(y, 0, 1) / DAY_MS), todayN), fellBack: false };
    case "custom": {
      const s = custom?.start ? dayNumber(custom.start) : null;
      const e = custom?.end ? dayNumber(custom.end) : null;
      if (s === null || e === null || s > e || e > todayN || e - s + 1 > MAX_RANGE_DAYS) {
        return { period: resolvePeriod(DEFAULT_PRESET, now).period, fellBack: true };
      }
      return { period: makePeriod(preset, s, e), fellBack: false };
    }
  }
}

/**
 * The window a period is compared with: the same number of days, ending the day before it starts. Equal length, not
 * "the previous calendar month": MTD on the 10th against all of last month would show a fall that is only the calendar.
 */
export function previousPeriod(p: Period): Period {
  const s = dayNumber(p.startDay) as number;
  return makePeriod(p.preset, s - p.days, s - 1);
}

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** The selection a URL asks for (`?period=mtd&compare=1`, or `?period=custom&start=…&end=…`). */
export function parseSelection(params: Params, now: Date): PeriodSelection & { fellBack: boolean } {
  const raw = one(params.period);
  const preset = isPreset(raw) ? raw : DEFAULT_PRESET;
  const { period, fellBack } = resolvePeriod(preset, now, { start: one(params.start), end: one(params.end) });
  const compare = one(params.compare) === "1";
  return { current: period, previous: compare ? previousPeriod(period) : null, compare, fellBack };
}

/** The query string for a selection, so links and exports carry exactly the period on screen. */
export function selectionQuery(sel: { current: Period; compare: boolean }): string {
  const q = new URLSearchParams({ period: sel.current.preset });
  if (sel.current.preset === "custom") {
    q.set("start", sel.current.startDay);
    q.set("end", sel.current.endDay);
  }
  if (sel.compare) q.set("compare", "1");
  return q.toString();
}

/**
 * The bucket a chart groups by for a period of this length: days up to ~3 months, then weeks, then months. A year of
 * daily bars is 365 slivers nobody can hover.
 */
export type Bucket = "day" | "week" | "month";
export function bucketFor(days: number): Bucket {
  if (days <= 92) return "day";
  if (days <= 366) return "week";
  return "month";
}

/** Change from `prev` to `cur` as a fraction; null when it cannot be stated (no previous value, or it was 0). */
export function delta(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}
