/**
 * One filled key per view (docs/design/app-redesign-1/FOUNDATION.md rule 4), on the Credits page of a customer who is
 * offered both packs and plans: the balance's "Get more credits" is the one filled key, and every purchase key below it
 * (each pack, each plan) is the same PriceButton drawn outlined. Handlers and conditions are unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/x/credits" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});

vi.mock("@/lib/i18n/public-context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});

import { BalanceHero } from "@/components/credits/BalanceHero";
import { BuyCredits } from "@/components/credits/BuyCredits";
import { PlanPanel } from "@/components/credits/PlanPanel";
import { PriceButton } from "@/components/ui/PriceButton";
import type { BalanceSplit, BillingSummary, PlanMatrix } from "@/lib/plans";

const split: BalanceSplit = { available: 1180, held: 180, total: 1360, sources: [{ source: "plan", credits: 580, expiresAt: null }] } as BalanceSplit;
const summary: BillingSummary = {
  exempt: false,
  plan: { id: "creator", name: "Creator", monthlyCredits: 2000, isDefault: false },
  subscription: { planId: "creator", status: "active", periodEnd: null, cancelAtPeriodEnd: false, manageable: true, live: true },
  credits: { subscription: 580, pack: 500, other: 100, held: 180 },
  nextExpiry: null,
  runSlots: { limit: 2, active: 0 },
};
const matrix: PlanMatrix = {
  columns: [
    { id: "creator", name: "Creator", monthlyCredits: 2000, isDefault: false, priceId: "pri_creatorplan000001", displayPrice: "$20" },
    { id: "pro", name: "Pro", monthlyCredits: 6000, isDefault: false, priceId: "pri_proplan0000000001", displayPrice: "$50" },
    { id: "studio", name: "Business", monthlyCredits: 20000, isDefault: false, priceId: "pri_studioplan00000001", displayPrice: "$120" },
  ],
  rows: [],
  purchasable: true,
  paddle: { environment: "sandbox", clientToken: "test_visualqafake0000" },
} as PlanMatrix;
const config = {
  environment: "sandbox" as const,
  clientToken: "test_visualqafake0000",
  packs: [
    { id: "starter", credits: 1000, priceId: "pri_starterpack000001" },
    { id: "creator", credits: 4000, priceId: "pri_creatorpack000001" },
    { id: "studio", credits: 12000, priceId: "pri_studiopack0000001" },
  ],
} as never;

// A PriceButton is filled unless it carries data-tone="quiet": count them from the element, not the class alone.
const filledPrice = (html: string) => [...html.matchAll(/<button[^>]*class="ns-price-button[^"]*"[^>]*>/g)].filter((m) => !m[0].includes('data-tone="quiet"')).length;
const filledLinks = (html: string) => [...html.matchAll(/<a[^>]*class="[^"]*btn-primary[^"]*"[^>]*>/g)].length;

describe("Credits with packs and plans on offer: one filled key", () => {
  const hero = renderToStaticMarkup(<BalanceHero split={split} rates={null} offers={{ plans: true, packs: true }} />);
  const packs = renderToStaticMarkup(
    <BuyCredits config={config} orgId="org-1" userId="u1" email="me@example.com" balance={1180} />,
  );
  const plans = renderToStaticMarkup(
    <PlanPanel summary={summary} matrix={matrix} access="allowed" orgId="org-1" userId="u1" email="me@example.com" />,
  );

  it("the balance holds the only filled key; its second offer is quiet", () => {
    expect(filledLinks(hero)).toBe(1);
    expect(hero).toMatch(/href="#topups"[^>]*class="[^"]*btn-primary/);
    expect(hero).toMatch(/href="#plans"[^>]*class="[^"]*btn-quiet/);
  });

  it("every pack's buy key and every plan's subscribe key is outlined, price and handler intact", () => {
    expect(filledPrice(packs)).toBe(0);
    expect(filledPrice(plans)).toBe(0);
    expect((packs.match(/data-tone="quiet"/g) ?? []).length).toBe(3);
    // Creator is the current plan: it is not offered again, the other two are.
    expect((plans.match(/data-tone="quiet"/g) ?? []).length).toBe(2);
    // The price legend is still drawn on each key (a pack with no quote says so in words instead).
    expect(packs).toContain("ns-price-label");
  });

  it("the whole view has exactly one filled key", () => {
    const all = hero + packs + plans;
    expect(filledLinks(all) + filledPrice(all)).toBe(1);
  });

  it("PriceButton stays filled by default (other pages keep their one key)", () => {
    const html = renderToStaticMarkup(<PriceButton label="Make" credits={5} />);
    expect(html).not.toContain('data-tone="quiet"');
    expect(renderToStaticMarkup(<PriceButton label="Make" credits={5} tone="quiet" />)).toContain('data-tone="quiet"');
  });
});
