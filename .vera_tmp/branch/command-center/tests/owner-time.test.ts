import { describe, expect, it } from "vitest";
import { formatOwnerTime, isOwnerToday, ownerClock, ownerDateFull, ownerDayStartMs, ownerParts } from "../lib/owner-time";
import { isOwnerToday as isOwnerTodayIso, isToday, num, ownerStamp, ownerTime, ownerTimeOfDay, relativeTime, timeOfDay } from "../lib/format";

/** 2026-10-17 08:53 UTC is 13:53 in Tashkent (UTC+5, no daylight saving). */
const NOW = Date.UTC(2026, 9, 17, 8, 53, 0);
const at = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);

describe("the owner's clock is Tashkent, 24 hours", () => {
  it("shifts UTC by +5 hours, all year (no daylight saving)", () => {
    expect(ownerClock(at(2026, 1, 15, 12, 0))).toBe("17:00");
    expect(ownerClock(at(2026, 7, 15, 12, 0))).toBe("17:00");
    expect(ownerClock(at(2026, 3, 29, 0, 30))).toBe("05:30");
    expect(ownerClock(at(2026, 10, 25, 0, 30))).toBe("05:30");
    expect(ownerClock(at(2026, 10, 17, 8, 53, 41), true)).toBe("13:53:41");
  });
  it("never prints AM, PM or UTC", () => {
    for (const locale of ["uz", "ru", "en"]) {
      for (const h of [0, 3, 11, 12, 13, 18, 23]) {
        const text = formatOwnerTime(at(2026, 10, 17, h, 7), locale, NOW);
        expect(text).not.toMatch(/AM|PM|UTC/i);
      }
    }
  });
});

describe("today / yesterday / date, per language", () => {
  it("uz", () => {
    expect(formatOwnerTime(NOW, "uz", NOW)).toBe("bugun 13:53");
    expect(formatOwnerTime(at(2026, 10, 16, 17, 10), "uz", NOW)).toBe("kecha 22:10");
    expect(formatOwnerTime(at(2026, 10, 12, 8, 53), "uz", NOW)).toBe("12 okt 13:53");
    expect(formatOwnerTime(at(2025, 10, 12, 8, 53), "uz", NOW)).toBe("12 okt 2025 13:53");
  });
  it("ru", () => {
    expect(formatOwnerTime(NOW, "ru", NOW)).toBe("сегодня 13:53");
    expect(formatOwnerTime(at(2026, 10, 16, 17, 10), "ru", NOW)).toBe("вчера 22:10");
    expect(formatOwnerTime(at(2026, 10, 12, 8, 53), "ru", NOW)).toBe("12 окт. 13:53");
  });
  it("en (and an unknown locale reads English)", () => {
    expect(formatOwnerTime(NOW, "en", NOW)).toBe("today 13:53");
    expect(formatOwnerTime(at(2026, 10, 16, 17, 10), "en", NOW)).toBe("yesterday 22:10");
    expect(formatOwnerTime(at(2026, 10, 12, 8, 53), "en", NOW)).toBe("12 Oct 13:53");
    expect(formatOwnerTime(NOW, "de", NOW)).toBe("today 13:53");
  });
  it("a timestamp in the future (clock skew) is a date, never 'today' or 'yesterday'", () => {
    expect(formatOwnerTime(at(2026, 10, 19, 8, 53), "uz", NOW)).toBe("19 okt 13:53");
  });
  it("a full date for a confirm sheet", () => {
    expect(ownerDateFull(NOW, "uz")).toBe("17 okt 2026");
    expect(ownerDateFull(NOW, "ru")).toBe("17 окт. 2026");
    expect(ownerDateFull(NOW, "en")).toBe("17 Oct 2026");
  });
});

