// @vitest-environment jsdom
/**
 * /pricing's "What does my plan make?" as a person sees it: the outputs on each plan card, the plan finder, the per-item
 * table and the line on failures — and that every figure on them is the quote's own, in every language.
 *
 * What would break without these: a card or the finder reading a different number from the one Run now holds; an
 * unpublished rate shown as a figure (or as 0); a signed-out visitor shown model prices nobody let them read; the finder
 * calling the network as a person types; a Russian or Uzbek visitor reading English or a raw `{n}`; type below 13px.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

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

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, fmt, type Locale } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { PricingView } from "@/components/pricing/PricingView";
import { PlanFinder } from "@/components/pricing/PlanFinder";
import { resolvePricing } from "@/lib/pricing";
import { coercePlanCatalog, planMatrix } from "@/lib/plans";
import { estimateRunCredits, formatCredits, parsePrices } from "@/lib/credits";
import { fromSellableRow } from "@/lib/models-discovery";
import { DEFAULT_LENGTH_S, finderPlans, studioRows, videoPrices, type PlanFinderData } from "@/lib/plan-finder";
import { PROVIDER_BRANDS } from "./helpers/brands";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const READ_AT = "2026-11-14T08:00:00Z";
/** public_video_rates() as charged: 12.5 credits a finished minute (10 with a 25% margin), a 30-credit smallest hold. */
const PUBLIC_VIDEO = videoPrices(parsePrices([{ unit: "video_minute", credits_per_unit: 12.5 }, { unit: "job_minimum", credits_per_unit: 30 }]));

function catalog() {
  return coercePlanCatalog(
    [
      { id: "free", name: "Free", sort_order: 0, monthly_credits: 0, is_default: true, is_public: true },
      { id: "creator", name: "Creator", sort_order: 1, monthly_credits: 2000, is_default: false, is_public: true },
      { id: "pro", name: "Pro", sort_order: 2, monthly_credits: 6000, is_default: false, is_public: true },
    ],
    [],
    [],
  );
}
const plans = () => planMatrix(catalog(), { NEXT_PUBLIC_PLAN_DISPLAY_CREATOR: "$12", NEXT_PUBLIC_PLAN_DISPLAY_PRO: "$30" }, null)!;

function studio(): PlanFinderData["studio"] {
  const list = { pic_medium: 40, pic_high: 80, clip: 10 };
  const rows = [
    { id: "pic", display_name: "Picture One", provider: "p", capabilities: ["t2i"], availability: "ga", verified_at: "2026-11-01", credit_unit: "pic", spec: { output: "image", unit: "image", qualities: ["medium", "high"], price_variants_by: "quality" } },
    { id: "clip", display_name: "Clip One", provider: "p", capabilities: ["t2v"], availability: "ga", verified_at: "2026-11-01", credit_unit: "clip", credits_per_unit: 10, spec: { output: "video", unit: "second", durations_s: [5, 10] } },
    { id: "off", display_name: "Clip Two", provider: "p", capabilities: ["t2v"], availability: "ga", verified_at: "2026-11-01", credit_unit: "off", credits_per_unit: 1, spec: { output: "video", unit: "second", durations_s: [5] } },
  ];
  return { status: "ok", rows: studioRows(rows.map((r) => fromSellableRow(r, list, null)!), 30), stamp: { kind: "read", at: READ_AT } };
}

function renderPricing(finder: PlanFinderData, locale: Locale = "en", signedIn = false) {
  const t = dictionaries[locale];
  return render(
    <I18nProvider locale={locale}>
      <PricingView t={t} locale={locale} signedIn={signedIn} rates={null} plans={plans()} pricing={resolvePricing({}, null)} finder={finder} />
    </I18nProvider>,
  );
}

const signedOut: PlanFinderData = { video: PUBLIC_VIDEO, videoStamp: { kind: "read", at: READ_AT }, studio: { status: "signed_out" } };
const card = (container: HTMLElement, id: string) => container.querySelector(`#plan-${id}`) as HTMLElement;
const out = (el: HTMLElement, what: string) => el.querySelector(`[data-output="${what}"] .pf-out-fig`)?.textContent;

