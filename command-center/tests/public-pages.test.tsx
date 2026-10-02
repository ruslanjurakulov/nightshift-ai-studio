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
import { dictionaries, fmt, type Locale } from "@/lib/i18n";
import { Landing } from "@/components/landing/Landing";
import { PricingView } from "@/components/pricing/PricingView";
import { PublicFooter } from "@/components/legal/PublicFooter";
import type { MoneyAnchor, PricingTeaser } from "@/lib/landing";
import { WELCOME_CREDITS, resolvePricing, type Pricing } from "@/lib/pricing";
import { coercePlanCatalog, creditEquivalents, planMatrix, type GenerationRates } from "@/lib/plans";
import { PROVIDER_BRANDS } from "./helpers/brands";

afterEach(cleanup);

/** Anything that reads as a money amount: a currency sign or code next to a digit. */
const MONEY = /[$€£₽]\s?\d|\d\s?(?:USD|EUR|UZS|RUB|so'm|сум)\b/i;

const NO_MONEY: MoneyAnchor = { pack: { kind: "none" }, api: null };

function renderLanding(teaser: PricingTeaser, locale: Locale = "en", anchor: MoneyAnchor = NO_MONEY) {
  const t = dictionaries[locale];
  return render(<Landing t={t} locale={locale} pricing={teaser} anchor={anchor} showcase={[]} />);
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
    const s = t.site;
    renderLanding({ kind: "announced" });
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(`${s.hero.titleA} ${s.hero.titleB}`);
    for (const title of [s.rules.title, s.how.title, s.studio.title, s.desk.title, s.solutionsTeaser.title, s.pricingTeaser.title, t.landing.faq.title, s.final.title]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    }
    // How a video moves is the six-step flow, ending with your approval and YouTube.
    const how = screen.getByRole("list", { name: s.how.slug });
    expect(how.tagName).toBe("OL");
    const steps = within(how).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(steps).toEqual(s.how.steps.map((x) => x.title));
    expect(steps.slice(-2)).toEqual([s.how.steps[4].title, s.how.steps[5].title]);
    // Every rule the product keeps has its own heading.
    const rules = screen.getByRole("heading", { level: 2, name: s.rules.title }).closest("section")!;
    for (const r of s.rules.items) expect(within(rules).getByRole("heading", { level: 3, name: r.title })).toBeTruthy();
  });

  it("shows every Studio tool, and draws the editor instead of shipping an image", () => {
    const t = dictionaries.en;
    renderLanding({ kind: "announced" });
    const studio = screen.getByRole("heading", { level: 2, name: t.site.studio.title }).closest("section")!;
    const tools = screen.getByRole("list", { name: t.site.studio.slug });
    expect(within(tools).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(t.site.studio.tools.map((x) => x.title));
    // Each row says how it is paid for: the editor and the style library spend nothing.
    const cost = within(tools).getAllByRole("listitem").map((li) => li.querySelector(".st-patch-cost, .sr-only")?.textContent);
    expect(cost).toEqual(t.site.studio.tools.map((x) => (x.id === "editor" || x.id === "styles" ? t.site.studio.free : t.site.studio.priced)));
    expect(studio.querySelector("img")).toBeNull();
    expect(within(studio).getByRole("img", { name: t.site.studio.editor.figure })).toBeTruthy();
  });

  it("draws the hero rundown as one labelled example, with nothing to press and no money in it", () => {
    const t = dictionaries.en;
    renderLanding({ kind: "announced" });
    const img = screen.getByRole("img", { name: t.site.rundown.figure });
    expect(img.textContent).toContain(t.site.rundown.tag);
    expect(img.textContent).not.toMatch(MONEY);
    expect(img.querySelector("a, button, input, [tabindex]")).toBeNull();
    // The rows are the same channel → YouTube flow, and the only lit row is your approval.
    const rows = [...img.querySelectorAll("li")];
    expect(rows).toHaveLength(t.site.rundown.rows.length);
    expect(rows.filter((r) => r.getAttribute("data-state") === "yours").map((r) => r.textContent)).toEqual([
      expect.stringContaining(t.site.rundown.rows.find((r) => r.id === "approval")!.name),
    ]);
  });

  it("names the welcome grant from WELCOME_CREDITS, once on sign-up", () => {
    renderLanding({ kind: "announced" });
    expect(screen.getByText(fmt(dictionaries.en.site.hero.note, { n: WELCOME_CREDITS }))).toBeTruthy();
  });

  it("opens the cancelling and refund answers before anyone buys", () => {
    const t = dictionaries.en;
    const { container } = renderLanding({ kind: "announced" });
    const open = [...container.querySelectorAll("details[open] h3")].map((h) => h.textContent);
    const q = (id: string) => t.landing.faq.items.find((i) => i.id === id)!.q;
    expect(open).toEqual([q("cancel"), q("refund")]);
  });

  it("sends the primary call to action to sign-up and the secondary to pricing", () => {
    const t = dictionaries.en;
    renderLanding({ kind: "announced" });
    const primary = screen.getAllByRole("link", { name: t.site.hero.cta });
    expect(primary.length).toBeGreaterThan(0);
    for (const a of primary) expect(a.getAttribute("href")).toBe("/signup");
    const secondary = screen.getAllByRole("link", { name: t.site.hero.secondary });
    for (const a of secondary) expect(a.getAttribute("href")).toBe("/pricing");
  });

  it("prints no price when none is configured, and says so in words", () => {
    const { container } = renderLanding({ kind: "announced" });
    const s = dictionaries.en.site;
    expect(container.textContent).not.toMatch(MONEY);
    expect(screen.getAllByText(s.anchor.none).length).toBe(2);
    expect(container.textContent).toContain(s.anchor.noneNote);
    // The pack sizes are captioned as top-ups in plain sight, not only for screen readers.
    expect(screen.getByRole("heading", { level: 3, name: s.pricingTeaser.packsCaption })).toBeTruthy();
    expect(container.textContent).toContain(s.pricingTeaser.leadNoPlans);
  });

  it("anchors the money before sign-up with the live API price list and a published pack price", () => {
    const { container } = renderLanding({ kind: "packs", packs: [{ id: "starter", credits: 1000, price: "$10" }] }, "en", {
      pack: { kind: "priced", id: "starter", credits: 1000, price: "$10" },
      api: { perMinuteCents: 120, minimumCents: 60 },
    });
    const text = container.textContent ?? "";
    expect(text).toContain("$10 for 1,000 credits");
    expect(text).toContain("$1.20 a minute of video");
    expect(text).toContain("at least $0.60 a video");
    expect(screen.getByRole("link", { name: dictionaries.en.site.anchor.apiSource }).getAttribute("href")).toBe("/docs/api#pricing");
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
      const hero = dictionaries[locale].site.hero;
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(`${hero.titleA} ${hero.titleB}`);
      expect(screen.getByRole("img", { name: dictionaries[locale].site.rundown.figure })).toBeTruthy();
      cleanup();
    }
  });

  it("lights the refund ledger's failure in red and its return in green, with the words beside the lamps", () => {
    const t = dictionaries.en;
    renderLanding({ kind: "announced" });
    const refund = t.site.rules.items.find((r) => r.id === "refund")!;
    const ledger = screen.getByRole("list", { name: refund.title });
    const lamps = [...ledger.querySelectorAll(".ns-lamp")].map((l) => l.getAttribute("data-tone"));
    expect(lamps).toEqual(["ok", "fail", "ok"]);
    expect(within(ledger).getAllByRole("listitem").map((li) => li.textContent)).toEqual(refund.lines);
  });

  it.each(["en", "ru", "uz"] as const)("names no AI provider or competitor anywhere on the page (%s)", (locale) => {
    const { container } = renderLanding({ kind: "announced" }, locale);
    expect(container.textContent).not.toMatch(PROVIDER_BRANDS);
    expect(container.innerHTML).not.toMatch(PROVIDER_BRANDS);
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
    expect(screen.getByRole("heading", { level: 2, name: dictionaries.en.site.anchor.title })).toBeTruthy();
  });

  it("does not ask the visitor to pick a monthly plan when none is on sale", () => {
    const t = dictionaries.en;
    const { container } = renderPricing({ pricing: none });
    expect(container.textContent).not.toContain(t.pricing.lead);
    expect(container.textContent).toContain(t.site.pricingPage.leadNoPlans);
    cleanup();
    const plans = planMatrix(catalog(), { NEXT_PUBLIC_PLAN_DISPLAY_CREATOR: "$12" } as never, null);
    const withPlans = renderPricing({ pricing: none, plans });
    expect(withPlans.container.textContent).toContain(t.pricing.lead);
  });

  it("shows plan and pack prices only from the data it is given", () => {
    const plans = planMatrix(catalog(), { NEXT_PUBLIC_PLAN_DISPLAY_CREATOR: "$12" }, null);
    const pricing = resolvePricing({ NEXT_PUBLIC_PRICE_DISPLAY_STARTER: "$5" }, null);
    const { container } = renderPricing({ pricing, plans });
    const text = container.textContent ?? "";
    expect(text).toContain("$12");
    expect(text).toContain("$5");
    // Nothing else that looks like money.
    expect(text.replaceAll("$12", "").replaceAll("$5", "")).not.toMatch(MONEY);
    // Monthly credits come from the catalog, formatted.
    expect(text).toContain("1,500");
  });

  it.each(["en", "ru", "uz"] as const)("names the Merchant of Record exactly once (%s)", (locale) => {
    const plans = planMatrix(catalog(), { NEXT_PUBLIC_PLAN_DISPLAY_CREATOR: "$12" }, null);
    const pricing = resolvePricing({ NEXT_PUBLIC_PRICE_DISPLAY_STARTER: "$5" }, null);
    for (const signedIn of [false, true]) {
      const { container } = renderPricing({ pricing, plans, signedIn }, locale);
      // Closed <details> answers are in the HTML too, so count the markup, not what is visible.
      expect(container.innerHTML.match(/Merchant of Record/g)?.length).toBe(1);
      cleanup();
    }
  });

  it.each(["en", "ru", "uz"] as const)("names no AI provider or competitor anywhere on the page (%s)", (locale) => {
    const plans = planMatrix(catalog(), { NEXT_PUBLIC_PLAN_DISPLAY_CREATOR: "$12" }, null);
    const pricing = resolvePricing({ NEXT_PUBLIC_PRICE_DISPLAY_STARTER: "$5" }, null);
    const { container } = renderPricing({ pricing, plans }, locale);
    expect(container.innerHTML).not.toMatch(PROVIDER_BRANDS);
  });

  it("shows no Monthly / Yearly switch, because the plan data holds monthly prices only", () => {
    const plans = planMatrix(catalog(), { NEXT_PUBLIC_PLAN_DISPLAY_CREATOR: "$12" }, null);
    renderPricing({ pricing: none, plans });
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(/yearly|annual/i)).toBeNull();
  });

  it("compares the plans in a real table built from the catalog's enforced limits", () => {
    const t = dictionaries.en;
    const plans = planMatrix(catalog(), { NEXT_PUBLIC_PLAN_DISPLAY_CREATOR: "$12" }, null)!;
    renderPricing({ pricing: none, plans });
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((c) => c.textContent)).toEqual([t.pricing.compareFeature, "Free", "Creator"]);
    expect(within(table).getAllByRole("rowheader").map((c) => c.textContent)).toEqual([
      t.pricing.compareCredits,
      t.plans.row.concurrency,
    ]);
    expect(table.textContent).toContain("3 at once");
  });

  it("prints only numbers that come from the data it is given", () => {
    const plans = planMatrix(catalog(), { NEXT_PUBLIC_PLAN_DISPLAY_CREATOR: "$12" }, null)!;
    const pricing = resolvePricing({ NEXT_PUBLIC_PRICE_DISPLAY_STARTER: "$5" }, null);
    const rates = { perMinute: 25, jobMinimum: 30 };
    const generationRates: GenerationRates = { image: 4, shortVideo: { credits: 40, seconds: 5 }, videoMinute: 25 };
    const { container } = renderPricing({ pricing, plans, signedIn: true, rates, generationRates, packValidMonths: 12 });
    const text = container.textContent ?? "";

    // Every figure the page was handed, and every figure derived from them.
    const allowed = new Set<number>([12, 5, WELCOME_CREDITS, 25, 30, 4, 40]);
    for (const c of plans.columns) allowed.add(c.monthlyCredits);
    for (const r of plans.rows) for (const v of r.cells) if (typeof v === "number") allowed.add(v);
    for (const pk of pricing.packs) allowed.add(pk.credits);
    for (const credits of [WELCOME_CREDITS, ...plans.columns.map((c) => c.monthlyCredits), ...pricing.packs.map((pk) => pk.credits)]) {
      const eq = creditEquivalents(credits, generationRates);
      if (!eq) continue;
      if (eq.images !== null) allowed.add(eq.images);
      if (eq.videos) allowed.add(eq.videos.count).add(eq.videos.seconds);
      if (eq.minutes !== null) allowed.add(eq.minutes);
    }
    const shown = [...text.matchAll(/\d[\d,]*/g)].map((m) => Number(m[0].replace(/,/g, "")));
    expect(shown.length).toBeGreaterThan(0);
    for (const n of shown) expect(allowed, `unexpected number ${n} on the page`).toContain(n);
    // And the equivalents really are there, computed from the given prices.
    expect(text).toContain("≈ 375 images");
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
