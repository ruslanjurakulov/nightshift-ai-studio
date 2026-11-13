// @vitest-environment jsdom
/**
 * The Pixel audit of the live site (outside the landing): what broke, pinned so it does not come back.
 * Layout is CSS and jsdom has none, so the width-dependent findings are pinned as the rule that fixed them, and the
 * rendered markup is checked for what carries it; the screenshots at 390 and 1440 px are in the PR.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
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

import { dictionaries, LOCALES as LOCALE_LIST, type Locale } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { PlanMatrix } from "@/components/pricing/PlanMatrix";
import { PlanCompare } from "@/components/pricing/PlanCompare";
import { displayPriceCents, displayPriceText } from "@/lib/pricing";
import type { PlanMatrix as Matrix } from "@/lib/plans";

afterEach(cleanup);

const LOCALES = LOCALE_LIST.map((l) => l.code);

const root = process.cwd();
const siteCss = readFileSync(path.join(root, "components/site/site.css"), "utf8");
const nextCss = readFileSync(path.join(root, "components/site/site-next.css"), "utf8");
const studioCss = readFileSync(path.join(root, "components/site/studio-page.css"), "utf8");
const NBSP = " ";

/** The body of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`, "m").exec(css)?.[1] ?? "";
}

const matrix: Matrix = {
  columns: [
    { id: "free", name: "Free", monthlyCredits: 0, isDefault: true, priceId: null, displayPrice: null },
    { id: "creator", name: "Plus", monthlyCredits: 2000, isDefault: false, priceId: "pri_plancreator0001", displayPrice: "$19.00" },
    { id: "pro", name: "Pro", monthlyCredits: 6000, isDefault: false, priceId: "pri_planpro00000001", displayPrice: "49 USD" },
    { id: "studio", name: "Business", monthlyCredits: 18000, isDefault: false, priceId: "pri_planstudio00001", displayPrice: "$129" },
  ],
  rows: [
    { key: "concurrency", type: "int", cells: [1, 2, 4, 8] },
    { key: "api_access", type: "bool", cells: [false, true, true, true] },
  ],
  purchasable: true,
  paddle: null,
};

function plans(locale: Locale, signedIn = false) {
  return render(
    <PublicI18nProvider locale={locale} t={publicDictionary(dictionaries[locale])}>
      <PlanMatrix matrix={matrix} perMinute={null} signedIn={signedIn} subscribeHref="/credits" />
      <PlanCompare matrix={matrix} titleId="t" />
    </PublicI18nProvider>,
  );
}

describe("/pricing plan cards", () => {
  // At 1440 the Russian and Uzbek sign-up labels (281 and 268px) ran past their 247px keys and were cut at both ends on
  // Plus, Pro and Business. The key may now wrap and grow; it is never a single nowrap line in a fixed box.
  it("lets a plan card's call to action wrap and grow instead of clipping, and gives every one of them that rule", () => {
    const wrap = rule(siteCss, '.st-key[data-wrap="true"]');
    expect(wrap).toMatch(/white-space:\s*normal/);
    expect(wrap).toMatch(/height:\s*auto/);
    expect(wrap).toMatch(/text-wrap:\s*balance/);
    expect(wrap).not.toMatch(/overflow:\s*hidden|text-overflow/);
    // It comes after the base key rule (nowrap) and the small size's padding, so it wins on order.
    expect(siteCss.indexOf('.st-key[data-wrap="true"]')).toBeGreaterThan(siteCss.indexOf('.st-key[data-size="sm"] {'));
    expect(rule(siteCss, ".st-key")).toMatch(/white-space:\s*nowrap/);
    expect(rule(siteCss, '.st-key[data-size="sm"]')).toMatch(/min-height:\s*44px/);
  });

  it.each(["ru", "uz"] as const)("(%s) every signed-out and signed-in plan key carries the wrapping rule, with a label in the page's language", (locale) => {
    for (const signedIn of [false, true]) {
      const { container, unmount } = plans(locale, signedIn);
      const keys = [...container.querySelectorAll<HTMLAnchorElement>(".st-plan a.st-key")];
      expect(keys.length, `${locale} signedIn=${signedIn}`).toBe(signedIn ? 3 : 4);
      for (const k of keys) {
        expect(k.getAttribute("data-wrap")).toBe("true");
        expect(k.textContent?.trim().length).toBeGreaterThan(0);
      }
      unmount();
    }
    // Shorter natural copy as well: both read as one phrase and fit two lines of a 247px key.
    expect(dictionaries.ru.plans.subscribeSignedOut).toBe("Зарегистрироваться и подписаться");
    expect(dictionaries.uz.plans.subscribeSignedOut).toBe("Roʻyxatdan oʻtib obuna boʻlish");
  });

  it.each(LOCALES)("(%s) the free plan is named in the page's language, with no English 'Free' above its price", (locale) => {
    const { container } = plans(locale);
    const free = container.querySelector(".st-plan")!;
    expect(free.querySelector(".st-price-name")?.textContent).toBe(dictionaries[locale].plans.freeName);
    // Its price is said in words, never a "$0" no price list gave the page, and not the plan's name a second time.
    expect(free.querySelector(".st-h3")?.textContent).toBe(dictionaries[locale].plans.freePrice);
    expect(dictionaries[locale].plans.freePrice).not.toBe(dictionaries[locale].plans.freeName);
    expect(free.textContent).not.toMatch(/\$/);
    if (locale !== "en") expect(free.textContent).not.toContain("Free");
    // The compare table's column heading too.
    expect(container.querySelector("thead th:nth-child(2)")?.textContent).toBe(dictionaries[locale].plans.freeName);
  });

  it("writes every plan price one way, without '.00': display env as '$19.00' or '49 USD' reads like '$129'", () => {
    const en = plans("en").container;
    const prices = [...en.querySelectorAll(".st-plan .st-num.text-\\[28px\\]")].map((p) => p.firstChild?.textContent);
    expect(prices).toEqual(["$19", "$49", "$129"]);
    cleanup();
    const ru = plans("ru").container;
    expect([...ru.querySelectorAll(".st-plan .st-num.text-\\[28px\\]")].map((p) => p.firstChild?.textContent)).toEqual([`19${NBSP}$`, `49${NBSP}$`, `129${NBSP}$`]);
  });

  it("the limits are a label column and a value column, so '4 at once' never breaks as '4 at / once'", () => {
    const { container } = plans("en");
    expect(container.querySelectorAll(".st-plan dl.st-plan-limits > div > dt + dd").length).toBe(8);
    expect(rule(siteCss, ".st-plan-limits > div")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  });
});

describe("one price formatter", () => {
  it("reads the currency-code form and Paddle's preview the same as a '$' amount, dropping '.00'", () => {
    expect(displayPriceText("$19.00", "en")).toBe("$19");
    expect(displayPriceText("19 USD", "en")).toBe("$19");
    expect(displayPriceText("45 USD", "ru")).toBe(`45${NBSP}$`);
    expect(displayPriceText("USD 10", "uz")).toBe("$10");
    expect(displayPriceText("$10.00", "en")).toBe("$10");
    expect(displayPriceText("12.50 USD", "en")).toBe("$12.50");
  });

  it("prints anything else exactly as it came, and teaches the money math nothing new", () => {
    for (const v of ["€9", "10 USD/mo", "from $5", "UZS 240 000", "0 USD"]) expect(displayPriceText(v, "en")).toBe(v);
    // Only the text changed: a figure is still worked out from a plain '$' amount alone.
    expect(displayPriceCents("45 USD")).toBeNull();
    expect(displayPriceCents("$45")).toBe(4500);
  });
});

describe("the rest of the audit", () => {
  it("the home hero's pause switch takes the stage's text colour on the dark hero (it was 2.7 to 2.9:1)", () => {
    expect(nextCss).toMatch(/@media \(min-width: 1024px\) \{\n {2}\.nx-hero \.nx-motion-btn:not\(\[aria-pressed="true"\]\) \{ color: var\(--nx-stage-text\); \}/);
    expect(nextCss).toMatch(/--nx-stage-text: #f4f0e9;/);
  });

  it("a monitor's second name ('Ваш канал') moves under the title instead of being cut", () => {
    const span = rule(siteCss, ".st-monitor-title span");
    expect(span).not.toMatch(/overflow:\s*hidden|text-overflow/);
    expect(siteCss).toMatch(/\.st-monitor-title \{ flex-wrap: wrap; row-gap: 0; \}/);
  });

  it("the Studio editor's video clips are never narrower than their names ('Boshlanish')", () => {
    expect(rule(studioCss, '.sp-clip[data-auto="true"]')).toMatch(/min-width:\s*max-content/);
  });

  it("from 1280px the footer's brand column holds the five social icons on one row", () => {
    expect(siteCss).toMatch(/@media \(min-width: 1280px\) \{\n {2}\.st-footer-grid \{ grid-template-columns: minmax\(228px, 1\.2fr\) repeat\(5, minmax\(0, 1fr\)\); \}/);
  });

  it("the sign-up band keeps the card off the wordmark and the Example tag clear of the pause button", () => {
    expect(nextCss).toMatch(/\.nx-auth-band \{ padding-bottom: 104px; \}/);
    expect(nextCss).toMatch(/\.nx-auth-band \.nx-fcard \.nx-demo-tag \{ right: auto; left: 18px; \}/);
  });

  it.each(LOCALES)("(%s) /studio speaks to a customer: no 'deployment' set-up wording", (locale) => {
    const caveat = dictionaries[locale].site.studioPage.caveat;
    expect(caveat).not.toMatch(/deployment|setting up|установк|настроить|oʻrnatma|sozlash/i);
    expect(caveat.length).toBeGreaterThan(40);
  });
});
