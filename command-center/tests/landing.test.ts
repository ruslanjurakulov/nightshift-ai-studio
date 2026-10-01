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
import { PROVIDER_BRANDS } from "./helpers/brands";

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
  it("keeps the same lists and ids in every language, so no section renders half-translated", () => {
    for (const d of [ru, uz]) {
      const l = d.landing;
      expect(l.mock.styles).toHaveLength(en.landing.mock.styles.length);
      expect(Object.keys(l.flow)).toEqual(Object.keys(en.landing.flow));
      expect(l.how.steps.map((s) => s.id)).toEqual(en.landing.how.steps.map((s) => s.id));
      expect(Object.keys(l.make.formats)).toEqual(Object.keys(en.landing.make.formats));
      expect(Object.keys(l.make.tools)).toEqual(Object.keys(en.landing.make.tools));
      expect(l.why.items.map((i) => i.id)).toEqual(en.landing.why.items.map((i) => i.id));
      expect(d.pricing.terms).toHaveLength(en.pricing.terms.length);
      expect(d.pricing.faq.map((i) => i.id)).toEqual(en.pricing.faq.map((i) => i.id));
      expect(l.faq.items.map((i) => i.id)).toEqual(en.landing.faq.items.map((i) => i.id));
    }
  });

  it("walks the video flow in the product's order, ending with your approval and YouTube", () => {
    expect(en.landing.how.steps.map((s) => s.id)).toEqual(["channel", "topic", "script", "video", "approval", "youtube"]);
  });

  it("answers cancelling, refunds, unused credits and privacy before anyone buys", () => {
    for (const d of [en, ru, uz]) {
      const ids = d.landing.faq.items.map((i) => i.id);
      for (const id of ["cancel", "refund", "unused", "data"]) expect(ids).toContain(id);
    }
  });

  it("states the welcome grant through a placeholder, never a typed number", () => {
    for (const d of [en, ru, uz]) {
      expect(d.landing.hero.note).toContain("{n}");
      expect(d.landing.hero.note).not.toMatch(/\d/);
      expect(d.plans.freeCredits).toContain("{n}");
      expect(d.plans.freeCredits).not.toMatch(/\d/);
      expect(d.pricing.freeChip).toContain("{n}");
    }
  });

  it("names no competitor or provider brand in public copy", () => {
    const brands = PROVIDER_BRANDS;
    for (const d of [en, ru, uz]) {
      expect(JSON.stringify(d.landing)).not.toMatch(brands);
      expect(JSON.stringify(d.pricing)).not.toMatch(brands);
    }
  });

  it("no longer says access is by invitation — signup is open", () => {
    for (const d of [en, ru, uz]) expect(JSON.stringify(d.landing)).not.toMatch(/invitation|приглашени|taklif orqali/i);
  });
});
