/** Number formatting for the owner analytics hub. Pure. A null is never formatted: the caller says "unknown" in words. */

const LOCALE_TAG: Record<string, string> = { en: "en-US", ru: "ru-RU", uz: "uz-Latn-UZ" };
const tag = (locale: string) => LOCALE_TAG[locale] ?? "en-US";

export function usd(n: number, locale: string, compact = false): string {
  return new Intl.NumberFormat(tag(locale), {
    style: "currency",
    currency: "USD",
    notation: compact && Math.abs(n) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: compact && Math.abs(n) >= 10_000 ? 1 : 2,
    minimumFractionDigits: compact ? 0 : 2,
  }).format(n);
}

export function int(n: number, locale: string): string {
  return new Intl.NumberFormat(tag(locale), { maximumFractionDigits: 0 }).format(n);
}

export function num(n: number, locale: string, digits = 1): string {
  return new Intl.NumberFormat(tag(locale), { maximumFractionDigits: digits }).format(n);
}

export function pct(n: number, locale: string, signed = false): string {
  return new Intl.NumberFormat(tag(locale), {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: signed ? "exceptZero" : "auto",
  }).format(n);
}

/** "{a} {b}" templating for the dictionary's placeholders. */
export function fill(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** A Tashkent wall-clock date and time for a table row. */
export function tashkentDateTime(iso: string): string {
  return new Date(Date.parse(iso) + 5 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}
