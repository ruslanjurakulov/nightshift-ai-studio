import { describe, expect, it } from "vitest";
import {
  SHOWCASE,
  jsonLdScript,
  pricingTeaser,
  siteOrigin,
  softwareApplicationJsonLd,
  visibleShowcase,
} from "@/lib/landing";
import { resolvePricing, type PricingEnv } from "@/lib/pricing";
import { resolvePaddleConfig } from "@/lib/paddle";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

describe("output showcase", () => {
  it("ships empty, so the landing page renders no results section at all", () => {
    expect(visibleShowcase(SHOWCASE)).toEqual([]);
  });

  it("drops entries that would render as broken cards", () => {
    const good = { youtubeId: "dQw4w9WgXcQ", title: "A real title", channel: "A channel" };
    expect(
      visibleShowcase([
        good,
        { youtubeId: "not-an-id", title: "x", channel: "y" },
        { youtubeId: "dQw4w9WgXcQ", title: "   ", channel: "y" },
        { youtubeId: "dQw4w9WgXcQ", title: "x", channel: "" },
      ]),
    ).toEqual([good]);
  });
});

describe("pricing teaser", () => {
  it("says pricing is announced at launch when nothing is configured — never a number", () => {
    expect(pricingTeaser(resolvePricing({}, null))).toEqual({ kind: "announced" });
  });

  it("shows only the display prices the owner set, from the same source as /pricing", () => {
    const env: PricingEnv = { NEXT_PUBLIC_PRICE_DISPLAY_CREATOR: "$45" };
    const teaser = pricingTeaser(resolvePricing(env, null));
    expect(teaser).toEqual({ kind: "packs", packs: [{ id: "creator", credits: 5000, price: "$45" }] });
  });

  it("leaves a Paddle pack without a display price unpriced (price at checkout)", () => {
    const paddle = resolvePaddleConfig({
      NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_0123456789abcdef0123",
      NEXT_PUBLIC_PADDLE_ENV: "sandbox",
      NEXT_PUBLIC_PADDLE_PRICE_STARTER: "pri_01starter0000000000000000",
    });
    const teaser = pricingTeaser(resolvePricing({}, paddle));
    expect(teaser.kind).toBe("packs");
    if (teaser.kind === "packs") expect(teaser.packs.map((p) => p.price)).toEqual([null]);
  });
});

describe("site origin", () => {
  it("reduces APP_ORIGIN to an origin", () => {
    expect(siteOrigin({ APP_ORIGIN: "https://app.example.com/x/" })).toBe("https://app.example.com");
  });

  it("returns null rather than a guessed origin (no canonical is better than localhost)", () => {
    expect(siteOrigin({})).toBeNull();
    expect(siteOrigin({ APP_ORIGIN: "not a url" })).toBeNull();
    expect(siteOrigin({ APP_ORIGIN: "javascript:alert(1)" })).toBeNull();
  });
});

describe("JSON-LD", () => {
  it("claims no offers or ratings", () => {
    const data = softwareApplicationJsonLd({ name: "Nightshift", description: "d", url: null });
    expect(data["@type"]).toBe("SoftwareApplication");
    expect(data).not.toHaveProperty("offers");
    expect(data).not.toHaveProperty("aggregateRating");
    expect(data).not.toHaveProperty("url");
  });

  it("cannot close its own script element", () => {
    expect(jsonLdScript({ d: "</script><script>x" })).not.toContain("</script>");
  });
});

describe("landing copy", () => {
  it("keeps the same list lengths in every language, so no section renders half-translated", () => {
    for (const d of [ru, uz]) {
      const l = d.landing;
      expect(l.mock.filters).toHaveLength(en.landing.mock.filters.length);
      expect(l.mock.chips).toHaveLength(en.landing.mock.chips.length);
      expect(l.promises.items).toHaveLength(en.landing.promises.items.length);
      expect(l.how.steps).toHaveLength(en.landing.how.steps.length);
      expect(l.features.items.map((i) => i.id)).toEqual(en.landing.features.items.map((i) => i.id));
      expect(l.features.items.map((i) => i.points.length)).toEqual(en.landing.features.items.map((i) => i.points.length));
      expect(l.why.rows).toHaveLength(en.landing.why.rows.length);
      expect(d.pricing.terms).toHaveLength(en.pricing.terms.length);
      expect(d.pricing.faq.map((i) => i.id)).toEqual(en.pricing.faq.map((i) => i.id));
      expect(l.faq.items.map((i) => i.id)).toEqual(en.landing.faq.items.map((i) => i.id));
    }
  });

  it("has three steps in How it works", () => {
    expect(en.landing.how.steps).toHaveLength(3);
  });

  it("names no competitor or provider brand in public copy", () => {
    const brands = /\b(?:krea|higgsfield|magiclight|kling|capcut|inshot|runway|midjourney|elevenlabs|veo|sora|pika)\b/i;
    for (const d of [en, ru, uz]) {
      expect(JSON.stringify(d.landing)).not.toMatch(brands);
      expect(JSON.stringify(d.pricing)).not.toMatch(brands);
    }
  });

  it("no longer says access is by invitation — signup is open", () => {
    for (const d of [en, ru, uz]) expect(JSON.stringify(d.landing)).not.toMatch(/invitation|приглашени|taklif orqali/i);
  });
});
