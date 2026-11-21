// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * /pricing while payments are in test mode (Paddle's sandbox, Dodo's test mode). What would break without these: a
 * visitor reading "Sandbox · test payments only" on the public price list, or being handed a Buy or Subscribe key that
 * opens a checkout where nothing bought is real; or the platform admin losing the badge and the way to the test checkout
 * they use to try it; or live mode changing at all.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/pricing",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// Paddle.js is never loaded in a test: the cards fall back to the display prices, which is what is asserted.
vi.mock("@/lib/paddle-client", () => ({
  ensurePaddle: () => Promise.reject(new Error("no paddle in tests")),
  previewPrices: () => Promise.resolve({}),
}));

import { dictionaries, type Locale } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { PricingView } from "@/components/pricing/PricingView";
import { resolvePaddleConfig, type PaddleEnvironment } from "@/lib/paddle";
import { resolvePricing, type Pricing } from "@/lib/pricing";
import { dodoPricing } from "@/lib/payments";
import { dodoView, resolveDodoServer } from "@/lib/dodo";
import type { PlanMatrix } from "@/lib/plans";

afterEach(cleanup);

function paddlePricing(environment: PaddleEnvironment): Pricing {
  const paddle = resolvePaddleConfig({
    NEXT_PUBLIC_PADDLE_ENV: environment,
    NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: environment === "sandbox" ? "test_visualqafake0000" : "live_visualqafake0000",
    NEXT_PUBLIC_PADDLE_PRICE_STARTER: "pri_starterpack000001",
  });
  expect(paddle?.environment).toBe(environment);
  return resolvePricing({ NEXT_PUBLIC_PRICE_DISPLAY_STARTER: "$10" }, paddle);
}

function plans(environment: PaddleEnvironment | null): PlanMatrix {
  return {
    columns: [
      { id: "free", name: "Free", monthlyCredits: 0, isDefault: true, priceId: null, displayPrice: null },
      { id: "pro", name: "Pro", monthlyCredits: 6000, isDefault: false, priceId: "pri_proplan0000000001", displayPrice: "$49" },
    ],
    rows: [],
    purchasable: true,
    paddle: environment ? { environment, clientToken: environment === "sandbox" ? "test_visualqafake0000" : "live_visualqafake0000" } : null,
  };
}

const dodoTest = dodoView(
  resolveDodoServer({
    DODO_PAYMENTS_API_KEY: "dodo_test_" + "k".repeat(32),
    DODO_PRODUCT_STARTER: "pdt_0NVbdIG3JNg9Yc8ey5JHW",
    DODO_METADATA_SECRET: "cc-metadata-secret-0123456789abcdef-xyz",
  }),
)!;

function renderPricing(
  props: { pricing: Pricing; plans: PlanMatrix | null; signedIn?: boolean; operator?: boolean },
  locale: Locale = "en",
) {
  const t = dictionaries[locale];
  // The provider the root layout really mounts on /pricing: the public slice, not the app's dictionaries.
  return render(
    <PublicI18nProvider locale={locale} t={publicDictionary(t)}>
      <PricingView t={t} locale={locale} rates={null} signedIn={props.signedIn ?? false} pricing={props.pricing} plans={props.plans} operator={props.operator} />
    </PublicI18nProvider>,
  );
}

/** Every key into a checkout this page can offer: Buy (signed in or out) and Subscribe (signed in or out). */
function checkoutKeys(locale: Locale) {
  const t = dictionaries[locale];
  return [t.pricing.buySignedIn, t.pricing.buySignedOut, t.plans.subscribe, t.plans.subscribeSignedOut];
}