describe("each plan card says what it makes", () => {
  it("in finished YouTube videos: floor(credits ÷ Run now's quote), with the settings and the date printed", () => {
    const { container } = renderPricing(signedOut);
    const quote = estimateRunCredits({ prices: PUBLIC_VIDEO!, durationS: DEFAULT_LENGTH_S, videos: [] }).credits!;
    expect(quote).toBe(62.5);
    expect(out(card(container, "creator"), "youtube")).toBe(`≈ ${Math.floor(2000 / quote)}`); // 32
    expect(out(card(container, "pro"), "youtube")).toBe(`≈ ${Math.floor(6000 / quote)}`); // 96
    const creator = card(container, "creator").textContent!;
    expect(creator).toContain("5 min each · any voice · 1080p");
    expect(creator).toContain("Rate as read on Nov 14, 2026");
  });

  it("dates the rate by the price list's own date when the list gave one", () => {
    const { container } = renderPricing({ ...signedOut, videoStamp: { kind: "set", at: "2026-11-03T10:00:00Z" } });
    expect(card(container, "creator").textContent).toContain("Rate set Nov 3, 2026");
  });

  it("reads 'price unavailable' — no figure, no settings — when no per-minute rate is published", () => {
    const { container } = renderPricing({ video: null, videoStamp: null, studio: { status: "signed_out" } });
    const creator = card(container, "creator");
    expect(out(creator, "youtube")).toBe(en.planFinder.card.unavailable);
    expect(creator.querySelector('[data-output="youtube"]')!.textContent).not.toMatch(/\d/);
    expect(creator.textContent).not.toContain("1080p");
    // The finder says the month cannot be worked out, and the table that no rate is published.
    expect(screen.getAllByText(en.planFinder.finder.unavailable).length).toBeGreaterThan(0);
    expect(screen.getByText(en.planFinder.table.unpublished)).toBeTruthy();
  });

  it("signed out, Studio outputs are 'price unavailable' and say why: model prices are members' reads", () => {
    const { container } = renderPricing(signedOut);
    const creator = card(container, "creator");
    expect(out(creator, "studio")).toBe(en.planFinder.card.unavailable);
    expect(creator.querySelector('[data-output="images"]')).toBeNull();
    expect(creator.querySelector('[data-output="studio"]')!.textContent).not.toMatch(/\d/);
    expect(creator.textContent).toContain(en.planFinder.card.signedOut);
    expect(within(container.querySelector("#item-prices") as HTMLElement).getByText(en.planFinder.table.signIn).getAttribute("href")).toBe("/login?next=/pricing");
  });

  it("signed in, Studio outputs are a range with both ends named, from the dearest setting to the cheapest", () => {
    const { container } = renderPricing({ ...signedOut, studio: studio() }, "en", true);
    const creator = card(container, "creator");
    // Pictures: high 80 → 25, medium 40 → 50. Clips: the shortest, 5 s × 10 = 50 → 40.
    expect(out(creator, "images")).toBe("≈ 25–50");
    expect(out(creator, "clips")).toBe("≈ 40");
    expect(creator.textContent).toContain("Picture One, High to Picture One, Medium");
    expect(creator.textContent).toContain("Clip One, 5 s");
  });

  it("says Studio prices could not be read rather than showing none", () => {
    const { container } = renderPricing({ ...signedOut, studio: { status: "failed" } }, "en", true);
    expect(card(container, "creator").textContent).toContain(en.planFinder.card.failed);
    expect(screen.getByText(en.planFinder.table.failed)).toBeTruthy();
  });
});

