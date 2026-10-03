/**
 * Dollar amounts print the same on the server and in the browser
 * (lib/number-format.ts formatUsdAmount). On /pricing in Uzbek, Node's ICU
 * wrote "10 US$" and Chromium's "$ 10" for the same price, React saw two
 * different texts and threw the server's HTML away (error #418). The three
 * languages are laid out by table now. Pinned with `Intl.NumberFormat` taken
 * away entirely, and against what `Intl` printed before for en and ru, so the
 * visible price in those two did not change by a character.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatFixed, formatUsdAmount } from "@/lib/number-format";
import { displayPriceText } from "@/lib/pricing";
import { formatUsd } from "@/lib/api/pricing";

const NBSP = "\u00a0";

afterEach(() => vi.unstubAllGlobals());

/** What the code printed before this change, for the two languages that must not change. */
function oldIntl(locale: string, amount: number, min: number) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: min, maximumFractionDigits: 2 }).format(amount);
}

describe("formatUsdAmount", () => {
  it("never asks the runtime: with Intl gone, every language prints from the table", () => {
    vi.stubGlobal("Intl", {
      ...Intl,
      NumberFormat: function () {
        throw new Error("runtime ICU must not decide");
      },
    });
    expect(displayPriceText("$10", "en")).toBe("$10");
    expect(displayPriceText("$10", "ru")).toBe(`10${NBSP}$`);
    expect(displayPriceText("$10", "uz")).toBe("$10");
    expect(formatUsd(60, "en")).toBe("$0.60");
    expect(formatUsd(60, "ru")).toBe(`0,60${NBSP}$`);
    expect(formatUsd(60, "uz")).toBe("$0,60");
  });

  it("prints Uzbek the way the Uzbek copy writes dollars: symbol first, spaced thousands, comma decimals", () => {
    expect(displayPriceText("$10", "uz")).toBe("$10");
    expect(displayPriceText("$9.99", "uz")).toBe("$9,99");
    expect(displayPriceText("$1,000", "uz")).toBe(`$1${NBSP}000`);
    expect(displayPriceText("US$1,234.50", "uz")).toBe(`$1${NBSP}234,50`);
    // the symbol is a literal "$", whatever the runtime's currency data says
    for (const v of ["$10", "$0.50", "$160", "$1,000"]) expect(displayPriceText(v, "uz")).not.toMatch(/US|USD|\$ /);
    expect(displayPriceText("$10", "uz-UZ")).toBe("$10");
  });

  it("rounds and pads as before: 9.99, 10, 0.5, large values", () => {
    expect(formatUsdAmount(9.99, "en", 2)).toBe("$9.99");
    expect(formatUsdAmount(10, "en", 0)).toBe("$10");
    expect(formatUsdAmount(10, "en", 2)).toBe("$10.00");
    expect(formatUsdAmount(0.5, "en", 2)).toBe("$0.50");
    expect(formatUsdAmount(0.5, "ru", 2)).toBe(`0,50${NBSP}$`);
    expect(formatUsdAmount(1234567.89, "en")).toBe("$1,234,567.89");
    expect(formatUsdAmount(1234567.89, "uz")).toBe(`$1${NBSP}234${NBSP}567,89`);
    expect(formatUsdAmount(100000, "ru", 0)).toBe(`100${NBSP}000${NBSP}$`);
    expect(formatUsdAmount(0.005, "en", 2)).toBe("$0.01");
    expect(formatUsdAmount(1.005, "en", 2)).toBe("$1.01");
    expect(formatUsdAmount(0, "en", 2)).toBe("$0.00");
    expect(formatUsdAmount(-5, "en", 2)).toBe("-$5.00");
    expect(formatUsdAmount(-5, "ru", 2)).toBe(`-5,00${NBSP}$`);
    expect(formatUsdAmount(Number.NaN, "en")).toBe("—");
    expect(formatFixed(9.5, "en", 2, 2)).toBe("9.50");
    expect(formatFixed(9.5, "en", 0, 2)).toBe("9.5");
  });

  it("changes nothing in English and Russian: the same text as the Intl currency formatter, over 4,000 amounts", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const cents = [0, 1, 5, 9, 10, 50, 99, 100, 999, 1000, 1999, 100000, 123456789, ...Array.from({ length: 4000 }, () => Math.floor(rand() ** 3 * 10_000_000))];
    for (const c of cents) {
      const amount = c / 100;
      for (const locale of ["en", "ru"]) {
        // displayPriceText: whole dollars drop the cents, anything else keeps two.
        expect(formatUsdAmount(amount, locale, c % 100 === 0 ? 0 : 2, 2), `${locale} ${c} (display)`).toBe(oldIntl(locale, amount, c % 100 === 0 ? 0 : 2));
        // formatUsd: always two decimals.
        expect(formatUsd(c, locale), `${locale} ${c} (usd)`).toBe(oldIntl(locale, amount, 2));
      }
    }
  });

  it("does not move a price: the digits of a configured price are exactly the owner's", () => {
    for (const [text, digits] of [["$10", "10"], ["$9.99", "999"], ["$45", "45"], ["$160", "160"], ["$1,000", "1000"], ["$0.50", "050"]] as const) {
      for (const locale of ["en", "ru", "uz"]) expect(displayPriceText(text, locale).replace(/\D/g, "")).toBe(digits);
    }
    for (const v of ["€9", "from $5", "10 USD / one-time", "$0", ""]) expect(displayPriceText(v, "uz")).toBe(v);
  });
});
