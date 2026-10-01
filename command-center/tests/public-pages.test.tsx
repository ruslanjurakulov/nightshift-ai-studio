// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { Landing } from "@/components/landing/Landing";
import { PricingView } from "@/components/pricing/PricingView";
import { PublicFooter } from "@/components/legal/PublicFooter";
import type { PricingTeaser } from "@/lib/landing";
import { resolvePricing, type Pricing } from "@/lib/pricing";
import { coercePlanCatalog, planMatrix } from "@/lib/plans";

afterEach(cleanup);

/** Anything that reads as a money amount: a currency sign or code next to a digit. */
const MONEY = /[$€£₽]\s?\d|\d\s?(?:USD|EUR|UZS|RUB|so'm|сум)\b/i;

function renderLanding(teaser: PricingTeaser, locale: Locale = "en") {
  const t = dictionaries[locale];
  return render(<Landing t={t} locale={locale} pricing={teaser} showcase={[]} />);
}

function renderPricing(props: Partial<React.ComponentProps<typeof PricingView>> & { pricing: Pricing }, locale: Locale = "en") {
  const t = dictionaries[locale];
  return render(
    <I18nProvider locale={locale}>
      <PricingView t={t} locale={locale} signedIn={false} rates={null} plans={null} {...props} />
    </I18nProvider>,
  );
}

/** A plan catalog as the database would return it (0034 rows). */
function catalog() {
  return coercePlanCatalog(
    [
      { id: "free", name: "Free", sort_order: 0, monthly_credits: 0, is_default: true, is_public: true },
      { id: "creator", name: "Creator", sort_order: 1, monthly_credits: 1500, is_default: false, is_public: true },
    ],
    [{ key: "concurrency", value_type: "int", default_value: 1, exempt_value: 10, status: "enforced", sort_order: 1 }],
    [{ plan_id: "creator", key: "concurrency", value: 3 }],
  );
}

describe("public landing page", () => {
  it("has one h1 with the promise and a heading for every section", () => {
    const t = dictionaries.en;
    renderLanding({ kind: "announced" });
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(t.landing.hero.title);
    for (const title of [t.landing.how.title, t.landing.features.title, t.landing.why.title, t.landing.pricing.title, t.landing.faq.title]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    }
    // How it works is three steps; the five features each have their own heading.
    const how = screen.getByRole("heading", { level: 2, name: t.landing.how.title }).closest("section")!;
    expect(within(how).getAllByRole("listitem")).toHaveLength(3);
    const features = screen.getByRole("heading", { level: 2, name: t.landing.features.title }).closest("section")!;
    for (const f of t.landing.features.items) expect(within(features).getByRole("heading", { level: 3, name: f.title })).toBeTruthy();
  });

  it("sends the primary call to action to sign-up and the secondary to pricing", () => {
    const t = dictionaries.en;
    renderLanding({ kind: "announced" });
    const primary = screen.getAllByRole("link", { name: t.landing.hero.ctaPrimary });
    expect(primary.length).toBeGreaterThan(0);
    for (const a of primary) expect(a.getAttribute("href")).toBe("/signup");
    const secondary = screen.getAllByRole("link", { name: t.landing.hero.ctaSecondary });
    for (const a of secondary) expect(a.getAttribute("href")).toBe("/pricing");
  });

  it("shows the product picture as one labelled image, with no figures in it", () => {
    const t = dictionaries.en;
    renderLanding({ kind: "announced" });
    const img = screen.getByRole("img", { name: t.landing.mock.label });
    expect(img.textContent).not.toMatch(MONEY);
    expect(img.querySelector("a, button, input, [tabindex]")).toBeNull();
  });

  it("prints no price when none is configured", () => {
    const { container } = renderLanding({ kind: "announced" });
    expect(container.textContent).not.toMatch(MONEY);
    expect(container.textContent).toContain(dictionaries.en.landing.pricing.announcedTitle);
  });

  it("prints exactly the price the data holds", () => {
    const { container } = renderLanding({
      kind: "plans",
      plans: [{ id: "creator", name: "Creator", credits: 1500, price: "$12" }],
    });
    expect(container.textContent).toContain("$12");
    expect(container.textContent).toContain("Creator");
  });

  it("renders in Russian and Uzbek from the language switch's dictionary", () => {
    for (const locale of ["ru", "uz"] as const) {
      renderLanding({ kind: "announced" }, locale);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(dictionaries[locale].landing.hero.title);
      cleanup();
    }
  });

  it("compares against typical tools as a real table with row headers", () => {
    const t = dictionaries.en;
    renderLanding({ kind: "announced" });
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("rowheader")).toHaveLength(t.landing.why.rows.length);
    expect(within(table).getAllByRole("columnheader").map((c) => c.textContent)).toEqual([
      t.landing.why.topic,
      t.landing.why.typical,
      t.landing.why.ours,
    ]);
  });
});

