// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({ locale: "en" as "en" | "ru" | "uz" }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/i18n/public-context", async () => {
  const { dictionaries, fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: dictionaries[h.locale], locale: h.locale, fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/i18n/server", async () => {
  const { dictionaries } = await import("../lib/i18n");
  return { getDictionary: async () => ({ locale: h.locale, t: dictionaries[h.locale] }) };
});
// The language and theme keys, the clip and the footer are not what is under test here.
vi.mock("@/components/LanguageSelector", () => ({ LanguageSelector: () => null }));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/site/LoopClip", () => ({ LoopClip: () => null }));
vi.mock("@/components/site/ClipPause", () => ({ ClipPause: () => null }));
vi.mock("@/components/legal/LegalFooter", () => ({ LegalFooter: () => null }));
vi.mock("@/components/legal/PublicFooter", () => ({ PublicFooter: () => null }));
vi.mock("@/components/view-mode/ViewModeToggle", () => ({ ViewModeToggle: () => null, ViewModeControl: () => null }));
vi.mock("@/components/site/SiteEffects", () => ({ SiteEffects: () => null }));
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), preload: () => {} }));

import { dictionaries, type Locale } from "@/lib/i18n";
import { getLegalTexts } from "@/lib/legal-docs";
import { getDevDictionary } from "@/lib/i18n/dev";
import { SOLUTION_IDS } from "@/lib/solutions";
import { siteGraphJsonLd, jsonLdScript } from "@/lib/landing";
import { faqPageJsonLd } from "@/lib/studio-page";
import { faqForSale } from "@/components/landing/Faq";
import { packExpiry } from "@/lib/plans";
import { AuthShell } from "@/components/auth/AuthShell";

afterEach(cleanup);

const LOCALES: Locale[] = ["en", "ru", "uz"];

/** Every public page's search-result description, per language. */
function descriptions(locale: Locale): [string, string][] {
  const t = dictionaries[locale];
  const dev = getDevDictionary(locale);
  const legal = getLegalTexts(locale);
  return [
    ["landing", t.landing.meta.description],
    ["pricing", t.pricing.metaDescription],
    ["studio", t.site.studioPage.meta.description],
    ["solutions", t.site.solutions.meta.description],
    ...SOLUTION_IDS.map((id): [string, string] => [`solutions/${id}`, t.site.solutions.pages.find((p) => p.id === id)!.lead]),
    ["login", t.site.auth.signInSub],
    ["signup", t.signup.sub],
    ["privacy", legal.privacy.summary],
    ["terms (meta)", t.site.legalMeta.terms],
    ["api", dev.api.meta.description],
    ["mcp", dev.mcp.meta.description],
    ["mcp (sign-in off)", dev.mcp.signinOff.description],
    ["cli", dev.cli.meta.description],
    ["skills", dev.skills.meta.description],
  ];
}

