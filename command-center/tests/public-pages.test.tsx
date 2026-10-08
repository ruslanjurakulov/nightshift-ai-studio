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

const NO_MONEY: MoneyAnchor = { pack: { kind: "none" }, api: null, site: null };

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
  it("has one h1 with the promise and a heading for every section (six blocks in a single column)", () => {
    const t = dictionaries.en;
    const s = t.site;
    renderLanding({ kind: "announced" });
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(`${s.hero.titleA} ${s.hero.titleB}`);
    const showTitles = ["video", "studio", "approvals"].map((id) => s.caps.items.find((i) => i.id === id)!.title);
    for (const title of [s.how.simple.title, ...showTitles, s.try.title, s.pricingTeaser.title, t.landing.faq.title, s.final.title]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    }
    // The rails, the comparison, the who-tabs and the rules block are gone: their headings must not come back.
    for (const gone of [s.who.title, s.rules.title]) expect(screen.queryByRole("heading", { level: 2, name: gone })).toBeNull();
    // How it works is three steps, and the last one is the person's own press.
    const how = screen.getByRole("list", { name: s.how.slug });
    expect(how.tagName).toBe("OL");
    const steps = within(how).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(steps).toEqual(s.how.simple.steps.map((x) => x.title));
    expect(steps).toHaveLength(3);
    expect(s.how.simple.steps[2].id).toBe("approve");
    // The three promises the page keeps sit in the hero.
    const trust = screen.getByRole("list", { name: s.rules.slug });
    expect(within(trust).getAllByRole("listitem").map((li) => li.textContent)).toEqual(s.rules.items.map((r) => r.title));
  });

  it("uses only the labelled example stills for pictures: same-origin, described, and none of them a video or a real result", () => {
    const { container } = renderLanding({ kind: "announced" });
    const imgs = [...container.querySelectorAll("img")];
    // The hero's frame, the three showcases and the closing panel's photograph.
    expect(imgs.length).toBe(5);
    for (const img of imgs) {
      expect(img.getAttribute("data-sample")).toBeTruthy();
      expect(img.getAttribute("src") ?? "").not.toMatch(/^https?:/);
    }
    expect(container.querySelectorAll("video, audio, picture")).toHaveLength(0);
    // The first screen's still is the only eager one.
    expect(imgs.filter((i) => i.getAttribute("loading") === "eager")).toHaveLength(1);
    expect(container.querySelector("figure.nx-chat img")?.getAttribute("loading")).toBe("eager");
  });

  it("shows three capabilities as full-width showcases: a different still each, labelled on the picture and under it, one outlined button (and a pause button on the clips), no drawn product", () => {
    const t = dictionaries.en;
    const { container } = renderLanding({ kind: "announced" });
    const ids = ["video", "studio", "approvals"] as const;
    const stills = new Set<string>();
    for (const id of ids) {
      const item = t.site.caps.items.find((i) => i.id === id)!;
      const section = container.querySelector(`section#${id}.nx-show`) as HTMLElement;
      expect(within(section).getByRole("heading", { level: 2, name: item.title })).toBeTruthy();
      const cta = within(section).getByRole("link", { name: item.cta });
      expect(cta.getAttribute("href")).toMatch(/^\/(signup|solutions\/youtube-channels)$/);
      const img = section.querySelector("img")!;
      stills.add(img.getAttribute("data-sample")!);
      expect(Object.values(t.site.samples.alts)).toContain(img.getAttribute("alt"));
      // A photograph says "stock photo"; a frame of footage says "stock footage". Either way it is credited on the picture.
      expect(section.querySelector(".nx-result-badge")?.textContent).toBe(id === "video" ? t.site.samples.tag : t.site.samples.frameTag);
      expect(section.querySelector(".nx-result-credit")?.textContent).toMatch(/ \/ Pexels$/);
      // The note, and for a card that plays a clip the sentence that says what a moving picture is.
      expect(section.querySelector(".nx-show-note")?.textContent?.startsWith(t.site.samples.note)).toBe(true);
      expect(section.textContent).not.toMatch(MONEY);
      // The words are real text beside the picture (never baked into it), and the only control is the one button.
      // The one link, plus (on the two with a clip) the pause button that stops it: nothing else is a control.
      expect(section.querySelectorAll("a")).toHaveLength(1);
      expect([...section.querySelectorAll("button")].every((b) => b.classList.contains("nx-clip-pause"))).toBe(true);
    }
    expect(stills.size).toBe(3);
  });

  it("draws the hero's product as one labelled example exchange: the ask, an example reply, a real example frame, and a drawn key that is not a button", () => {
    const t = dictionaries.en;
    const { container } = renderLanding({ kind: "announced" });
    const card = container.querySelector("figure.nx-chat") as HTMLElement;
    // The figure's description is there for assistive tech, and the card says it is an example.
    expect(card.getAttribute("aria-label")).toBe(t.site.stage.figure);
    expect(card.querySelector(".nx-demo-tag")?.textContent).toBe(t.site.stage.tag);
    expect(card.textContent).not.toMatch(MONEY);
    // The ask, then a reply that says it is an example reply, never "made a video".
    expect(card.querySelector(".nx-bubble .sr-only")?.textContent).toBe(t.site.caps.items[0].bubble);
    expect(card.querySelector(".nx-reply")?.textContent).toContain(t.site.caps.exampleReply);
    expect(card.querySelector(".nx-reply")?.textContent).not.toContain(t.site.caps.items[0].reply);
    // The frame is a frame of stock footage, described, labelled and credited, and the note that says what the pictures are is printed under the card.
    const img = card.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe(t.site.samples.alts.caravan);
    expect(card.querySelector(".nx-result-badge")?.textContent).toBe(t.site.samples.frameTag);
    expect(card.querySelector(".nx-result-credit")?.textContent).toBe(t.site.samples.credit.video.replace("{name}", "Simeon Stoilov"));
    expect(card.querySelector("figcaption")?.textContent).toBe(`${t.site.samples.note} ${t.site.samples.clipNote}`);
    // Nothing in it is a control: the drawn "Approve and publish" key is a span inside an aria-hidden group.
    expect(card.querySelector("a, button, input, [tabindex]")).toBeNull();
    const key = within(card).getByText(t.site.stage.steps.find((x) => x.id === "approve")!["key" as never] as string);
    expect(key.tagName).toBe("SPAN");
    expect(key.closest("[aria-hidden='true']")).not.toBeNull();
    // The story ends where the page's idea does: you approve, then it is live. The rail shows where this exchange stands.
    expect(t.site.stage.steps.map((x) => x.id)).toEqual(["brief", "plan", "approve", "live"]);
    expect([...card.querySelectorAll(".nx-chat-rail li")].map((li) => li.textContent)).toEqual(t.site.stage.steps.map((x) => x.tab));
    expect(card.querySelector(".nx-chat-rail li[data-current='true']")?.textContent).toBe(t.site.stage.steps[2].tab);
  });

  it("names the welcome grant from WELCOME_CREDITS, and says it is one-time in every language", () => {
    renderLanding({ kind: "announced" });
    expect(screen.getByText(fmt(dictionaries.en.site.hero.note, { n: WELCOME_CREDITS }))).toBeTruthy();
    // The grant is given once (grant_welcome_credits), so the hero must say so, not just "when you sign up".
    expect(dictionaries.en.site.hero.note).toMatch(/once/i);
    expect(dictionaries.ru.site.hero.note).toMatch(/один раз/);
    expect(dictionaries.uz.site.hero.note).toMatch(/bir marta/);
  });

  it("does not let \"You press publish\" stand alone: the FAQ says auto-publish is off unless turned on for a channel", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      const control = dictionaries[locale].landing.faq.items.find((i) => i.id === "control")!;
      expect(control.a).toMatch(locale === "en" ? /Auto-publish is off unless you turn it on for a channel/ : locale === "ru" ? /Автопубликация выключена, пока вы не включите её для канала/ : /Avto-nashr kanal uchun siz yoqmaguningizcha oʻchiq/);
    }
  });

  it("writes the price as a button, not a key, in the site's English copy (API keys are keys)", () => {
    const strings: string[] = [];
    const walk = (n: unknown) => (typeof n === "string" ? strings.push(n) : Array.isArray(n) ? n.forEach(walk) : n && typeof n === "object" ? Object.values(n).forEach(walk) : null);
    walk(dictionaries.en.site);
    for (const s of strings) expect(s).not.toMatch(/\b(?:on the key|the key you press|Generate key|priced key|Approve and publish key)\b/i);
  });

  it("keeps the hero pill to one line in Uzbek (short enough for 390px)", () => {
    expect(dictionaries.uz.site.hero.kicker.length).toBeLessThanOrEqual(40);
  });

  it("tells the truth about sign-up: the email is confirmed by a link, and no card is asked for", () => {
    expect(dictionaries.en.signup.sub).toMatch(/confirm/);
    expect(dictionaries.ru.signup.sub).toMatch(/подтвержд/);
    expect(dictionaries.uz.signup.sub).toMatch(/tasdiqlash/);
    for (const l of ["en", "ru", "uz"] as const) expect(dictionaries[l].signup.sub.length).toBeGreaterThan(20);
  });

  it("opens the refund answer before anyone buys, when a plan is on sale", () => {
    const t = dictionaries.en;
    const { container } = renderLanding({ kind: "plans", plans: [{ id: "creator", name: "Creator", credits: 1500, price: "$12" }] });
    const open = [...container.querySelectorAll("details[open] h3")].map((h) => h.textContent);
    const q = (id: string) => t.landing.faq.items.find((i) => i.id === id)!.q;
    expect(open).toEqual([q("refund")]);
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
    // The pack sizes are captioned as top-ups in plain sight, with the words for "no price yet", and no price check without a published rate.
    expect(screen.getByRole("heading", { level: 3, name: s.pricingTeaser.packsCaption })).toBeTruthy();
    expect(container.textContent).toContain(s.pricingTeaser.leadNoPlans);
    expect(container.textContent).toContain(s.pricingTeaser.sizesBody);
    expect(container.querySelector(".nx-calc")).toBeNull();
  });

  it("anchors the money before sign-up with the published rate and a published pack price, in one block", () => {
    const { container } = renderLanding({ kind: "packs", packs: [{ id: "starter", credits: 1000, price: "$10" }] }, "en", {
      pack: { kind: "priced", id: "starter", credits: 1000, price: "$10" },
      api: { perMinuteCents: 120, minimumCents: 60 },
      site: { perMinute: 60, minimum: 30, usd: { cents: 60, pack: "starter" } },
    });
    const block = container.querySelector("section#pricing")!;
    const text = block.textContent ?? "";
    // The price check (from the published rate) and the pack, side by side; the price of five minutes at the Starter price.
    expect(text).toContain("300 credits");
    expect(text).toContain("≈ $3.00 at the Starter price");
    expect(text).toContain("$10");
    expect(text).toContain("1,000");
    expect(block.querySelector("output")?.textContent).toBe("300 credits");
    // One block, not two: no second "what it costs" panel anywhere on the page.
    expect(container.querySelectorAll("#pricing")).toHaveLength(1);
    expect(container.querySelector(".nx-money, .nx-anchor")).toBeNull();
    expect(screen.getByRole("link", { name: dictionaries.en.site.pricingTeaser.cta }).getAttribute("href")).toBe("/pricing");
    expect(container.textContent).toContain("A video in the app: 60 credits a minute of finished video");
  });

  it("says the one known price above the fold, only when the live price list holds it", () => {
    const priced = renderLanding({ kind: "announced" }, "en", {
      pack: { kind: "none" },
      api: null,
      site: { perMinute: 60, minimum: 30, usd: null },
    });
    const hero = priced.container.querySelector(".nx-hero")!;
    expect(hero.querySelector(".nx-price")?.textContent).toBe("A video in the app: 60 credits a minute of finished video");
    cleanup();
    // No list, no line: the hero never prints a default or a zero.
    const unpriced = renderLanding({ kind: "announced" });
    expect(unpriced.container.querySelector(".nx-hero .nx-price")).toBeNull();
  });

  it("prints exactly the price the data holds", () => {
    const { container } = renderLanding({
      kind: "plans",
      plans: [{ id: "creator", name: "Creator", credits: 1500, price: "$12" }],
    });
    expect(container.textContent).toContain("$12");
    expect(container.textContent).toContain("Creator");
  });

  it("never says credits do not expire when the expiry could not be read (BR-L-100)", () => {
    const t = dictionaries.en;
    const { container } = render(
      <Landing t={t} locale="en" pricing={{ kind: "announced" }} anchor={NO_MONEY} showcase={[]} expiry={{ kind: "unknown" }} />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain(t.pricing.expiryNever);
    expect(text).not.toContain(t.site.packsOnly.unusedNever);
    expect(text).toContain(t.site.packsOnly.unusedUnknown);
  });

  it("renders in Russian and Uzbek from the language switch's dictionary", () => {
    for (const locale of ["ru", "uz"] as const) {
      renderLanding({ kind: "announced" }, locale);
      const hero = dictionaries[locale].site.hero;
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(`${hero.titleA} ${hero.titleB}`);
      expect(document.querySelector("figure.nx-chat")?.getAttribute("aria-label")).toBe(dictionaries[locale].site.stage.figure);
      cleanup();
    }
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
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(t.site.pricingPage.h1);
    for (const title of [t.pricing.termsTitle, t.pricing.howTitle, t.pricing.paymentsTitle, t.pricing.faqTitle]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    }
    // Packs only: the two plan lines (renewal, cancelling) are not shown.
    for (const line of t.pricing.terms.slice(2)) expect(screen.getByText(line)).toBeTruthy();
    for (const q of t.pricing.faq.filter((x) => x.id !== "cancel")) expect(screen.getByRole("heading", { level: 3, name: q.q })).toBeTruthy();
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

  it.each(["en", "ru", "uz"] as const)("says nothing about plans when only packs are on sale (%s)", (locale) => {
    const t = dictionaries[locale];
    const { container } = renderPricing({ pricing: none }, locale);
    const text = container.textContent ?? "";
    for (const planLine of [t.pricing.terms[0], t.pricing.terms[1], t.pricing.ctaNote, t.pricing.packsLead]) expect(text).not.toContain(planLine);
    expect(screen.queryByRole("heading", { level: 3, name: t.pricing.faq.find((q) => q.id === "cancel")!.q })).toBeNull();
    expect(text).toContain(t.site.packsOnly.packsLead);
    cleanup();
    // …and the landing's questions open on refunds, not on cancelling a plan.
    const landing = renderLanding({ kind: "announced" }, locale);
    expect(landing.container.textContent).not.toContain(t.landing.faq.items.find((q) => q.id === "cancel")!.q);
    const open = [...landing.container.querySelectorAll("#faq details[open] h3")].map((h) => h.textContent);
    expect(open).toEqual(t.landing.faq.items.filter((q) => q.id === "refund").map((q) => q.q));
  });

  it("keeps the plan terms when a plan is on sale", () => {
    const t = dictionaries.en;
    const plans = planMatrix(catalog(), { NEXT_PUBLIC_PLAN_DISPLAY_CREATOR: "$12" } as never, null);
    const { container } = renderPricing({ pricing: none, plans });
    expect(container.textContent).toContain(t.pricing.terms[0]);
    expect(screen.getByRole("heading", { level: 3, name: t.pricing.faq.find((q) => q.id === "cancel")!.q })).toBeTruthy();
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
    const { container } = renderPricing({ pricing, plans, signedIn: true, rates, generationRates, expiry: { kind: "months", months: 12 } });
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

describe("the pricing page, product first (round 3)", () => {
  const PRICED_ANCHOR: MoneyAnchor = {
    pack: { kind: "priced", id: "starter", credits: 1000, price: "$10" },
    api: null,
    site: { perMinute: 60, minimum: 10, usd: { cents: 60, pack: "starter" } },
  };

  it("puts the price check in the hero, beside the headline, and says what it costs once", () => {
    const pricing = resolvePricing({ NEXT_PUBLIC_PRICE_DISPLAY_STARTER: "$10" }, null);
    const { container } = renderPricing({ pricing, anchor: PRICED_ANCHOR });
    const hero = container.querySelector(".nx-lit section")!;
    expect(within(hero as HTMLElement).getByRole("slider")).toBeTruthy();
    expect(hero.querySelector("output")?.textContent).toBe("300 credits");
    // The hero's price check carries no second "Start free": the page's own button is the one action there.
    expect(hero.querySelectorAll(".nx-calc a")).toHaveLength(0);
    // No separate price-check section, and no second "What it costs" panel: the price check is the one place, the packs follow it.
    expect(container.querySelector("#price-check")).toBeNull();
    expect(screen.queryByText(dictionaries.en.site.anchor.title)).toBeNull();
    expect(container.querySelector("#packs")).not.toBeNull();
  });

  it("falls back to the promises beside the headline when no rate is published", () => {
    const pricing = resolvePricing({}, null);
    const { container } = renderPricing({ pricing, anchor: NO_MONEY });
    expect(container.querySelector(".nx-lit [role=slider], .nx-lit input[type=range]")).toBeNull();
    expect(container.querySelector(".nx-lit .nx-get")).not.toBeNull();
  });

  it("puts the calculator on the first phone screen and the chat card as the page's picture, with no second rates panel (round 4)", () => {
    const pricing = resolvePricing({ NEXT_PUBLIC_PRICE_DISPLAY_STARTER: "$10" }, null);
    const { container } = renderPricing({ pricing, anchor: PRICED_ANCHOR, rates: { perMinute: 60, jobMinimum: 10 } });
    const hero = container.querySelector(".nx-pr-hero")!;
    // Order inside the hero: the headline, the calculator, then the button (CSS puts them side by side on a desktop).
    const kids = [...hero.children].map((c) => c.className);
    expect(kids).toEqual(["nx-pr-copy", "nx-pr-calc", "nx-pr-actions"]);
    expect(container.querySelectorAll("figure.nx-chat")).toHaveLength(1);
    expect(container.querySelector("figure.nx-chat img")?.getAttribute("data-sample")).toBe("lanterns");
    expect(screen.queryByText(dictionaries.en.pricing.ratesTitle)).toBeNull();
  });
});

