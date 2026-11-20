import { describe, expect, it } from "vitest";
import {
  bucketFor,
  delta,
  parseSelection,
  previousPeriod,
  resolvePeriod,
  selectionQuery,
  tashkentDay,
  tashkentDayStartUtc,
} from "@/lib/owner-analytics/period";
import { crc32, neutralize, sheetName, toCsv, toXlsx } from "@/lib/owner-analytics/export";

// 2026-11-20 20:30 UTC is already 2026-11-21 01:30 in Tashkent.
const LATE = new Date("2026-11-20T20:30:00Z");

describe("owner analytics period (Asia/Tashkent)", () => {
  it("puts a sale after 19:00 UTC on the next Tashkent day, not the UTC one", () => {
    expect(tashkentDay(LATE)).toBe("2026-11-21");
    expect(tashkentDayStartUtc("2026-11-21")).toBe("2026-11-20T19:00:00.000Z");
  });

  it("today is one Tashkent day, half-open", () => {
    const { period } = resolvePeriod("today", LATE);
    expect(period).toMatchObject({ startDay: "2026-11-21", endDay: "2026-11-21", days: 1 });
    expect(period.from).toBe("2026-11-20T19:00:00.000Z");
    expect(period.to).toBe("2026-11-21T19:00:00.000Z");
  });

  it("MTD, QTD and YTD start on the Tashkent month, quarter and year", () => {
    expect(resolvePeriod("mtd", LATE).period.startDay).toBe("2026-11-01");
    expect(resolvePeriod("qtd", LATE).period.startDay).toBe("2026-10-01");
    expect(resolvePeriod("ytd", LATE).period.startDay).toBe("2026-01-01");
  });

  it("compares with an equal-length window that ends the day before, so adjacent periods never overlap", () => {
    const { period } = resolvePeriod("7d", LATE);
    const prev = previousPeriod(period);
    expect(prev.days).toBe(7);
    expect(prev.to).toBe(period.from);
  });

  it("refuses a reversed, future, impossible or decade-long custom range — and says it fell back", () => {
    for (const c of [
      { start: "2026-11-10", end: "2026-11-01" },
      { start: "2026-11-01", end: "2027-01-01" },
      { start: "2026-02-30", end: "2026-03-01" },
      { start: "2016-01-01", end: "2026-01-01" },
      { start: "x", end: "y" },
    ]) {
      const r = resolvePeriod("custom", LATE, c);
      expect(r.fellBack).toBe(true);
      expect(r.period.preset).toBe("30d");
    }
    expect(resolvePeriod("custom", LATE, { start: "2026-01-01", end: "2026-01-31" }).period.days).toBe(31);
  });

  it("round-trips through the URL, including compare", () => {
    const sel = parseSelection({ period: "custom", start: "2026-10-01", end: "2026-10-31", compare: "1" }, LATE);
    expect(sel.previous?.endDay).toBe("2026-09-30");
    expect(selectionQuery(sel)).toBe("period=custom&start=2026-10-01&end=2026-10-31&compare=1");
    expect(parseSelection({ period: "nonsense" }, LATE).current.preset).toBe("30d");
  });

  it("does not state a change from nothing", () => {
    expect(delta(5, 0)).toBeNull();
    expect(delta(null, 3)).toBeNull();
    expect(delta(15, 10)).toBeCloseTo(0.5);
    expect(bucketFor(30)).toBe("day");
    expect(bucketFor(200)).toBe("week");
    expect(bucketFor(800)).toBe("month");
  });
});

describe("owner analytics export", () => {
  it("neutralises text a spreadsheet would run as a formula", () => {
    expect(neutralize("=HYPERLINK(\"http://x\")")).toBe("'=HYPERLINK(\"http://x\")");
    expect(neutralize("+1")).toBe("'+1");
    expect(neutralize("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(neutralize("Plan Pro")).toBe("Plan Pro");
  });

  it("writes an unknown as an empty CSV cell, never 0", () => {
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      toCsv({ name: "t", columns: ["a", "b"], rows: [[null, 0], ["x,y", -5]] }),
    );
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("\r\n,0\r\n");
    expect(csv).toContain('"x,y",-5');
  });

  it("builds a zip Excel can open: local headers, central directory, correct CRC", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const bytes = toXlsx([{ name: "Revenue", columns: ["day", "usd"], rows: [["2026-11-01", 12.5], ["=evil", null]] }]);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("'=evil");
    expect(text).not.toContain("<t xml:space=\"preserve\">=evil");
  });

  it("keeps sheet names inside Excel's rules", () => {
    expect(sheetName("a/b:c?d*e[f]g")).toBe("a b c d e f g");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
    expect(sheetName("")).toBe("Sheet1");
  });
});