describe("search-result descriptions", () => {
  it.each(LOCALES)("every public page's description in %s is 50 to 160 characters", (locale) => {
    for (const [page, text] of descriptions(locale)) {
      expect(text.length, `${locale} ${page}: ${text.length}`).toBeLessThanOrEqual(160);
      expect(text.length, `${locale} ${page}: ${text.length}`).toBeGreaterThanOrEqual(50);
    }
  });

  it.each(LOCALES)("the share titles in %s stay within 70 characters", (locale) => {
    const t = dictionaries[locale];
    expect(t.landing.meta.title.length).toBeLessThanOrEqual(70);
    expect(t.site.studioPage.meta.title.length).toBeLessThanOrEqual(70);
    for (const id of SOLUTION_IDS) {
      const page = t.site.solutions.pages.find((p) => p.id === id)!;
      expect(`${page.nav} · ${t.site.solutions.meta.title} · ${t.brand.name}`.length).toBeLessThanOrEqual(70);
    }
  });

  it("the Uzbek descriptions use the modifier-letter apostrophe, never a straight one inside a word", () => {
    for (const [page, text] of descriptions("uz")) expect(text, page).not.toMatch(/[oOgG]'/);
  });

  it("the legal documents' own text is untouched: /terms shows its full summary, only the meta text is separate", () => {
    for (const locale of LOCALES) {
      const t = dictionaries[locale];
      const terms = getLegalTexts(locale).terms;
      expect(t.site.legalMeta.terms).not.toBe(terms.summary);
      expect(t.site.legalMeta.terms.length).toBeLessThanOrEqual(160);
    }
    const src = readFileSync(join(process.cwd(), "app", "terms", "page.tsx"), "utf8");
    expect(src).toContain("t.site.legalMeta.terms");
    expect(src).not.toMatch(/description: doc\.summary/);
  });

  it("/privacy and /terms carry canonical, OpenGraph and Twitter metadata like every other public page", () => {
    for (const name of ["privacy", "terms"]) {
      const src = readFileSync(join(process.cwd(), "app", name, "page.tsx"), "utf8");
      expect(src).toContain("shareMetadata(");
      expect(src).toContain(`path: "/${name}"`);
    }
  });
});

describe("structured data on the homepage", () => {
  it("states only the product, its address and its icon, and none without a known address", () => {
    expect(siteGraphJsonLd({ name: "Nightshift", origin: null })).toBeNull();
    const g = siteGraphJsonLd({ name: "Nightshift", origin: "https://nightshift.example" })!;
    const graph = g["@graph"] as Record<string, unknown>[];
    expect(graph.map((n) => n["@type"])).toEqual(["Organization", "WebSite"]);
    expect(graph[0]).toMatchObject({ name: "Nightshift", url: "https://nightshift.example", logo: "https://nightshift.example/icon.png" });
    const text = JSON.stringify(g);
    for (const key of ["aggregateRating", "review", "offers", "sameAs", "contactPoint", "potentialAction"]) expect(text).not.toContain(key);
  });

  it("the FAQPage is built from the questions the page shows, in each language, as plain text", () => {
    for (const locale of LOCALES) {
      const t = dictionaries[locale];
      for (const plans of [true, false]) {
        const shown = faqForSale(t.landing.faq.items, plans, t.site.packsOnly, packExpiry(null, null));
        const ld = faqPageJsonLd(shown) as { "@type": string; mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
        expect(ld["@type"]).toBe("FAQPage");
        expect(ld.mainEntity.map((q) => q.name)).toEqual(shown.map((i) => i.q));
        expect(ld.mainEntity.map((q) => q.acceptedAnswer.text)).toEqual(shown.map((i) => i.a));
        for (const q of ld.mainEntity) expect(q.acceptedAnswer.text).not.toMatch(/<|\]\(/);
      }
    }
    expect(jsonLdScript(faqPageJsonLd([{ id: "x", q: "</script>", a: "a" }]))).not.toContain("</script>");
  });

  it("the homepage emits the graph and the FAQ next to the application entry", () => {
    const src = readFileSync(join(process.cwd(), "app", "page.tsx"), "utf8");
    expect(src).toContain("siteGraphJsonLd(");
    expect(src).toContain("faqPageJsonLd(faqForSale(");
  });
});

describe("the sign-in and sign-up frame", () => {
  it.each(LOCALES)("opens with a skip link to the form's main landmark, in %s", (locale) => {
    h.locale = locale;
    const { container } = render(
      <AuthShell title="T">
        <form aria-label="f" />
      </AuthShell>,
    );
    const skip = container.querySelector("a.st-skip") as HTMLAnchorElement;
    expect(skip.getAttribute("href")).toBe("#main");
    expect(skip.textContent).toBe(dictionaries[locale].landing.nav.skip);
    // It is the first thing in tab order, and what it points at exists and takes focus.
    expect(container.querySelector("a, button")).toBe(skip);
    const main = container.querySelector("main#main") as HTMLElement;
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(within(main).getByRole("heading", { level: 1 }).textContent).toBe("T");
  });

  it("loads its pictures eagerly, because one of them is the first screen", () => {
    h.locale = "en";
    const { container } = render(
      <AuthShell title="T">
        <span />
      </AuthShell>,
    );
    const pics = [...container.querySelectorAll("img")];
    expect(pics.length).toBeGreaterThan(0);
    for (const img of pics) expect(img.getAttribute("loading")).toBe("eager");
  });
});

describe("the 404 page", () => {
  it.each(LOCALES)("offers the way home and the pages a visitor most likely wanted, in %s", async (locale) => {
    h.locale = locale;
    const { default: NotFound } = await import("../app/not-found");
    render(await NotFound());
    const t = dictionaries[locale];
    const main = screen.getByRole("main");
    const hrefs = within(main)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    // Its label differs from the header's, so the two navigation landmarks can be told apart.
    expect(t.site.notFound.more).not.toBe(t.landing.nav.label);
    expect(hrefs).toEqual(["/", "/pricing", "/studio", "/solutions", "/login"]);
    expect(within(main).getByRole("link", { name: t.site.nav.studio })).toBeTruthy();
    expect(within(main).getByRole("navigation", { name: t.site.notFound.more })).toBeTruthy();
  });
});
