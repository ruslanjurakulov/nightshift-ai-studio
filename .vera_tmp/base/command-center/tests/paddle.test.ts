import { describe, expect, it } from "vitest";
import {
  buyAccess,
  checkoutCustomData,
  paddleLocale,
  purchaseArrived,
  resolvePaddleConfig,
  type PaddleEnv,
} from "@/lib/paddle";
import { DEFAULT_ORG_ID } from "@/lib/orgs";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

const SANDBOX: PaddleEnv = {
  NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_0123456789abcdef0123",
  NEXT_PUBLIC_PADDLE_ENV: "sandbox",
  NEXT_PUBLIC_PADDLE_PRICE_STARTER: "pri_01starter0000000000000000",
  NEXT_PUBLIC_PADDLE_PRICE_CREATOR: "pri_01creator0000000000000000",
  NEXT_PUBLIC_PADDLE_PRICE_STUDIO: "pri_01studio00000000000000000",
};
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("resolvePaddleConfig", () => {
  it("is not configured without a token or without any pack", () => {
    expect(resolvePaddleConfig({})).toBeNull();
    expect(resolvePaddleConfig({ ...SANDBOX, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "" })).toBeNull();
    expect(
      resolvePaddleConfig({
        ...SANDBOX,
        NEXT_PUBLIC_PADDLE_PRICE_STARTER: "",
        NEXT_PUBLIC_PADDLE_PRICE_CREATOR: "",
        NEXT_PUBLIC_PADDLE_PRICE_STUDIO: "",
      }),
    ).toBeNull();
  });

  it("defaults to the sandbox, never to production", () => {
    expect(resolvePaddleConfig({ ...SANDBOX, NEXT_PUBLIC_PADDLE_ENV: "" })?.environment).toBe("sandbox");
    expect(resolvePaddleConfig({ ...SANDBOX, NEXT_PUBLIC_PADDLE_ENV: "live" })).toBeNull();
  });

  it("refuses a token from the other environment — a half-finished switch to production", () => {
    expect(resolvePaddleConfig({ ...SANDBOX, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "live_0123456789abcdef0123" })).toBeNull();
    expect(resolvePaddleConfig({ ...SANDBOX, NEXT_PUBLIC_PADDLE_ENV: "production" })).toBeNull();
    const prod = resolvePaddleConfig({
      ...SANDBOX,
      NEXT_PUBLIC_PADDLE_ENV: "production",
      NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "live_0123456789abcdef0123",
    });
    expect(prod?.environment).toBe("production");
  });

  it("leaves a pack off the page when its price id is unset, malformed or a duplicate", () => {
    const c = resolvePaddleConfig({
      ...SANDBOX,
      NEXT_PUBLIC_PADDLE_PRICE_CREATOR: "price_123",
      NEXT_PUBLIC_PADDLE_PRICE_STUDIO: SANDBOX.NEXT_PUBLIC_PADDLE_PRICE_STARTER,
    });
    expect(c?.packs.map((p) => p.id)).toEqual(["starter"]);
    expect(c?.packs[0]).toEqual({ id: "starter", credits: 1000, priceId: SANDBOX.NEXT_PUBLIC_PADDLE_PRICE_STARTER });
  });
});

describe("buyAccess", () => {
  const config = resolvePaddleConfig(SANDBOX);

  it("never offers a checkout to the exempt default organization", () => {
    expect(buyAccess(DEFAULT_ORG_ID, "owner", config)).toBe("hidden");
  });

  it("hides everything when Paddle is not configured", () => {
    expect(buyAccess(ORG, "owner", null)).toBe("hidden");
  });

  it("offers the checkout to owners and admins, and tells the others who can", () => {
    expect(buyAccess(ORG, "owner", config)).toBe("allowed");
    expect(buyAccess(ORG, "admin", config)).toBe("allowed");
    expect(buyAccess(ORG, "editor", config)).toBe("admin_only");
    expect(buyAccess(ORG, "viewer", config)).toBe("admin_only");
  });
});

describe("checkout helpers", () => {
  it("custom data carries ids only — never an amount", () => {
    expect(checkoutCustomData(ORG, "u1")).toEqual({ org_id: ORG, user_id: "u1" });
    expect(checkoutCustomData(ORG, null)).toEqual({ org_id: ORG });
  });

  it("falls back to Russian for Uzbek, which Paddle's checkout does not speak", () => {
    expect(paddleLocale("en")).toBe("en");
    expect(paddleLocale("ru")).toBe("ru");
    expect(paddleLocale("uz")).toBe("ru");
  });

  it("a purchase has arrived only once the balance has grown", () => {
    expect(purchaseArrived(100, 100)).toBe(false);
    expect(purchaseArrived(100, 1100)).toBe(true);
    expect(purchaseArrived(100, Number.NaN)).toBe(false);
  });

  it("every pack has a name in every language", () => {
    for (const dict of [en, ru, uz]) {
      expect(Object.keys(dict.credits.buy.pack).sort()).toEqual(["creator", "starter", "studio"]);
    }
  });
});
