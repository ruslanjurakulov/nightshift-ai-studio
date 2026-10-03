/**
 * Days and "in 3 days" for display, the same on the server and in every browser.
 *
 * `Intl.DateTimeFormat` and `Intl.RelativeTimeFormat` depend on the runtime's
 * ICU data. Node has the Uzbek (Latin) data, but a stock Chromium build does
 * not: it prints "2026 M10 24" and "+21 d" where Node prints "24-okt, 2026" and
 * "21 kundan keyin". A client component rendered on the server then hydrates
 * with different text (React error #418, the server HTML is thrown away) and
 * the person reads the English-looking fallback. So the three languages the app
 * is written in are formatted here, by table, with the CLDR wording; anything
 * else falls back to Intl. Same idea as lib/number-format.ts. Pure; pinned by
 * tests/date-format.test.ts.
 */

type Lang = "en" | "ru" | "uz";

function lang(locale: string | undefined): Lang | null {
  const base = (locale ?? "en").toLowerCase().split(/[-_]/)[0];
  return base === "en" || base === "ru" || base === "uz" ? base : null;
}

const MONTHS: Record<Lang, readonly string[]> = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  ru: ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."],
  uz: ["yan", "fev", "mar", "apr", "may", "iyn", "iyl", "avg", "sen", "okt", "noy", "dek"],
};

/**
 * A calendar day as "Oct 24, 2026" / "24 окт. 2026 г." / "24-okt, 2026". `timeZone: "UTC"` reads the day in
 * UTC (what a server without the viewer's zone must print); omitted, it is the viewer's own day.
 * Other languages: the runtime's Intl.
 */
export function formatDay(d: Date, locale: string | undefined, timeZone?: "UTC"): string {
  const l = lang(locale);
  if (!l) {
    return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", ...(timeZone ? { timeZone } : {}) }).format(d);
  }
  const utc = timeZone === "UTC";
  const y = utc ? d.getUTCFullYear() : d.getFullYear();
  const m = MONTHS[l][utc ? d.getUTCMonth() : d.getMonth()];
  const day = utc ? d.getUTCDate() : d.getDate();
  if (l === "ru") return `${day} ${m} ${y} г.`;
  if (l === "uz") return `${day}-${m}, ${y}`;
  return `${m} ${day}, ${y}`;
}

type Unit = "minute" | "hour" | "day";

function ruForm(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/** "in 21 days", "tomorrow", "in 3 hours" for a whole number of units ahead; null for another language. */
export function formatAhead(value: number, unit: Unit, locale: string | undefined): string | null {
  const l = lang(locale);
  if (!l || !Number.isInteger(value) || value < 1) return null;
  if (l === "en") {
    if (unit === "day" && value === 1) return "tomorrow";
    return `in ${value} ${unit}${value === 1 ? "" : "s"}`;
  }
  if (l === "ru") {
    if (unit === "day" && value === 1) return "завтра";
    if (unit === "day" && value === 2) return "послезавтра";
    const word =
      unit === "day" ? ruForm(value, "день", "дня", "дней") : unit === "hour" ? ruForm(value, "час", "часа", "часов") : ruForm(value, "минуту", "минуты", "минут");
    return `через ${value} ${word}`;
  }
  if (unit === "day" && value === 1) return "ertaga";
  return `${value} ${unit === "day" ? "kundan" : unit === "hour" ? "soatdan" : "daqiqadan"} keyin`;
}
