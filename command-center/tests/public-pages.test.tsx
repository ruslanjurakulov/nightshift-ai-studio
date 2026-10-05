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
  it("has one h1 with the promise and a heading for every section", () => {
    const t = dictionaries.en;
    const s = t.site;
    renderLanding({ kind: "announced" });
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(`${s.hero.titleA} ${s.hero.titleB}`);
    for (const title of [s.how.simple.title, ...s.caps.items.map((i) => i.title), s.who.title, s.rules.title, s.pricingTeaser.title, t.landing.faq.title, s.final.title]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    }
    // How it works is three steps, and the last one is the person's own press.
    const how = screen.getByRole("list", { name: s.how.slug });
    expect(how.tagName).toBe("OL");
    const steps = within(how).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(steps).toEqual(s.how.simple.steps.map((x) => x.title));
    expect(steps).toHaveLength(3);
    expect(s.how.simple.steps[2].id).toBe("approve");
    // Who it is for: one tab per solutions page; every panel (open or not) links to its page, and the index is one link away.
    const who = screen.getByRole("heading", { level: 2, name: s.who.title }).closest("section")!;
    expect(within(who).getAllByRole("tab").map((x) => x.textContent)).toEqual(expect.arrayContaining(s.who.items.map((i) => expect.stringContaining(i.title))));
    expect([...who.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"))).toEqual([...s.who.items.map((i) => `/solutions/${i.id}`), "/solutions"]);
    // Every rule the product keeps has its own heading.
    const rules = screen.getByRole("heading", { level: 2, name: s.rules.title }).closest("section")!;
    for (const r of s.rules.items) expect(within(rules).getByRole("heading", { level: 3, name: r.title })).toBeTruthy();
  });

  it("shows every Studio tool with how it is paid for, and draws every example instead of shipping a picture", () => {
    const t = dictionaries.en;
    const { container } = renderLanding({ kind: "announced" });
    const studio = screen.getByRole("heading", { level: 2, name: t.site.caps.items.find((i) => i.id === "studio")!.title }).closest("section")!;
    const tools = within(studio).getByRole("list", { name: t.site.studio.slug });
    expect(within(tools).getAllByRole("listitem").map((li) => li.querySelector("span:not(.sr-only):not(.nx-tool-free)")?.textContent)).toEqual(t.site.studio.tools.map((x) => x.title));
    // Each tool says how it is paid for: the editor and the style library spend nothing.
    const cost = within(tools).getAllByRole("listitem").map((li) => li.querySelector(".nx-tool-free, .sr-only")?.textContent);
    expect(cost).toEqual(t.site.studio.tools.map((x) => (x.id === "editor" || x.id === "styles" ? t.site.studio.free : t.site.studio.priced)));
    // The only images are the real app screenshots and the labelled example frames (decorative inside a hidden picture; same-origin files).
    for (const img of container.querySelectorAll("img")) {
      expect(img.closest("figure.st-shot") !== null || img.classList.contains("nx-art")).toBe(true);
      expect(img.getAttribute("src") ?? "").not.toMatch(/^https?:/);
    }
  });

  it("shows each capability as one labelled example: what you ask for, what comes back, and a note that it is an example", () => {
    const t = dictionaries.en;
    const { container } = renderLanding({ kind: "announced" });
    expect(t.site.caps.items.map((i) => i.id)).toEqual(["video", "voice", "studio", "channels", "approvals"]);
    for (const item of t.site.caps.items) {
      const section = container.querySelector(`#${item.id}`)!;
      expect(within(section as HTMLElement).getByRole("heading", { level: 2, name: item.title })).toBeTruthy();
      // One button per section, in plain words, going somewhere real.
      const cta = within(section as HTMLElement).getByRole("link", { name: item.cta });
      expect(cta.getAttribute("href")).toMatch(/^\/(signup|solutions\/youtube-channels)$/);
      const demo = section.querySelector("figure.nx-demo")!;
      expect(demo.getAttribute("aria-label")).toContain(t.site.caps.demo);
      expect(demo.textContent).toContain(item.bubble);
      // Over an example still the reply says "example reply", never "made a video"; the AI-still note is printed beside it.
      const stillBacked = demo.querySelector("img") !== null;
      expect(demo.textContent).toContain(stillBacked ? t.site.caps.exampleReply : item.reply);
      if (stillBacked) {
        expect(demo.textContent).not.toContain(item.reply);
        expect(demo.querySelector("figcaption")?.textContent).toBe(t.site.samples.note);
      }
      expect(demo.textContent).toContain(t.site.caps.tag);
      expect(demo.textContent).not.toMatch(MONEY);
      expect(demo.querySelector("a, button, input, [tabindex]")).toBeNull();
    }
    // The approvals card is the Solutions page's own sign-off wording.
    const approvals = container.querySelector("#approvals")!;
    expect(approvals.textContent).toContain(t.site.solutions.pictures.signoff.second);
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
    expect(card.querySelector(".nx-bubble")?.textContent).toBe(t.site.caps.items[0].bubble);
    expect(card.querySelector(".nx-reply")?.textContent).toContain(t.site.caps.exampleReply);
    expect(card.querySelector(".nx-reply")?.textContent).not.toContain(t.site.caps.items[0].reply);
    // The frame is one of the example stills, described, labelled, and the AI-generated note is printed under the card.
    const img = card.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe(t.site.samples.alts.silkroad);
    expect(card.querySelector(".nx-result-badge")?.textContent).toBe(t.site.samples.tag);
    expect(card.querySelector("figcaption")?.textContent).toBe(t.site.samples.note);
    // Nothing in it is a control: the drawn "Approve and publish" key is a span inside an aria-hidden group.
    expect(card.querySelector("a, button, input, [tabindex]")).toBeNull();
    const key = within(card).getByText(t.site.stage.steps.find((x) => x.id === "approve")!["key" as never] as string);
    expect(key.tagName).toBe("SPAN");
    expect(key.closest("[aria-hidden='true']")).not.toBeNull();
    // The story ends where the page's idea does: you approve, then it is live. The rail shows where this exchange stands.
    expect(t.site.stage.steps.map((x) => x.id)).toEqual(["brief", "plan", "approve", "live"]);
    expect([...card.querySelectorAll(".nx-chat-rail li")].map((li) => li.textContent)).toEqual(t.site.stage.steps.map((x) => x.tab));
    expect(card.querySelector(".nx-chat-rail li[aria-current='step']")?.textContent).toBe(t.site.stage.steps[2].tab);
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

  it("opens the cancelling and refund answers before anyone buys, when a plan is on sale", () => {
    const t = dictionaries.en;
    const { container } = renderLanding({ kind: "plans", plans: [{ id: "creator", name: "Creator", credits: 1500, price: "$12" }] });
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
    // Pack, a video in the app, a video through the API: each said in words.
    expect(screen.getAllByText(s.anchor.none).length).toBe(3);
    expect(container.textContent).toContain(s.anchor.noneNote);
    // The pack sizes are captioned as top-ups in plain sight, not only for screen readers.
    expect(screen.getByRole("heading", { level: 3, name: s.pricingTeaser.packsCaption })).toBeTruthy();
    expect(container.textContent).toContain(s.pricingTeaser.leadNoPlans);
  });

  it("anchors the money before sign-up with the live API price list and a published pack price", () => {
    const { container } = renderLanding({ kind: "packs", packs: [{ id: "starter", credits: 1000, price: "$10" }] }, "en", {
      pack: { kind: "priced", id: "starter", credits: 1000, price: "$10" },
      api: { perMinuteCents: 120, minimumCents: 60 },
      site: { perMinute: 60, minimum: 30, usd: { cents: 60, pack: "starter" } },
    });
    const text = container.textContent ?? "";
    expect(text).toContain("$10 for 1,000 credits");
    // What a video costs in the app, from the live list — and in dollars at the pack's price.
    expect(text).toContain("60 credits a minute of finished video");
    expect(text).toContain("at least 30 credits a run");
    expect(text).toContain("≈ $0.60 a minute at the Starter price");
    expect(text).toContain("$1.20 a minute of video");
    expect(text).toContain("at least $0.60 a video");
    expect(screen.getByRole("link", { name: dictionaries.en.site.anchor.apiSource }).getAttribute("href")).toBe("/docs/api#pricing");
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

  it("shows the approval on a real screenshot, labelled as one, with sample data said plainly (PIXEL-3)", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      const { container } = renderLanding({ kind: "announced" }, locale);
      const h = dictionaries[locale].site.how;
      // One figure, beside the steps: the page the third step ends on.
      const figures = Array.from(container.querySelectorAll("figure.st-shot"));
      expect(figures).toHaveLength(1);
      expect(figures[0].closest("#how")).not.toBeNull();
      const imgs = Array.from(figures[0].querySelectorAll("img"));
      // Light and dark, desktop and phone captures, all described in the page's language.
      expect(imgs.map((i) => `${i.getAttribute("data-shot-theme")}-${i.getAttribute("data-shot-size")}`)).toEqual([
        "light-desk",
        "light-phone",
        "dark-desk",
        "dark-phone",
      ]);
      for (const img of imgs) expect(img.getAttribute("alt")).toBe(h.shotAlt);
      const caption = container.querySelector("figure.st-shot figcaption")?.textContent ?? "";
      expect(caption).toContain(h.shotTag);
      expect(caption).toContain(h.shotCaption);
      // PIXEL-4 D4: the balance and the account on screen are sample data too, and the caption says so.
      expect(h.shotCaption).toMatch(locale === "en" ? /sample data/ : locale === "ru" ? /пример/ : /namuna/);
      cleanup();
    }
  });

  it("never says credits do not expire when the expiry could not be read (BR-L-100)", () => {
    const t = dictionaries.en;
    const { container } = render(
      <Landing t={t} locale="en" pricing={{ kind: "announced" }} anchor={NO_MONEY} showcase={[]} expiry={{ kind: "unknown" }} />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain(t.pricing.expiryNever);
    expect(text).not.toContain(t.site.packsOnly.unusedNever);
    expect(text).toContain(t.pricing.expiryUnknown);
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
    expect(screen.getByRole("heading", { level: 2, name: dictionaries.en.site.anchor.title })).toBeTruthy();
  });

  it.each(["en", "ru", "uz"] as const)("says nothing about plans when only packs are on sale (%s)", (locale) => {
    const t = dictionaries[locale];
    const { container } = renderPricing({ pricing: none }, locale);
    const text = container.textContent ?? "";
    for (const planLine of [t.pricing.terms[0], t.pricing.terms[1], t.pricing.ctaNote, t.pricing.packsLead]) expect(text).not.toContain(planLine);
    expect(screen.queryByRole("heading", { level: 3, name: t.pricing.faq.find((q) => q.id === "cancel")!.q })).toBeNull();
    expect(text).toContain(t.site.packsOnly.packsLead);
    cleanup();
    // …and the landing's questions open on refunds and unused credits, not on cancelling a plan.
    const landing = renderLanding({ kind: "announced" }, locale);
    expect(landing.container.textContent).not.toContain(t.landing.faq.items.find((q) => q.id === "cancel")!.q);
    const open = [...landing.container.querySelectorAll("#faq details[open] h3")].map((h) => h.textContent);
    expect(open).toEqual(t.landing.faq.items.filter((q) => q.id === "refund" || q.id === "unused").map((q) => q.q));
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
