/**
 * lib/date-format.ts: days and "in 3 days" by table for en / ru / uz, so the server (full ICU) and a browser
 * with less ICU data print the same text. The expected strings are what Node's full ICU prints, so a table
 * entry that drifts from CLDR is caught here, and a language the runtime has no data for is not read from it.
 */
import { describe, expect, it } from "vitest";
import { formatAhead, formatDay } from "@/lib/date-format";

const D = (m: number, day = 5) => new Date(Date.UTC(2026, m, day, 12));

describe("formatDay", () => {
  it("matches Node's ICU for every month in en, ru and uz", () => {
    for (const locale of ["en", "ru", "uz"]) {
      for (let m = 0; m < 12; m++) {
        const expected = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(D(m));
        expect(formatDay(D(m), locale, "UTC")).toBe(expected);
      }
    }
  });
  it("uses the UTC day when asked, whatever the machine's zone", () => {
    expect(formatDay(new Date("2026-10-24T22:30:00Z"), "uz", "UTC")).toBe("24-okt, 2026");
    expect(formatDay(new Date("2026-10-24T22:30:00Z"), "ru", "UTC")).toBe("24 окт. 2026 г.");
  });
  it("takes a regional tag by its language and leaves other languages to Intl", () => {
    expect(formatDay(D(9, 24), "uz-Latn", "UTC")).toBe("24-okt, 2026");
    expect(formatDay(D(9, 24), "de", "UTC")).toBe(new Intl.DateTimeFormat("de", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(D(9, 24)));
  });
});

describe("formatAhead", () => {
  const units = ["minute", "hour", "day"] as const;
  it("matches Node's ICU (numeric auto) for the counts a renewal can show", () => {
    for (const locale of ["en", "ru", "uz"]) {
      for (const unit of units) {
        for (const n of [1, 2, 3, 4, 5, 11, 12, 14, 20, 21, 22, 25, 30, 59, 101, 111]) {
          const expected = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(n, unit);
          expect(formatAhead(n, unit, locale), `${locale} ${n} ${unit}`).toBe(expected);
        }
      }
    }
  });
  it("is null for a language it does not know and for a count that is not a positive whole number", () => {
    expect(formatAhead(3, "day", "de")).toBeNull();
    expect(formatAhead(0, "day", "en")).toBeNull();
    expect(formatAhead(1.5, "day", "en")).toBeNull();
  });
});
