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
import { Showcases } from "@/components/landing/Showcases";
import { PricingView } from "@/components/pricing/PricingView";
import { PublicFooter } from "@/components/legal/PublicFooter";
import type { MoneyAnchor, PricingTeaser } from "@/lib/landing";
import { WELCOME_CREDITS, resolvePricing, type Pricing } from "@/lib/pricing";
import { coercePlanCatalog, creditEquivalents, planMatrix, type GenerationRates } from "@/lib/plans";
import { PROVIDER_BRANDS } from "./helpers/brands";
import { GALLERY, SAMPLE_CARD, outsideGallery, landingSamples, makerCreditProblems, placeLabelProblems, without } from "./helpers/showcase-scope";
import { slotMedia } from "@/components/site/samples";
import { EXAMPLE_JOBS, EXAMPLE_THUMB_JOB } from "@/components/site/samples";
import { stockInUse } from "@/components/site/stock-in-use";
import { aiMarkOf } from "./helpers/ai-mark";

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
  it("has one h1 with the promise and a heading for every section, each idea once", () => {
    const t = dictionaries.en;
    const s = t.site;
    renderLanding({ kind: "announced" });
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    // The first screen the owner kept (components/landing/home/HomeHero.tsx): its one sentence is the page's h1.
    expect(h1s[0].textContent).toBe(t.landingHome.hero.title);
    for (const title of [s.gallery.title, s.how.simple.title, s.pricingTeaser.title, t.landing.faq.title, s.final.title]) {
      expect(screen.getAllByRole("heading", { level: 2, name: title })).toHaveLength(1);
    }
    // The rails, the comparison, the who-tabs and the rules block are gone, and so (2026-11-22, one gallery, each idea once) are the
    // two full-width showcases and the plan demo, which said again what the first screen's box and the autopilot say: their
    // headings must not come back.
    const showTitles = ["studio", "approvals"].map((id) => s.caps.items.find((i) => i.id === id)!.title);
    for (const gone of [s.who.title, s.rules.title, s.try.title, ...showTitles]) expect(screen.queryByRole("heading", { level: 2, name: gone })).toBeNull();
    // How it works is three steps, and the last one is the person's own press.
    const how = screen.getByRole("list", { name: s.how.slug });
    expect(how.tagName).toBe("OL");
    const steps = within(how).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(steps).toEqual(s.how.simple.steps.map((x) => x.title));
    expect(steps).toHaveLength(3);
    expect(s.how.simple.steps[2].id).toBe("approve");
    // The three promises the page keeps sit just under the first screen, in the facts.
    const trust = screen.getByRole("list", { name: s.rules.slug });
    expect(within(trust).getAllByRole("listitem").map((li) => li.textContent)).toEqual(s.rules.items.map((r) => r.title));
  });

  it("uses only the labelled example stills for pictures: same-origin, described, and none of them a video or a real result", () => {
    const { container } = renderLanding({ kind: "announced" });
    // Outside the model samples (each a real generation, never a stock example: tests/site-showcase.test.tsx), whose number is
    // whatever the owner has merged.
    // The model tiles' small stills are their samples' posters, each inside that sample's box (checked below).
    const all = outsideGallery(container.querySelectorAll("img"));
    const tiles = all.filter((i) => i.closest("#models, #tools"));
    const imgs = all.filter((i) => !i.closest("#models, #tools"));
    // The first screen's clip (our sample, data-sample-job inside its own box), the closing panel's slot (a stock still with a
    // data-sample, or one of our samples), and the example topic's own clip's first frame beside that topic: the third step's phone.
    // Round 10: no clay pictures for the steps and the tools (live pieces and real outputs instead, each in its sample's box).
    expect(imgs.length).toBe(3);
    expect(imgs.filter((i) => EXAMPLE_JOBS.includes(i.getAttribute("data-sample-job") ?? ""))).toHaveLength(1);
    expect(imgs.filter((i) => i.hasAttribute("data-art-id"))).toHaveLength(0);
    for (const img of imgs) {
      expect(img.getAttribute("data-sample") ?? img.getAttribute("data-art-id") ?? img.getAttribute("data-sample-job")).toBeTruthy();
      expect(img.getAttribute("src") ?? "").not.toMatch(/^https?:/);
      if (img.hasAttribute("data-sample-job")) expect(img.closest(SAMPLE_CARD)?.getAttribute("data-showcase-entry")).toBe(img.getAttribute("data-sample-job"));
    }
    expect(imgs.filter((i) => i.getAttribute("data-sample") || i.getAttribute("data-sample-job"))).toHaveLength(3);
    // Every stock picture shown is one the footer credits (components/site/stock-in-use.ts).
    // (An Effects card's frame carries its sample's job id in data-sample, never a stock id: tests/effects-ui.test.tsx.)
    for (const img of outsideGallery(container.querySelectorAll("[data-sample]"))) expect(stockInUse() as string[]).toContain(img.getAttribute("data-sample"));
    for (const img of tiles) {
      expect(img.closest(SAMPLE_CARD)).toBeTruthy();
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("src") ?? "").not.toMatch(/^https?:/);
    }
    // Nothing plays in a jsdom (no clip is rendered without matchMedia), and the old backdrops' <picture>s are gone.
    expect(outsideGallery(container.querySelectorAll("video, audio"))).toHaveLength(0);
    expect(outsideGallery(container.querySelectorAll("picture"))).toHaveLength(0);
    // The gallery's pictures: one per shipped sample, each in its own card, same-origin, lazy, and never marked as a stock
    // example or as the site's own decoration. With no sample merged there is no gallery at all.
    const shipped = landingSamples();
    const gallery = container.querySelector(GALLERY);
    expect(gallery === null).toBe(shipped.cards === 0);
    const samplePics = [...(gallery?.querySelectorAll("img") ?? [])];
    // One per card: the card is its picture alone (media first). The picture a clip was animated from is shown in that sample's
    // dialog (components/site/SampleDetail.tsx), which is not in the page until it is opened (tests/site-showcase.test.tsx).
    expect(samplePics).toHaveLength(shipped.cards);
    for (const img of samplePics) {
      expect(img.closest(SAMPLE_CARD)).toBeTruthy();
      expect(img.hasAttribute("data-sample") || img.hasAttribute("data-art-id")).toBe(false);
      expect(img.getAttribute("src") ?? "").not.toMatch(/^https?:/);
      expect(img.getAttribute("loading")).toBe("lazy");
    }
    // A sample's clip is the only moving picture the gallery may hold.
    for (const v of gallery?.querySelectorAll("video, audio") ?? []) expect(v.tagName).toBe("VIDEO");
    // The first screen's picture is the one eager picture (the page's LCP), at high priority; everything else waits.
    // (Not lazy and at high priority: the first screen's still, which leaves `loading` at its eager default, tests/home-page.test.tsx.)
    const eager = all.filter((i) => i.getAttribute("loading") !== "lazy");
    expect(eager).toHaveLength(1);
    expect(eager[0].closest(".hm-hero-media")).toBeTruthy();
    expect(eager[0].getAttribute("fetchpriority")).toBe("high");
  });

  it("the two capability showcases (off the landing since 2026-11-22, kept for a page that draws them): the Studio over its slot's picture, Approvals over a drawn approval screen; one outlined button each", () => {
    const t = dictionaries.en;
    const { container } = render(<Showcases t={t} />);
    const stills = new Set<string>();
    for (const id of ["studio", "approvals"] as const) {
      const item = t.site.caps.items.find((i) => i.id === id)!;
      const section = container.querySelector(`section#${id}.nx-show`) as HTMLElement;
      expect(within(section).getByRole("heading", { level: 2, name: item.title })).toBeTruthy();
      const cta = within(section).getByRole("link", { name: item.cta });
      expect(cta.getAttribute("href")).toBe(id === "studio" ? "/signup" : "/solutions/youtube-channels");
      expect(section.textContent).not.toMatch(MONEY);
      // The words are real text beside the picture (never baked into it); the only link is the one button, and the only button is
      // the keyboard's pause switch on a clip. A sample in a showcase offers no prompt and credits no maker.
      expect([...section.querySelectorAll("a")]).toEqual([cta]);
      expect([...section.querySelectorAll("button")].every((b) => b.classList.contains("nx-clip-pause"))).toBe(true);
      const img = section.querySelector("img")!;
      stills.add(img.getAttribute("data-sample") ?? img.getAttribute("data-sample-job") ?? img.getAttribute("data-art-id")!);
    }
    // The Studio: its slot's picture, described and labelled for what it is (stock, or one of our samples with its badge only),
    // and a stock picture's note under it; a sample has no footnote.
    const studio = container.querySelector("section#studio") as HTMLElement;
    const m = slotMedia("show.studio");
    expect(studio.querySelector("img")!.getAttribute("alt")).toBe(m.kind === "ai" ? (m.moving ? t.site.gallery.bgClip : t.site.gallery.bgImage) : t.site.samples.alts[m.id]);
    expect(placeLabelProblems(studio.querySelector(".nx-show-pic")!, m, t.site)).toEqual([]);
    expect(studio.querySelector(".nx-show-note")?.textContent ?? null).toBe(m.kind === "ai" ? null : m.clip ? `${t.site.samples.note} ${t.site.samples.clipNote}` : t.site.samples.note);
    // Approvals: the picture shows what the words say. A drawn approval screen (no slot, no stock), one image to assistive tech
    // with its description, tagged "Example", in the product's own words: private on YouTube, the publish check passed, waiting,
    // and the Approve key, drawn (a span, nothing to press). Its one moving part is the video's thumbnail: the example topic's own
    // clip (components/site/slots.ts EXAMPLE_THUMB_JOB), muted, never focusable (LoopClip: tabIndex -1, aria-hidden).
    const approvals = container.querySelector("section#approvals") as HTMLElement;
    const art = approvals.querySelector(".nx-show-pic[data-media='drawn'] .nx-approve-art") as HTMLElement;
    expect(art.getAttribute("role")).toBe("img");
    expect(art.getAttribute("aria-label")).toBe(t.site.approvalCard.figure);
    const step = t.site.stage.steps.find((x) => x.id === "approve") as { lamp: string; check: string; waiting: string; key: string };
    for (const w of [t.site.stage.tag, step.lamp, step.check, step.waiting, step.key, t.site.gallery.badge]) expect(art.textContent).toContain(w);
    expect(art.querySelector(".nx-approve-key")?.tagName).toBe("SPAN");
    expect(art.querySelectorAll("a, button, input, [tabindex]:not(video[tabindex='-1'])")).toHaveLength(0);
    expect([...approvals.querySelectorAll("[data-clip]")].map((x) => [x.className, x.getAttribute("data-showcase-entry")])).toEqual([["nx-approve-thumb", EXAMPLE_THUMB_JOB]]);
    expect(approvals.querySelector(".nx-show-note, .nx-result-credit")).toBeNull();
    expect(approvals.querySelector(".nx-show-card")?.getAttribute("data-art")).toBe("drawn");
    expect(stills.size).toBe(2);
  });

  it("draws the product as one labelled example exchange under the steps: the ask, an example reply, no picture, and a drawn key that is not a button", () => {
    const t = dictionaries.en;
    const { container } = renderLanding({ kind: "announced" });
    const card = container.querySelector("#how figure.nx-chat") as HTMLElement;
    // The figure's description is there for assistive tech, and the card says it is an example.
    expect(card.getAttribute("aria-label")).toBe(t.site.stage.figure);
    expect(card.querySelector(".nx-demo-tag")?.textContent).toBe(t.site.stage.tag);
    expect(card.textContent).not.toMatch(MONEY);
    // The ask, then a reply that says it is an example reply, never "made a video".
    expect(card.querySelector(".nx-bubble .sr-only")?.textContent).toBe(t.site.caps.items[0].bubble);
    expect(card.querySelector(".nx-reply")?.textContent).toContain(t.site.caps.exampleReply);
    expect(card.querySelector(".nx-reply")?.textContent).not.toContain(t.site.caps.items[0].reply);
    // Round 10: the first screen shows the picture, so the card shows none, and its note says what the card is.
    expect(card.querySelector("img, video, .nx-result-art")).toBeNull();
    expect(card.querySelector("figcaption")?.textContent).toBe(t.site.stage.bareNote);
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

  it("says the one known price just under the first screen (round 10: the hero holds only the headline, the bar and two actions), only when the live price list holds it", () => {
    const priced = renderLanding({ kind: "announced" }, "en", {
      pack: { kind: "none" },
      api: null,
      site: { perMinute: 60, minimum: 30, usd: null },
    });
    const facts = priced.container.querySelector(".nx-facts")!;
    expect(priced.container.querySelector(".nx-hero .nx-price")).toBeNull();
    expect(facts.querySelector(".nx-price")?.textContent).toBe("A video in the app: 60 credits a minute of finished video");
    cleanup();
    // No list, no line: the hero never prints a default or a zero.
    const unpriced = renderLanding({ kind: "announced" });
    expect(unpriced.container.querySelector(".nx-price")).toBeNull();
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
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(dictionaries[locale].landingHome.hero.title);
      expect(document.querySelector("figure.nx-chat")?.getAttribute("aria-label")).toBe(dictionaries[locale].site.stage.figure);
      cleanup();
    }
  });

  it.each(["en", "ru", "uz"] as const)("names no AI provider or competitor anywhere on the page (%s)", (locale) => {
    const { container } = renderLanding({ kind: "announced" }, locale);
    // A sample's own card names the model that made it, and only as tests/site-showcase.test.tsx allows; the rest of the page,
    // the gallery's heading and notes included, names none.
    const page = without(container, SAMPLE_CARD);
    expect(page.textContent).not.toMatch(PROVIDER_BRANDS);
    expect(page.innerHTML).not.toMatch(PROVIDER_BRANDS);
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
    // The chat card's picture is a sample once its slot has one, and a sample's box names its model (tests/site-showcase.test.tsx).
    expect(without(container, SAMPLE_CARD).innerHTML).not.toMatch(PROVIDER_BRANDS);
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
    // A sample's box (the chat card's picture, once its slot has one) names its model, whose name may hold a number ("H3"): not a figure.
    const text = without(container, SAMPLE_CARD).textContent ?? "";

    // Every figure the page was handed, and every figure derived from them.
    const allowed = new Set<number>([12, 5, WELCOME_CREDITS, 25, 30, 4, 40]);
    // The chat card's example ask names a year ("What football will look like in 2050"): words of the topic, not a figure.
    for (const m of dictionaries.en.site.caps.items[0].bubble.matchAll(/\d+/g)) allowed.add(Number(m[0]));
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

/**
 * The owner's decision (2026-11-13): the public site shows a sample's AI-generated label and model name only. It never says
 * "Powered by" a model's maker or links one (Runway, Ideogram): their required credit is shown in the Studio, where the models are
 * used (components/studio/ModelAttribution.tsx, tests/model-attribution.test.tsx). Over the shipped samples, in every language.
 */
// What would break: a model tile's "Watch its sample" jumping nowhere, because its sample is shown only on the tool wall or the
// approval screen and had no id there (the review of #734 found two). Over the shipped samples.
describe("the model tiles' links", () => {
  it("every #models a.nx-model-see resolves to exactly one element on the landing, the box of that tile's sample", () => {
    const { container } = renderLanding({ kind: "announced" });
    const links = [...container.querySelectorAll<HTMLAnchorElement>("#models a.nx-model-see")];
    expect(links.length).toBe(container.querySelectorAll("#models .nx-model").length);
    for (const a of links) {
      const href = a.getAttribute("href")!;
      expect(href).toMatch(/^#sample-[0-9a-f-]{36}$/);
      expect(container.querySelectorAll(href), href).toHaveLength(1);
      const job = href.slice("#sample-".length);
      const target = container.querySelector(href)!;
      expect(target.closest(`[data-showcase-entry="${job}"]`) ?? target.querySelector(`[data-sample-job="${job}"], img`), href).toBeTruthy();
    }
  });
});

describe("no maker's credit on the public site", () => {
  it.each(["en", "ru", "uz"] as const)("%s: the landing (gallery, model tiles, tool wall, slots), /pricing and the footer link no model maker and never say \"Powered by\"", (locale) => {
    const t = dictionaries[locale];
    const landing = renderLanding({ kind: "announced" }, locale).container;
    expect(makerCreditProblems(landing)).toEqual([]);
    expect(landing.querySelectorAll('a[href*="runway"], a[href*="ideogram"]')).toHaveLength(0);
    cleanup();
    expect(makerCreditProblems(renderPricing({ pricing: resolvePricing({}, null) }, locale).container)).toEqual([]);
    cleanup();
    const footer = render(<PublicFooter t={t} />).container;
    expect(makerCreditProblems(footer)).toEqual([]);
    expect(footer.textContent).not.toMatch(PROVIDER_BRANDS);
  });
});

describe("public footer", () => {
  it("links Pricing, Privacy, Terms, the Refund Policy and Contact", () => {
    const t = dictionaries.en;
    render(<PublicFooter t={t} />);
    expect(screen.getAllByRole("link", { name: t.legal.pricing })[0].getAttribute("href")).toBe("/pricing");
    expect(screen.getByRole("link", { name: t.legal.privacy }).getAttribute("href")).toBe("/privacy");
    expect(screen.getByRole("link", { name: t.legal.terms }).getAttribute("href")).toBe("/terms");
    expect(screen.getByRole("link", { name: t.legal.refund }).getAttribute("href")).toBe("/refund");
    // The operator-details card on the Terms, where the address is printed (tests/legal-contact.test.tsx).
    expect(screen.getByRole("link", { name: t.site.footer.contact }).getAttribute("href")).toBe("/terms#contact-details");
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
    // The card asks for the example video, so its frame plays that example's own clip, labelled AI-generated: never a sample made
    // from another prompt (it was a chocolate pour, owner 2026-11-14), and never a stock picture with no note.
    const chat = container.querySelector("figure.nx-chat")!;
    expect(chat.querySelector(".nx-bubble")?.textContent).toContain(dictionaries.en.site.caps.items[0].bubble);
    const pic = chat.querySelector(".nx-result-art img")!;
    expect(pic.getAttribute("data-sample-job")).toBe(EXAMPLE_THUMB_JOB);
    expect(pic.getAttribute("alt")).toBe(dictionaries.en.site.how.thumbAlt);
    expect(chat.querySelector(".nx-result-art")?.getAttribute("data-showcase-entry")).toBe(EXAMPLE_THUMB_JOB);
    expect(chat.querySelector("[data-sample]")).toBeNull();
    expect(aiMarkOf(chat.querySelector(".nx-result-art .nx-result-badge[data-kind='ai']"))).toEqual({ seen: dictionaries.en.site.gallery.badge, said: dictionaries.en.site.gallery.badgeName });
    expect(chat.querySelector("figcaption")).toBeNull();
    expect(screen.queryByText(dictionaries.en.pricing.ratesTitle)).toBeNull();
  });
});

