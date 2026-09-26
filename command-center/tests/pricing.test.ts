import { describe, expect, it } from "vitest";
import { resolvePaddleConfig, previewTotals, type PaddleEnv } from "@/lib/paddle";
import { parsePrices } from "@/lib/credits";
import { creditExpiryMonths } from "@/lib/legal";
import {
  creditRates,
  packMinutes,
  packPrice,
  readDisplayPrice,
  resolvePricing,
  type PricingEnv,
} from "@/lib/pricing";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

const PADDLE: PaddleEnv = {
  NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_0123456789abcdef0123",
  NEXT_PUBLIC_PADDLE_ENV: "sandbox",
  NEXT_PUBLIC_PADDLE_PRICE_STARTER: "pri_01starter0000000000000000",
  NEXT_PUBLIC_PADDLE_PRICE_CREATOR: "pri_01creator0000000000000000",
  NEXT_PUBLIC_PADDLE_PRICE_STUDIO: "",
};
const DISPLAY: PricingEnv = {
  NEXT_PUBLIC_PRICE_DISPLAY_STARTER: "$10",
  NEXT_PUBLIC_PRICE_DISPLAY_CREATOR: " 45 USD ",
  NEXT_PUBLIC_PRICE_DISPLAY_STUDIO: "$160",
};

describe("readDisplayPrice", () => {
  it("keeps what the owner wrote, trimmed", () => {
    expect(readDisplayPrice(" $10 ")).toBe("$10");
    expect(readDisplayPrice("45   USD")).toBe("45 USD");
    expect(readDisplayPrice("€39,90")).toBe("€39,90");
  });

  // A leftover placeholder printed as a price would be a false offer.
  it.each([undefined, "", "   ", "TBD", "price", "…", "<b>$10</b>", "$10 {x}", "x".repeat(38) + "100"])(
    "refuses %j as a price",
    (raw) => {
      expect(readDisplayPrice(raw)).toBeNull();
    },
  );
});

describe("resolvePricing", () => {
  it("is 'none' — the coming-soon page — with neither Paddle nor display prices", () => {
    const p = resolvePricing({}, null);
    expect(p.source).toBe("none");
    expect(p.packs).toEqual([]);
    expect(p.paddle).toBeNull();
  });

  it("does not invent prices: placeholder display values still read as not configured", () => {
    expect(resolvePricing({ NEXT_PUBLIC_PRICE_DISPLAY_STARTER: "TBD" }, null).source).toBe("none");
  });

  it("lists only the packs that have a display price when there is no checkout", () => {
    const p = resolvePricing({ NEXT_PUBLIC_PRICE_DISPLAY_STARTER: "$10", NEXT_PUBLIC_PRICE_DISPLAY_STUDIO: "$160" }, null);
    expect(p.source).toBe("display");
    expect(p.packs).toEqual([
      { id: "starter", credits: 1000, displayPrice: "$10", priceId: null },
      { id: "studio", credits: 20000, displayPrice: "$160", priceId: null },
    ]);
  });

  // An offer nobody can take is worse than no offer: with Paddle on, the page
  // lists exactly what Paddle sells, even if another pack has a display price.
  it("lists exactly the packs Paddle sells when Paddle is configured", () => {
    const p = resolvePricing(DISPLAY, resolvePaddleConfig(PADDLE));
    expect(p.source).toBe("paddle");
    expect(p.packs.map((x) => x.id)).toEqual(["starter", "creator"]);
    expect(p.packs[1]).toEqual({ id: "creator", credits: 5000, displayPrice: "45 USD", priceId: "pri_01creator0000000000000000" });
    expect(p.paddle).toEqual({ environment: "sandbox", clientToken: "test_0123456789abcdef0123" });
  });

  it("falls back to display prices when the Paddle settings are invalid", () => {
    const broken = resolvePaddleConfig({ ...PADDLE, NEXT_PUBLIC_PADDLE_ENV: "production" });
    expect(broken).toBeNull();
    expect(resolvePricing(DISPLAY, broken).source).toBe("display");
  });
});

