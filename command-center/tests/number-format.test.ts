/**
 * Numbers print the same on the server and in the browser (lib/number-format):
 * Node's ICU groups Uzbek with a no-break space, Chromium's has no Uzbek
 * symbols and prints "1,191". The table decides, not the runtime — pinned
 * here with Intl.NumberFormat taken away entirely.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatNumber } from "@/lib/number-format";
import { formatCredits } from "@/lib/credits";
import { formatTimecode } from "@/components/ui/Timecode";

const NBSP = " ";

afterEach(() => vi.unstubAllGlobals());

describe("formatNumber", () => {
  it("groups by the language's own separators, with Intl gone", () => {
    vi.stubGlobal("Intl", {
      ...Intl,
      NumberFormat: function () {
        throw new Error("runtime ICU must not decide");
      },
    });
    expect(formatCredits(1191, "uz")).toBe(`1${NBSP}191`);
    expect(formatCredits(1191, "ru")).toBe(`1${NBSP}191`);
    expect(formatCredits(1191, "en")).toBe("1,191");
    expect(formatCredits(1191.5, "uz")).toBe(`1${NBSP}191,5`);
    expect(formatTimecode(4000, "count", { locale: "uz" })).toBe(`4${NBSP}000`);
    expect(formatTimecode(1250, "credits", { locale: "en" })).toBe("1,250");
  });

  it("matches what Intl prints for en, ru and uz where full ICU is present (Node)", () => {
    for (const locale of ["en", "ru", "uz"]) {
      for (const n of [0, 5, 999, 1000, 1191, 1191.5, 2.5, 0.005, 12345678.9, -1234567.891]) {
        expect(formatNumber(n, locale, 2), `${locale} ${n}`).toBe(new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n));
      }
    }
  });

  it("falls back to English for any other language, and never invents a number", () => {
    expect(formatNumber(1191, "de")).toBe("1,191");
    expect(formatNumber(1191, "uz-Latn-UZ")).toBe(`1${NBSP}191`);
    expect(formatNumber(Number.NaN, "en")).toBe("—");
    expect(formatCredits(null, "uz")).toBe("—");
  });
});