describe("/pricing in test mode, for a visitor", () => {
  for (const locale of ["en", "ru", "uz"] as const) {
    it(`signed out (${locale}): no test-mode words, no Buy or Subscribe key, and "purchases open soon" in their place`, () => {
      const t = dictionaries[locale];
      const { container } = renderPricing({ pricing: paddlePricing("sandbox"), plans: plans("sandbox") }, locale);
      const text = container.textContent ?? "";
      expect(text).not.toContain(t.pricing.sandbox);
      expect(text).not.toMatch(/sandbox/i);
      for (const label of checkoutKeys(locale)) expect(screen.queryByRole("link", { name: label })).toBeNull();
      // One in the plan card, one under the packs; the prices themselves stay on the page.
      expect(screen.getAllByText(t.pricing.purchasesSoon)).toHaveLength(2);
      expect(text).toMatch(/\$49|49\s\$/);
      expect(text).toMatch(/\$10|10\s\$/);
    });
  }

  it("signed in but not the platform admin: the same closed state", () => {
    const t = dictionaries.en;
    const { container } = renderPricing({ pricing: paddlePricing("sandbox"), plans: plans("sandbox"), signedIn: true, operator: false });
    expect(container.textContent).not.toContain(t.pricing.sandbox);
    for (const label of checkoutKeys("en")) expect(screen.queryByRole("link", { name: label })).toBeNull();
    expect(screen.getAllByText(t.pricing.purchasesSoon)).toHaveLength(2);
  });

  it("Dodo's test mode is closed the same way", () => {
    const t = dictionaries.en;
    const { container } = renderPricing({ pricing: dodoPricing(dodoTest), plans: null });
    expect(container.textContent).not.toContain(t.pricing.sandbox);
    expect(screen.queryByRole("link", { name: t.pricing.buySignedOut })).toBeNull();
    expect(screen.getByText(t.pricing.purchasesSoon)).toBeTruthy();
  });

  it("the public dictionary slice carries no test-mode badge, so the words never reach a visitor's browser", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      const json = JSON.stringify(publicDictionary(dictionaries[locale]));
      expect(json).not.toContain(dictionaries[locale].pricing.sandbox);
      expect(json).toContain(dictionaries[locale].pricing.purchasesSoon);
    }
  });
});

describe("/pricing in test mode, for the platform admin", () => {
  it("keeps the badge and the way to the test checkout", () => {
    const t = dictionaries.en;
    renderPricing({ pricing: paddlePricing("sandbox"), plans: plans("sandbox"), signedIn: true, operator: true });
    // Over the plan cards and over the packs.
    expect(screen.getAllByText(t.pricing.sandbox)).toHaveLength(2);
    expect(screen.getByRole("link", { name: t.pricing.buySignedIn }).getAttribute("href")).toMatch(/\/credits$/);
    expect(screen.getByRole("link", { name: t.plans.subscribe }).getAttribute("href")).toMatch(/\/credits#plans$/);
    expect(screen.queryByText(t.pricing.purchasesSoon)).toBeNull();
  });

  it("with Dodo's test mode too", () => {
    const t = dictionaries.en;
    renderPricing({ pricing: dodoPricing(dodoTest), plans: null, signedIn: true, operator: true });
    expect(screen.getByText(t.pricing.sandbox)).toBeTruthy();
    expect(screen.getByRole("link", { name: t.pricing.buySignedIn })).toBeTruthy();
  });
});

describe("/pricing in live mode", () => {
  it("is unchanged for a visitor: Buy and Subscribe keys, no badge, no 'open soon'", () => {
    const t = dictionaries.en;
    renderPricing({ pricing: paddlePricing("production"), plans: plans("production") });
    expect(screen.getByRole("link", { name: t.pricing.buySignedOut }).getAttribute("href")).toBe("/login");
    expect(screen.getByRole("link", { name: t.plans.subscribeSignedOut }).getAttribute("href")).toBe("/signup");
    expect(screen.queryByText(t.pricing.sandbox)).toBeNull();
    expect(screen.queryByText(t.pricing.purchasesSoon)).toBeNull();
  });

  it("and for the platform admin: no badge either", () => {
    const t = dictionaries.en;
    renderPricing({ pricing: paddlePricing("production"), plans: plans("production"), signedIn: true, operator: true });
    expect(screen.queryByText(t.pricing.sandbox)).toBeNull();
    expect(screen.getByRole("link", { name: t.pricing.buySignedIn })).toBeTruthy();
    expect(screen.getByRole("link", { name: t.plans.subscribe })).toBeTruthy();
  });
});