describe("the per-item table", () => {
  it("lists the video rates, every Studio setting on sale with its credits, and what is not on sale says so", () => {
    renderPricing({ ...signedOut, studio: studio() }, "en", true);
    const table = screen.getByRole("table", { name: en.planFinder.table.caption });
    const rows = within(table).getAllByRole("row").map((r) => r.textContent);
    expect(rows).toContain(`${en.planFinder.table.minute}—12.5${en.planFinder.table.perMinute}`);
    expect(rows).toContain(`${en.planFinder.table.minimum}—30${en.planFinder.table.perRun}`);
    expect(rows).toContain(`Picture OneHigh80${en.modelDiscovery.per.image}`);
    expect(rows).toContain(`Picture OneMedium40${en.modelDiscovery.per.image}`);
    expect(rows).toContain(`Clip One—10${en.modelDiscovery.per.second}`);
    expect(rows).toContain(`Clip Two—${en.planFinder.table.notOnSale}—`);
  });

  it("ends with the one line on failures, as the code does it", () => {
    renderPricing(signedOut);
    const line = document.querySelector("[data-failure-line]")!.textContent!;
    expect(line).toBe(en.planFinder.failures);
    expect(line).toMatch(/whole hold goes back/);
    expect(line).toMatch(/nothing is charged/);
    expect(line).toMatch(/about 3 hours/);
  });
});

