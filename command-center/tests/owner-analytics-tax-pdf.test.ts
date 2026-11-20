import { describe, expect, it, vi } from "vitest";
import { monthlyTotals, quarterlyTotals, registerRows, registerTable, totalsTable } from "@/lib/owner-analytics/tax";
import { resolvePeriod } from "@/lib/owner-analytics/period";
import { ownerAnalyticsEn as d } from "@/lib/i18n/owner-analytics/en";
import type { MoneyRow } from "@/lib/owner-analytics/money";

vi.mock("server-only", () => ({}));

const OCT = resolvePeriod("custom", new Date("2026-11-20T10:00:00Z"), { start: "2026-10-01", end: "2026-10-31" }).period;
const row = (p: Partial<MoneyRow> & { at: string }): MoneyRow => ({
  event: "sale", provider: "dodo", paymentRef: `pay_${p.at}`, orgRef: "o", kind: "pack", item: "x", charge: null, currency: "USD",
  amountMinor: 1000, feeMinor: null, periodStart: null, periodEnd: null, subscriptionRef: null, internal: false, ...p,
});

describe("owner income register", () => {
  const money = [
    row({ at: "2026-10-02T10:00:00Z" }),
    row({ at: "2026-10-03T10:00:00Z", event: "refund", amountMinor: 300 }),
    row({ at: "2026-11-05T10:00:00Z" }),
    row({ at: "2026-10-04T10:00:00Z", internal: true }),
  ];
  const rates = [{ day: "2026-10-02", currency: "USD", uzsPerUnit: 12000, source: "lab", enteredAt: null }];

  it("shows UZS only where a rate was frozen, and leaves the operator's own rows out", () => {
    const rows = registerRows(money, rates, OCT);
    expect(rows.map((r) => [r.day, r.event, r.net, r.uzs])).toEqual([
      ["2026-10-02", "sale", 10, 120000],
      ["2026-10-03", "refund", -3, null],
    ]);
  });

  it("gives a month a UZS total only when every row has a rate, and counts the rows without one", () => {
    const rows = registerRows(money, rates, OCT);
    const [oct] = monthlyTotals(rows);
    expect(oct).toMatchObject({ key: "2026-10", uzs: null, rowsWithoutRate: 1 });
    expect(oct.byCurrency).toEqual([{ currency: "USD", net: 7, rows: 2 }]);
    expect(quarterlyTotals(rows)[0].key).toBe("2026-Q4");
  });

  it("reads a yen amount in whole yen and a currency it does not know as unknown, never as cents", () => {
    const jpy = registerRows([row({ at: "2026-10-02T10:00:00Z", currency: "JPY", amountMinor: 1500 })], [{ day: "2026-10-02", currency: "JPY", uzsPerUnit: 80, source: "lab", enteredAt: null }], OCT);
    expect([jpy[0].net, jpy[0].uzs]).toEqual([1500, 120000]);
    const kwd = registerRows([row({ at: "2026-10-02T10:00:00Z", currency: "KWD", amountMinor: 1500 })], [], OCT);
    expect(kwd[0].net).toBe(1.5);
    const odd = registerRows([row({ at: "2026-10-02T10:00:00Z", currency: "XYZ", amountMinor: 1500 })], [], OCT);
    expect([odd[0].gross, odd[0].net]).toEqual([null, null]);
  });

  it("marks the per-period cells of a second currency as belonging above, not as unknown", () => {
    const rows = registerRows(
      [row({ at: "2026-10-02T10:00:00Z" }), row({ at: "2026-10-02T11:00:00Z", currency: "EUR" })],
      [
        { day: "2026-10-02", currency: "USD", uzsPerUnit: 12000, source: "lab", enteredAt: null },
        { day: "2026-10-02", currency: "EUR", uzsPerUnit: 13000, source: "lab", enteredAt: null },
      ],
      OCT,
    );
    const t = totalsTable(d, monthlyTotals(rows), d.monthlyTotals, OCT, false);
    expect(t.rows[0][4]).toBe(250000);
    expect(t.rows[1].slice(4)).toEqual([d.includedAbove, d.includedAbove]);
  });

  it("says it is not a declaration, writes fees as unknown and country as not recorded, and hides payment ids when presenting", () => {
    const rows = registerRows(money, rates, OCT);
    const t = registerTable(d, rows, OCT, false);
    expect(t.preamble).toContain(d.taxNotADeclaration);
    expect(t.rows[0][t.columns.indexOf(d.fees)]).toBeNull();
    expect(t.rows[0][t.columns.indexOf(d.customerCountry)]).toBe(d.notRecorded);
    const presented = registerTable(d, rows, OCT, true);
    expect(JSON.stringify(presented)).not.toContain("pay_");
  });

  it("builds a branded PDF with Cyrillic and Uzbek text and a page count", async () => {
    const { tablesToPdf } = await import("@/lib/server/owner-analytics-pdf");
    const bytes = await tablesToPdf([registerTable(d, registerRows(money, rates, OCT), OCT, false)], {
      title: "Daromadlar reyestri — Реестр доходов",
      periodLine: "Davr: 2026-10-01 — 2026-10-31",
      notes: [d.taxNotADeclaration],
      generatedLine: "lab",
      pageTemplate: "Page {n} of {total}",
      unknownText: "unknown",
    });
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    // pdf-lib packs objects into compressed streams, so read it back with pdf-lib rather than grepping the bytes.
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toBe("Daromadlar reyestri — Реестр доходов");
  });
});