describe("public pricing page", () => {
  const none = resolvePricing({}, null);

  it("has its headings, the terms and the questions", () => {
    const t = dictionaries.en;
    renderPricing({ pricing: none });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(t.pricing.title);
    for (const title of [t.pricing.termsTitle, t.pricing.howTitle, t.pricing.paymentsTitle, t.pricing.faqTitle]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    }
    for (const line of t.pricing.terms) expect(screen.getByText(line)).toBeTruthy();
    for (const q of t.pricing.faq) expect(screen.getByRole("heading", { level: 3, name: q.q })).toBeTruthy();
  });

  it("sends a signed-out visitor to sign-up, and a signed-in one to Credits", () => {
    const t = dictionaries.en;
    renderPricing({ pricing: none });
    for (const a of screen.getAllByRole("link", { name: t.pricing.ctaSignedOut })) expect(a.getAttribute("href")).toBe("/signup");
    cleanup();
    renderPricing({ pricing: none, signedIn: true });
    for (const a of screen.getAllByRole("link", { name: t.pricing.ctaSignedIn })) expect(a.getAttribute("href")).toMatch(/\/credits$/);
  });

  it("prints no price when nothing is configured", () => {
    const { container } = renderPricing({ pricing: none });
    expect(container.textContent).not.toMatch(MONEY);
    expect(container.textContent).toContain(dictionaries.en.pricing.comingSoonTitle);
  });

  it("shows plan and pack prices only from the data it is given", () => {
    const plans = planMatrix(catalog(), { NEXT_PUBLIC_PLAN_DISPLAY_CREATOR: "$12" }, null);
    const pricing = resolvePricing({ NEXT_PUBLIC_PRICE_DISPLAY_STARTER: "$5" }, null);
    const { container } = renderPricing({ pricing, plans });
    const text = container.textContent ?? "";
    expect(text).toContain("$12");
    expect(text).toContain("$5");
    // Nothing else that looks like money.
    expect(text.replace("$12", "").replace("$5", "")).not.toMatch(MONEY);
    // Monthly credits come from the catalog, formatted.
    expect(text).toContain("1,500");
  });

  it("says plans could not be read instead of showing none", () => {
    renderPricing({ pricing: none, plansFailed: true });
    expect(screen.getByText(dictionaries.en.plans.readFailed)).toBeTruthy();
  });
});

describe("public footer", () => {
  it("links Pricing, Privacy, Terms and Contact", () => {
    const t = dictionaries.en;
    render(<PublicFooter t={t} />);
    expect(screen.getAllByRole("link", { name: t.legal.pricing })[0].getAttribute("href")).toBe("/pricing");
    expect(screen.getByRole("link", { name: t.legal.privacy }).getAttribute("href")).toBe("/privacy");
    expect(screen.getByRole("link", { name: t.legal.terms }).getAttribute("href")).toBe("/terms");
    const contact = screen.getByRole("link", { name: t.landing.footer.contact }).getAttribute("href") ?? "";
    expect(contact === "/terms#contact" || contact.startsWith("mailto:")).toBe(true);
  });
});