describe("packPrice", () => {
  const sold = { id: "starter" as const, credits: 1000, displayPrice: "$10", priceId: "pri_01starter0000000000000000" };
  const bare = { ...sold, displayPrice: null };

  it("prefers Paddle's localized preview — it is what the checkout will charge", () => {
    expect(packPrice(sold, { [sold.priceId]: "US$10.00" }, false)).toEqual({ kind: "preview", text: "US$10.00" });
  });

  it("shows the owner's display price while the preview loads or when it fails", () => {
    expect(packPrice(sold, null, true)).toEqual({ kind: "display", text: "$10" });
    expect(packPrice(sold, {}, false)).toEqual({ kind: "display", text: "$10" });
  });

  it("never shows a number it does not have", () => {
    expect(packPrice(bare, null, true)).toEqual({ kind: "pending" });
    expect(packPrice(bare, { pri_other: "$99" }, false)).toEqual({ kind: "at_checkout" });
  });
});

describe("previewTotals", () => {
  it("maps Paddle's preview lines to price id -> formatted total", () => {
    expect(
      previewTotals({
        data: {
          details: {
            lineItems: [
              { price: { id: "pri_a" }, formattedTotals: { total: "€9.99" } },
              { price: { id: "pri_b" }, formattedTotals: { total: " " } },
              { price: {}, formattedTotals: { total: "$1" } },
            ],
          },
        },
      }),
    ).toEqual({ pri_a: "€9.99" });
    expect(previewTotals(null)).toEqual({});
    expect(previewTotals({})).toEqual({});
  });
});

describe("credit rates", () => {
  it("reads the per-minute rate with its margin, and the per-run minimum without", () => {
    const prices = parsePrices([
      { unit: "video_minute", credits_per_unit: 20, margin: 0.25 },
      { unit: "job_minimum", credits_per_unit: 30, margin: 0.5 },
    ]);
    expect(creditRates(prices)).toEqual({ perMinute: 25, jobMinimum: 30 });
  });

  // Unset is unpriced, never free (0020's rule).
  it("leaves an unset rate null, not 0", () => {
    expect(creditRates(parsePrices([]))).toEqual({ perMinute: null, jobMinimum: null });
  });

  it("puts minutes on a pack only when there is a positive rate", () => {
    expect(packMinutes(1000, 25)).toBe(40);
    expect(packMinutes(1000, 30)).toBe(33);
    expect(packMinutes(1000, null)).toBeNull();
    expect(packMinutes(1000, 0)).toBeNull();
  });
});

describe("credit expiry", () => {
  it("is 'never' unless the owner sets a whole number of months", () => {
    expect(creditExpiryMonths(undefined)).toBeNull();
    expect(creditExpiryMonths("")).toBeNull();
    expect(creditExpiryMonths("12")).toBe(12);
    expect(creditExpiryMonths(" 24 ")).toBe(24);
  });

  it.each(["0", "-1", "1.5", "twelve", "121", "12 months"])("treats %j as unset", (raw) => {
    expect(creditExpiryMonths(raw)).toBeNull();
  });
});

describe("pricing strings", () => {
  // The page names Paddle as seller in every language — that sentence is what
  // Paddle's reviewers look for.
  it.each([
    ["en", en],
    ["ru", ru],
    ["uz", uz],
  ] as const)("%s names Paddle as Merchant of Record and keeps the placeholders", (_, t) => {
    expect(t.pricing.paymentsBody).toContain("Paddle.com");
    expect(t.pricing.paymentsBody).toContain("Merchant of Record");
    expect(t.pricing.credits).toContain("{n}");
    expect(t.pricing.rateValue).toContain("{n}");
    expect(t.pricing.minutes).toContain("{m}");
    expect(t.pricing.expiryAfter).toContain("{m}");
  });
});