describe("'today' changes at midnight in Tashkent, not in UTC", () => {
  // 2026-10-17 00:00 in Tashkent is 2026-10-16 19:00 UTC.
  const midnight = at(2026, 10, 16, 19, 0, 0);
  it("one second before and at the owner's midnight", () => {
    const now = at(2026, 10, 17, 8, 0);
    expect(isOwnerToday(midnight - 1000, now)).toBe(false);
    expect(isOwnerToday(midnight, now)).toBe(true);
    expect(isOwnerToday(midnight + 24 * 3600 * 1000 - 1000, now)).toBe(true);
    expect(isOwnerToday(midnight + 24 * 3600 * 1000, now)).toBe(false);
  });
  it("22:00 UTC is already tomorrow for the owner (03:00 local)", () => {
    const now = at(2026, 10, 16, 22, 0);
    expect(ownerParts(now).day).toBe(17);
    expect(isOwnerToday(at(2026, 10, 17, 1, 0), now)).toBe(true);
    expect(isOwnerToday(at(2026, 10, 16, 10, 0), now)).toBe(false);
  });
  it("the owner's day starts at 19:00 UTC the evening before", () => {
    expect(ownerDayStartMs(NOW)).toBe(midnight);
    expect(ownerDayStartMs(at(2026, 10, 16, 22, 0))).toBe(midnight);
  });
  it("lib/format isOwnerToday follows it (a stored bare UTC timestamp too)", () => {
    expect(isOwnerTodayIso("2026-10-16T19:30:00", NOW)).toBe(true);
    expect(isOwnerTodayIso("2026-10-16T18:30:00", NOW)).toBe(false);
    expect(isOwnerTodayIso(null, NOW)).toBe(false);
  });
  it("customer pages keep the UTC-day isToday and the locale timeOfDay (they are not hard-coded to Tashkent)", () => {
    const real = Date;
    const now = new Date();
    const sameUtcDay = new real(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 1)).toISOString();
    const yesterday = new real(now.getTime() - 36 * 3600 * 1000).toISOString();
    expect(isToday(sameUtcDay)).toBe(true);
    expect(isToday(yesterday)).toBe(false);
    expect(timeOfDay("2026-10-17T18:19:41Z")).toBe(new Date("2026-10-17T18:19:41Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  });
});

describe("lib/format is deterministic", () => {
  it("ownerTimeOfDay is 24h Tashkent whatever the runtime zone", () => {
    expect(ownerTimeOfDay("2026-10-17T18:19:41Z")).toBe("23:19:41");
    expect(ownerTimeOfDay("2026-10-17T18:19:41")).toBe("23:19:41");
    expect(ownerTimeOfDay(null)).toBe("--:--:--");
    expect(ownerTimeOfDay("nonsense")).toBe("--:--:--");
  });
  it("ownerStamp: seconds today, the full date with the year on any other day", () => {
    expect(ownerStamp("2026-10-17T08:53:41Z", "uz", NOW)).toBe("bugun 13:53:41");
    expect(ownerStamp("2026-10-10T08:53:41Z", "uz", NOW)).toBe("10 okt 2026 13:53:41");
    expect(ownerStamp("2025-10-10T08:53:41Z", "en", NOW)).toBe("10 Oct 2025 13:53:41");
    expect(ownerStamp("2026-10-10T08:53:41Z", "ru", NOW)).toBe("10 окт. 2026 13:53:41");
  });
  it("ownerTime reads a stored timestamp", () => {
    expect(ownerTime("2026-10-16T17:10:00", "uz", NOW)).toBe("kecha 22:10");
    expect(ownerTime(null, "uz", NOW)).not.toMatch(/\d/);
  });
  it("relativeTime takes the clock it is given (a server-rendered client component passes the server's)", () => {
    const stamp = new Date(NOW - 30_000).toISOString();
    expect(relativeTime(stamp, "en", NOW)).toBe("30s ago");
    expect(relativeTime(stamp, "en", NOW + 60_000)).toBe("2m ago");
  });
  it("num groups the same everywhere", () => {
    expect(num(1234567)).toBe("1,234,567");
    expect(num(1234.5)).toBe("1,234.5");
    expect(num(null)).toBe("N/A");
  });
});
