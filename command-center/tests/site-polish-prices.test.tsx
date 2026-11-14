// @vitest-environment jsdom
/**
 * One price format inside the app as on /pricing (Lens review of PR 733): the Credits page's plan cards printed
 * Paddle's "$19.00" and an owner's "49 USD" as they came, and the Studio's plan dialog the owner's text, beside
 * /pricing's "$19" and "$49"; and a workspace on the default plan read the catalog's English "Free" in every language.
 * Only the text changes: the figures behind a price are the same ones (tests/site-polish.test.tsx pins the formatter).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/credits",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
// Paddle's own preview of the Plus price, as it writes it; nothing is loaded.
vi.mock("@/lib/paddle-client", () => ({
  ensurePaddle: async () => ({}),
  previewPrices: async () => ({ pri_plancreator0001: "$19.00" }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { PlanPanel } from "@/components/credits/PlanPanel";
import { PlanUpsellDialog } from "@/components/studio/PlanUpsellDialog";
import type { BillingSummary, PlanMatrix } from "@/lib/plans";
import type { Refusal, UpsellCatalog } from "@/lib/upsell";

afterEach(cleanup);

const NBSP = " ";

const matrix: PlanMatrix = {
  columns: [
    { id: "free", name: "Free", monthlyCredits: 0, isDefault: true, priceId: null, displayPrice: null },
    { id: "creator", name: "Plus", monthlyCredits: 2000, isDefault: false, priceId: "pri_plancreator0001", displayPrice: null },
    { id: "pro", name: "Pro", monthlyCredits: 6000, isDefault: false, priceId: "pri_planpro00000001", displayPrice: "49 USD" },
    { id: "studio", name: "Business", monthlyCredits: 18000, isDefault: false, priceId: "pri_planstudio00001", displayPrice: "$129.00" },
  ],
  rows: [],
  purchasable: true,
  paddle: { environment: "sandbox", clientToken: "test_visualqafake0000" },
} as PlanMatrix;

const freeSummary: BillingSummary = {
  exempt: false,
  plan: { id: "free", name: "Free", monthlyCredits: 0, isDefault: true },
  subscription: null,
  credits: { subscription: 0, pack: 0, other: 100, held: 0 },
  nextExpiry: null,
  runSlots: { limit: 1, active: 0 },
} as BillingSummary;

function panel(locale: Locale, summary: BillingSummary | null = freeSummary) {
  return render(
    <I18nProvider locale={locale}>
      <PlanPanel summary={summary} matrix={matrix} access="allowed" orgId="org-1" userId="u1" email="me@example.com" />
    </I18nProvider>,
  );
}

const cardPrices = (root: HTMLElement) => [...root.querySelectorAll("li .ns-tc.text-\\[28px\\]")].map((el) => el.textContent);

describe("the Credits page's plan cards", () => {
  it("write Paddle's preview and the owner's display prices as /pricing does, in the page's language", async () => {
    const en = panel("en").container;
    await waitFor(() => expect(cardPrices(en)).toEqual(["$19", "$49", "$129"]));
    cleanup();
    const ru = panel("ru").container;
    await waitFor(() => expect(cardPrices(ru)).toEqual([`19${NBSP}$`, `49${NBSP}$`, `129${NBSP}$`]));
  });

  it.each(["en", "ru", "uz"] as const)("(%s) name the default plan in the page's language, and an unread plan as unknown", (locale) => {
    const t = dictionaries[locale];
    panel(locale);
    const yours = screen.getByText(t.creditsPage.yourPlan).parentElement!;
    expect(within(yours).getByText(t.plans.freeName)).toBeTruthy();
    if (locale !== "en") expect(yours.textContent).not.toContain("Free");
    cleanup();
    // A summary with no plan is not "Free".
    panel(locale, { ...freeSummary, plan: null });
    const unread = screen.getByText(t.creditsPage.yourPlan).parentElement!;
    expect(within(unread).getByText(t.common.unknown)).toBeTruthy();
  });
});

describe("the Studio's plan dialog", () => {
  const data: UpsellCatalog = {
    plans: [
      { id: "creator", name: "Plus", monthlyCredits: 2000, price: "$19.00", values: {} },
      { id: "pro", name: "Pro", monthlyCredits: 6000, price: "49 USD", values: {} },
      { id: "studio", name: "Business", monthlyCredits: 18000, price: "€120", values: {} },
    ],
    keys: [],
    currentPlanId: "free",
    currentMonthlyCredits: 0,
    runLimit: 1,
  };
  const refusal: Refusal = { code: "insufficient_credits", available: 10, needed: 50, active: null, limit: null, detail: null, extraOff: false, extra: null };

  it.each([
    ["en", ["$19", "$49", "€120"]],
    ["ru", [`19${NBSP}$`, `49${NBSP}$`, "€120"]],
  ] as const)("(%s) writes a plan's price as the pricing page does, and anything else exactly as the owner wrote it", (locale, want) => {
    render(
      <I18nProvider locale={locale}>
        <PlanUpsellDialog refusal={refusal} model={null} data={data} onClose={() => {}} />
      </I18nProvider>,
    );
    const cards = within(screen.getByRole("dialog")).getAllByRole("listitem");
    expect(cards.map((c) => c.querySelector(".tnum.font-semibold")?.textContent)).toEqual(want);
  });
});
