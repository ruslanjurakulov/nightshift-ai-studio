// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * The pages when Dodo Payments sells (PAYMENTS_PROVIDER=dodo) and when it does
 * not. What would break without these: /pricing or the landing naming Paddle as
 * the seller while Dodo takes the money (or the reverse), no test badge while
 * Dodo is in test mode, the Buy and Subscribe keys still opening Paddle, or the
 * customer's e-mail Dodo appends to the return URL staying in the address bar.
 */

const h = vi.hoisted(() => ({ assigned: [] as string[], refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/my-channel/credits",
  useRouter: () => ({ push: vi.fn(), refresh: h.refresh, back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (section: string) => `/my-channel${section}` }));
vi.mock("@/components/view-mode/frame-nav", () => ({
  assignTop: (url: string) => {
    h.assigned.push(url);
  },
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { PricingView } from "@/components/pricing/PricingView";
import { Landing } from "@/components/landing/Landing";
import { PlanPanel } from "@/components/credits/PlanPanel";
import { DodoBuyCredits } from "@/components/credits/DodoBuyCredits";
import { dodoPricing, withDodoPlans } from "@/lib/payments";
import { DODO_CATALOG_PLAN_PRICES, dodoView, resolveDodoServer } from "@/lib/dodo";
import { resolvePricing, type Pricing } from "@/lib/pricing";
import { resolvePaddleConfig } from "@/lib/paddle";
import type { BillingSummary, PlanMatrix } from "@/lib/plans";

const t = dictionaries.en;
const DODO_ENV = {
  DODO_PAYMENTS_API_KEY: "dodo_test_" + "k".repeat(32),
  DODO_PRODUCT_STARTER: "pdt_0NVbdIG3JNg9Yc8ey5JHW",
  DODO_PRODUCT_CREATOR: "pdt_CREATORpack0000000000",
  DODO_PRODUCT_STUDIO: "pdt_STUDIOpack00000000000",
  DODO_PLAN_PRO: "pdt_PROplan00000000000000",
  DODO_METADATA_SECRET: "cc-metadata-secret-0123456789abcdef-xyz",
};
const view = dodoView(resolveDodoServer(DODO_ENV))!;
const liveView = { ...view, environment: "live" as const };

const fetchCalls: { url: string; body: unknown }[] = [];
beforeEach(() => {
  h.assigned.length = 0;
  fetchCalls.length = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ url: "https://test.checkout.dodopayments.com/session/cks_1" }), { status: 200 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPricing(pricing: Pricing, operator = false) {
  return render(
    <I18nProvider locale="en">
      <PricingView t={t} locale="en" signedIn={operator} rates={null} plans={null} pricing={pricing} operator={operator} />
    </I18nProvider>,
  );
}

describe("/pricing", () => {
  it("with Dodo: Dodo is the seller, the catalog prices show, and Paddle is not named", () => {
    const { container } = renderPricing(dodoPricing(view));
    const text = container.textContent ?? "";
    expect(text).toContain(t.pricing.dodo.paymentsBody);
    expect(text).toContain(t.pricing.dodo.taxNote);
    // Test mode: a visitor is told purchases open soon; only the platform admin sees the badge (tests/pricing-test-mode).
    expect(text).not.toContain(t.pricing.sandbox);
    expect(text).toContain(t.pricing.purchasesSoon);
    expect(text).toContain("1,000 credits$10");
    expect(text).toContain("20,000 credits$160");
    expect(text).not.toMatch(/Paddle/);
    expect(screen.queryByText(t.pricing.linkBuyerTerms)).toBeNull();
    // Dodo's own buyer terms are linked instead (owner-confirmed URL).
    expect(screen.getByText(t.pricing.dodo.linkBuyerTerms).closest("a")?.getAttribute("href")).toBe("https://dodopayments.com/legal/buyer-terms");
  });

  it("with Dodo in test mode, for the platform admin: the test badge shows", () => {
    const { container } = renderPricing(dodoPricing(view), true);
    expect(container.textContent).toContain(t.pricing.sandbox);
  });

  it("with Dodo live: no test badge, even for the platform admin", () => {
    const { container } = renderPricing(dodoPricing(liveView), true);
    expect(container.textContent).not.toContain(t.pricing.sandbox);
    expect(container.textContent).not.toContain(t.pricing.purchasesSoon);
  });

  it("with Dodo selected but nothing on sale: still names Dodo, never Paddle", () => {
    const { container } = renderPricing(dodoPricing(null, "test"));
    expect(container.textContent).not.toMatch(/Paddle/);
    expect(container.textContent).toContain(t.pricing.dodo.paymentsBody);
  });

  it("with Paddle (the default): exactly Paddle's page, and Dodo is not named", () => {
    const paddle = resolvePaddleConfig({
      NEXT_PUBLIC_PADDLE_ENV: "sandbox",
      NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_visualqafake0000",
      NEXT_PUBLIC_PADDLE_PRICE_STARTER: "pri_starterpack000001",
    });
    const pricing = resolvePricing({ NEXT_PUBLIC_PRICE_DISPLAY_STARTER: "$10" }, paddle);
    expect(pricing).not.toHaveProperty("dodo");
    const { container } = renderPricing(pricing);
    expect(container.textContent).toContain(t.pricing.paymentsBody);
    expect(screen.getByText(t.pricing.linkBuyerTerms)).toBeTruthy();
    expect(container.textContent).not.toMatch(/Dodo/);
  });
});

describe("the landing FAQ", () => {
  const noMoney = { pack: { kind: "none" as const }, api: null, site: null };
  it("names Dodo as the seller when Dodo sells, and Paddle otherwise", () => {
    const refundQ = t.landing.faq.items.find((i) => i.id === "refund")!;
    const dodo = render(<Landing t={t} locale="en" pricing={{ kind: "announced" }} anchor={noMoney} showcase={[]} dodo />);
    expect(dodo.container.textContent).toContain(t.landing.faq.refundDodo);
    expect(dodo.container.textContent).not.toContain(refundQ.a);
    cleanup();
    const paddle = render(<Landing t={t} locale="en" pricing={{ kind: "announced" }} anchor={noMoney} showcase={[]} />);
    expect(paddle.container.textContent).toContain(refundQ.a);
    expect(paddle.container.textContent).not.toContain("Dodo");
  });
});

describe("Credits: buying a pack through Dodo", () => {
  function renderBuy(v = view) {
    return render(
      <I18nProvider locale="en">
        <DodoBuyCredits view={v} balance={100} />
      </I18nProvider>,
    );
  }

  it("Buy asks OUR server for a session by our pack id and goes to Dodo's hosted checkout", async () => {
    renderBuy();
    const keys = screen.getAllByRole("button", { name: new RegExp(t.creditsPage.buy) });
    expect(keys).toHaveLength(3);
    await act(async () => {
      fireEvent.click(keys[0]);
    });
    expect(fetchCalls).toEqual([{ url: "/api/billing/dodo/checkout", body: { kind: "pack", id: "starter", return_path: "/my-channel/credits" } }]);
    expect(h.assigned).toEqual(["https://test.checkout.dodopayments.com/session/cks_1"]);
  });

  it("names Dodo as the Merchant of Record and shows the test badge only in test mode", () => {
    const { container, unmount } = renderBuy();
    expect(container.textContent).toContain(t.credits.buy.merchantDodo);
    expect(container.textContent).toContain(t.creditsPage.testMode);
    expect(container.textContent).not.toMatch(/Paddle/);
    unmount();
    const live = renderBuy(liveView);
    expect(live.container.textContent).not.toContain(t.creditsPage.testMode);
  });

  it("says so when the checkout cannot be opened, and does not navigate", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "checkout_failed" }), { status: 502 }));
    renderBuy();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: new RegExp(t.creditsPage.buy) })[0]);
    });
    expect(screen.getByText(t.creditsPage.loadFailed)).toBeTruthy();
    expect(h.assigned).toEqual([]);
  });
});