describe("the plan finder", () => {
  function finder(video = PUBLIC_VIDEO, planList = finderPlans(plans().columns)) {
    return render(
      <PlanFinder copy={en.planFinder.finder} locale="en" unitForms={en.shell.creditUnit} plans={planList} video={video} stamp="Rate as read on Nov 14, 2026" conceptImages={4} />,
    );
  }
  const head = (c: HTMLElement) => c.querySelector(".pf-match-head")!.textContent!;
  const more = (label: string) => fireEvent.click(screen.getByRole("button", { name: `${en.planFinder.finder.more}: ${label}` }));

  it("starts at one channel, three videos a week, the default length — and its month is the holds' sum", () => {
    const { container } = finder();
    // 13 videos × 62.5 = 812.5 credits: Creator (2,000) covers it.
    expect(head(container)).toContain("Creator");
    expect(head(container)).toContain(fmt(en.planFinder.finder.usage, { used: "812.5", credits: "2,000", unit: "credits" }));
    expect(head(container)).toContain(fmt(en.planFinder.finder.spare, { n: "1,187.5", unit: "credits" }));
    expect(container.querySelector("[data-total] dd")!.textContent).toBe("812.5 credits");
  });

  it("moves to the next plan once the month passes a plan's credits (the exact boundary: tests/plan-finder.test.ts)", () => {
    const { container } = finder();
    const perWeek = screen.getByLabelText(en.planFinder.finder.perWeek) as HTMLInputElement;
    fireEvent.change(perWeek, { target: { value: "7" } }); // 30.33 → 31 videos = 1,937.5
    expect(head(container)).toContain("Creator");
    more(en.planFinder.finder.channels); // 2 × 7 → 61 videos = 3,812.5
    expect(head(container)).toContain("Pro");
    expect(head(container)).toContain(fmt(en.planFinder.finder.usage, { used: "3,812.5", credits: "6,000", unit: "credits" }));
  });

  it("past every plan, names the largest and what is short", () => {
    const { container } = finder();
    fireEvent.change(screen.getByLabelText(en.planFinder.finder.channels), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText(en.planFinder.finder.perWeek), { target: { value: "14" } });
    // 20 × 14 × 52/12 = 1,213.33 → 1,214 videos × 62.5 = 75,875; Pro has 6,000.
    expect(head(container)).toContain(fmt(en.planFinder.finder.over, { plan: "Pro", credits: "6,000", short: "69,875" }));
  });

  it("adds the re-run room, and the voice changes nothing but says so", () => {
    const { container } = finder();
    fireEvent.click(screen.getByLabelText(en.planFinder.finder.voicePremium));
    expect(container.querySelector("[data-total] dd")!.textContent).toBe("812.5 credits");
    expect(screen.getByText(en.planFinder.finder.voiceNote)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("+25%"));
    expect(container.querySelector("[data-total] dd")!.textContent).toBe("1,015.63 credits");
  });

  it("with no published rate, says so and shows no figure", () => {
    const { container } = finder(null);
    expect(head(container)).toBe(en.planFinder.finder.unavailable);
    expect(container.querySelector(".pf-break")).toBeNull();
  });

  it("with no plan on sale, matches nothing", () => {
    const { container } = finder(PUBLIC_VIDEO, []);
    expect(head(container)).toBe(en.planFinder.finder.noPlans);
  });

  it("never touches the network while a person types: arithmetic over the rates the page was rendered with", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    finder();
    for (let i = 0; i < 5; i++) more(en.planFinder.finder.channels);
    fireEvent.change(screen.getByLabelText(en.planFinder.finder.length), { target: { value: "12" } });
    fireEvent.click(screen.getByLabelText("+50%"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the last good number while a field is empty, never a default", () => {
    const { container } = finder();
    fireEvent.change(screen.getByLabelText(en.planFinder.finder.perWeek), { target: { value: "" } });
    expect(container.querySelector("[data-total] dd")!.textContent).toBe("812.5 credits");
  });

  it("every figure it prints agrees with estimateRunCredits for the same rates (the page and the quote cannot disagree)", () => {
    const { container } = finder();
    for (const len of ["1", "2", "7", "13", "60"]) {
      fireEvent.change(screen.getByLabelText(en.planFinder.finder.length), { target: { value: len } });
      const quote = estimateRunCredits({ prices: PUBLIC_VIDEO!, durationS: Number(len) * 60, videos: [] }).credits!;
      const perVideo = container.querySelectorAll(".pf-break dd b")[1].textContent;
      expect(perVideo, `${len} min`).toBe(`${formatCredits(quote, "en")} credits`);
    }
  });
});

describe("in every language", () => {
  const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  function leaves(node: unknown, p = ""): [string, string][] {
    if (typeof node === "string") return [[p, node]];
    if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => leaves(v, p ? `${p}.${k}` : k));
    return [];
  }
  const source = leaves(en.planFinder);

  it("has strings (the check is not vacuous)", () => {
    expect(source.length).toBeGreaterThan(70);
  });

  it.each([["ru", ru], ["uz", uz]] as const)("%s has exactly en's keys, none empty, the same {fillers}, and its own words", (loc, dict) => {
    const got = new Map(leaves(dict.planFinder));
    expect([...got.keys()].sort()).toEqual(source.map(([k]) => k).sort());
    for (const [key, text] of source) {
      expect(got.get(key), `${loc}.${key}`).toBeTruthy();
      expect(fillers(got.get(key)!), `${loc}.${key} fillers`).toEqual(fillers(text));
      // A sentence left in English is a missing translation (the bare figures and formats like "≈ {n}" are shared).
      // A brand is the same in every language: "Nightshift Studio" (the price table's Studio group) is not a missing translation.
      if (/[a-z]{4,}/i.test(text.replace(/\{\w+\}/g, "").replace(/Nightshift Studio/g, ""))) expect(got.get(key), `${loc}.${key} is still English`).not.toBe(text);
    }
  });

  it.each(["en", "ru", "uz"] as const)("renders with no raw {filler} and names no AI provider (%s)", (locale) => {
    const { container } = renderPricing(signedOut, locale);
    fireEvent.click(within(container).getByLabelText(dictionaries[locale].planFinder.finder.voicePremium));
    const text = container.querySelector("#plans")!.textContent! + container.querySelector("#item-prices")!.textContent!;
    expect(text).not.toMatch(/\{\w+\}/);
    expect(text).not.toMatch(PROVIDER_BRANDS);
  });
});

describe("type size", () => {
  it("sets nothing below 13px in the feature's stylesheet", () => {
    const css = readFileSync(path.resolve(process.cwd(), "components/pricing/plan-finder.css"), "utf8");
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(5);
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(13);
    expect(css).not.toMatch(/font-size:\s*(?:0?\.\d+|1[0-2](?:\.\d+)?)(?:rem|em)/);
  });
});
