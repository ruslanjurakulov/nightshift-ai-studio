// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * What /pricing hands its CLIENT components. Their props are serialised into the page source, so a visitor's page must
 * carry neither a test-mode flag nor the test checkout's config (Lens on #784: `testMode":true` in a visitor's source).
 * The server decides "closed" and the badge; only the platform admin's page gets the checkout config.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/pricing", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const seen = vi.hoisted(() => ({ packs: [] as Record<string, unknown>[], plans: [] as Record<string, unknown>[] }));
vi.mock("@/components/pricing/PackCards", () => ({
  PackCards: (p: Record<string, unknown>) => {
    seen.packs.push(p);
    return null;
  },
}));
vi.mock("@/components/pricing/PlanMatrix", () => ({
  PlanMatrix: (p: Record<string, unknown>) => {
    seen.plans.push(p);
    return null;
  },
}));

import { dictionaries } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { PricingView } from "@/components/pricing/PricingView";
import { resolvePaddleConfig, type PaddleEnvironment } from "@/lib/paddle";
import { resolvePricing, type Pricing } from "@/lib/pricing";
import { dodoPricing } from "@/lib/payments";
import { dodoView, resolveDodoServer } from "@/lib/dodo";
import type { PlanMatrix } from "@/lib/plans";

afterEach(() => {
  cleanup();
  seen.packs = [];
  seen.plans = [];
});

function paddlePricing(environment: PaddleEnvironment): Pricing {
  const paddle = resolvePaddleConfig({
    NEXT_PUBLIC_PADDLE_ENV: environment,
    NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: environment === "sandbox" ? "test_visualqafake0000" : "live_visualqafake0000",
    NEXT_PUBLIC_PADDLE_PRICE_STARTER: "pri_starterpack000001",
  });
  return resolvePricing({ NEXT_PUBLIC_PRICE_DISPLAY_STARTER: "$10" }, paddle);
}
function plans(environment: PaddleEnvironment): PlanMatrix {
  return {
    columns: [{ id: "pro", name: "Pro", monthlyCredits: 6000, isDefault: false, priceId: "pri_proplan0000000001", displayPrice: "$49" }],
    rows: [],
    purchasable: true,
    paddle: { environment, clientToken: environment === "sandbox" ? "test_visualqafake0000" : "live_visualqafake0000" },
  } as PlanMatrix;
}
const dodoTest = dodoView(
  resolveDodoServer({
    DODO_PAYMENTS_API_KEY: "dodo_test_" + "k".repeat(32),
    DODO_PRODUCT_STARTER: "pdt_0NVbdIG3JNg9Yc8ey5JHW",
    DODO_METADATA_SECRET: "cc-metadata-secret-0123456789abcdef-xyz",
  }),
)!;

function renderPricing(pricing: Pricing, matrix: PlanMatrix | null, operator = false) {
  const t = dictionaries.en;
  render(
    <PublicI18nProvider locale="en" t={publicDictionary(t)}>
      <PricingView t={t} locale="en" rates={null} signedIn={operator} pricing={pricing} plans={matrix} operator={operator} />
    </PublicI18nProvider>,
  );
}

describe("the props a visitor's page serialises", () => {
  it("Paddle sandbox: no test flag, no checkout config, closed decided on the server", () => {
    renderPricing(paddlePricing("sandbox"), plans("sandbox"));
    const [packs] = seen.packs;
    const [plan] = seen.plans;
    expect(packs.paddle).toBeNull();
    expect((plan.matrix as PlanMatrix).paddle).toBeNull();
    expect(plan.closed).toBe(true);
    expect(packs.testBadge ?? null).toBeNull();
    expect(plan.testBadge ?? null).toBeNull();
    const source = JSON.stringify([seen.packs, seen.plans.map((p) => ({ ...p, outputs: undefined }))]);
    expect(source).not.toMatch(/testMode|sandbox|test_visualqafake/);
  });

  it("Dodo test mode: the same", () => {
    renderPricing(dodoPricing(dodoTest), null);
    const [packs] = seen.packs;
    expect(packs.paddle ?? null).toBeNull();
    expect(JSON.stringify(seen.packs)).not.toMatch(/testMode|"test"/);
  });

  it("the platform admin's page keeps the checkout config and the badge", () => {
    renderPricing(paddlePricing("sandbox"), plans("sandbox"), true);
    expect((seen.packs[0].paddle as { environment: string }).environment).toBe("sandbox");
    expect(seen.plans[0].closed).toBe(false);
    expect(seen.plans[0].testBadge).toBe(dictionaries.en.pricing.sandbox);
  });

  it("live mode is unchanged: the live checkout config reaches the cards and nothing is closed", () => {
    renderPricing(paddlePricing("production"), plans("production"));
    expect((seen.packs[0].paddle as { environment: string }).environment).toBe("production");
    expect(seen.plans[0].closed).toBe(false);
  });
});