describe("Credits: subscribing through Dodo", () => {
  const summary: BillingSummary = {
    exempt: false,
    plan: { id: "free", name: "Free", monthlyCredits: 0, isDefault: true },
    subscription: null,
    credits: { subscription: 0, pack: 0, other: 100, held: 0 },
    nextExpiry: null,
    runSlots: { limit: 1, active: 0 },
  } as BillingSummary;
  const paddleMatrix = {
    columns: [
      { id: "free", name: "Free", monthlyCredits: 0, isDefault: true, priceId: null, displayPrice: null },
      { id: "pro", name: "Pro", monthlyCredits: 6000, isDefault: false, priceId: "pri_proplan0000000001", displayPrice: "49 USD" },
    ],
    rows: [],
    purchasable: true,
    paddle: { environment: "sandbox", clientToken: "test_visualqafake0000" },
  } as unknown as PlanMatrix;

  it("Subscribe asks our server for a Dodo checkout by plan id, never Paddle's overlay", async () => {
    const matrix = withDodoPlans(paddleMatrix, view, DODO_CATALOG_PLAN_PRICES, "en");
    render(
      <I18nProvider locale="en">
        <PlanPanel summary={summary} matrix={matrix} access="allowed" orgId="org-1" userId="u1" email="me@example.com" dodo={view} />
      </I18nProvider>,
    );
    const key = screen.getByRole("button", { name: new RegExp(t.plans.subscribe) });
    expect(key.textContent).toContain("$49");
    await act(async () => {
      fireEvent.click(key);
    });
    expect(fetchCalls).toEqual([{ url: "/api/billing/dodo/checkout", body: { kind: "plan", id: "pro", return_path: "/my-channel/credits" } }]);
    expect(h.assigned).toEqual(["https://test.checkout.dodopayments.com/session/cks_1"]);
  });
});

describe("back from Dodo's checkout", () => {
  it("shows 'payment received' for the pack panel only, and takes Dodo's query (with the e-mail) out of the address bar", async () => {
    vi.resetModules();
    window.history.replaceState(null, "", "/my-channel/credits?dodo=return&item=pack&payment_id=pay_x&status=succeeded&email=buyer%40example.com#topups");
    const { DodoBuyCredits: Fresh } = await import("@/components/credits/DodoBuyCredits");
    const { I18nProvider: FreshProvider } = await import("@/lib/i18n/context");
    await act(async () => {
      render(
        <FreshProvider locale="en">
          <Fresh view={view} balance={100} />
        </FreshProvider>,
      );
    });
    expect(screen.getByText(t.creditsPage.packPaid)).toBeTruthy();
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain("buyer");
    expect(window.location.pathname + window.location.hash).toBe("/my-channel/credits#topups");
  });

  it("a failed payment reads as nothing charged, never as payment received", async () => {
    vi.resetModules();
    window.history.replaceState(null, "", "/my-channel/credits?dodo=return&item=pack&payment_id=pay_x&status=failed");
    const { DodoBuyCredits: Fresh } = await import("@/components/credits/DodoBuyCredits");
    const { I18nProvider: FreshProvider } = await import("@/lib/i18n/context");
    await act(async () => {
      render(
        <FreshProvider locale="en">
          <Fresh view={view} balance={100} />
        </FreshProvider>,
      );
    });
    expect(screen.getByText(t.creditsPage.cancelled)).toBeTruthy();
    expect(screen.queryByText(t.creditsPage.packPaid)).toBeNull();
  });
});
