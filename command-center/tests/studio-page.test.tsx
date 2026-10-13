// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/studio",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const dict = vi.hoisted(() => ({ locale: "en" as "en" | "ru" | "uz" }));
vi.mock("@/lib/i18n/server", async () => {
  const { dictionaries } = await import("@/lib/i18n");
  return { getDictionary: async () => ({ locale: dict.locale, t: dictionaries[dict.locale] }), getLocale: async () => dict.locale };
});

import { dictionaries } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { PublicShell } from "@/components/legal/PublicShell";
import { StudioPage } from "@/components/site/StudioPage";
import { studioPageEn } from "@/lib/i18n/studio-page/en";
import { studioPageRu } from "@/lib/i18n/studio-page/ru";
import { studioPageUz } from "@/lib/i18n/studio-page/uz";
import { faqPageJsonLd } from "@/lib/studio-page";
import { STUDIO_PAGE_PATH, SITEMAP_PATHS, gateDecision, isPublicPath, isAlwaysPublicPath } from "@/lib/public-paths";
import { PUBLIC_PAGE_PATHS } from "../next.config";
import sitemap from "@/app/sitemap";
import { generateMetadata } from "@/app/studio/page";
import { PROVIDER_BRANDS } from "./helpers/brands";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const LOCALES = ["en", "ru", "uz"] as const;

function renderPage(locale: (typeof LOCALES)[number]) {
  const t = dictionaries[locale];
  return render(
    <PublicI18nProvider locale={locale} t={publicDictionary(t)}>
      <PublicShell t={t} current="studio" fresh>
        <StudioPage t={t} />
      </PublicShell>
    </PublicI18nProvider>,
  );
}

describe("/studio copy", () => {
  it("is complete in ru and uz with the same shape, ids and placeholders", () => {
    const shape = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(shape) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v === "string" && v.trim() !== "" ? (v.match(/\{\w+\}/g) ?? []).sort().join() : "EMPTY";
    expect(shape(studioPageRu)).toEqual(shape(studioPageEn));
    expect(shape(studioPageUz)).toEqual(shape(studioPageEn));
    const ids = (p: typeof studioPageEn) => [p.hero.jump, p.plan.items, p.editor.items, p.publish.items, p.faq.items].map((l) => l.map((x) => x.id));
    expect(ids(studioPageRu)).toEqual(ids(studioPageEn));
    expect(ids(studioPageUz)).toEqual(ids(studioPageEn));
  });

  it("uses the Uzbek modifier-letter apostrophe, never a straight one after o or g", () => {
    const all = JSON.stringify(studioPageUz);
    expect(all).not.toMatch(/[oOgG]'/);
    expect(all).toContain("ʻ");
  });

  it("names no AI provider, states no price or figure about customers, and promises no speed or quality", () => {
    for (const p of [studioPageEn, studioPageRu, studioPageUz]) {
      const all = JSON.stringify(p);
      expect(all).not.toMatch(PROVIDER_BRANDS);
      expect(all).not.toMatch(/[$€£₽]\s?\d|\d\s?(?:USD|EUR|UZS|RUB)\b/);
      expect(all).not.toMatch(/\b(?:instant|instantly|in seconds|magic|best|perfect|guarantee|blazing)\b/i);
    }
  });

  it("lists nothing that is not on main: no colour grade, keyframes, background removal, tracking or lip sync", () => {
    const en = JSON.stringify(studioPageEn).toLowerCase();
    for (const word of ["colour", "color", "grade", "keyframe", "background", "cut out", "motion track", "lip sync", "lip-sync", "upscale", "avatar", "4k", "watermark", "noise"]) {
      expect(en, word).not.toContain(word);
    }
  });
});

describe("/studio page", () => {
  it.each(LOCALES)("%s: one h1, h2 per block, headings never skip a level, landmarks are single", (locale) => {
    const t = dictionaries[locale];
    const p = t.site.studioPage;
    const { container } = renderPage(locale);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(p.hero.title);
    for (const title of [p.plan.title, p.editor.title, p.publish.title, p.price.title, p.faq.title, p.final.title]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    }
    // Reading order: no heading jumps more than one level down from the one before it.
    const levels = [...container.querySelectorAll("h1,h2,h3,h4")].map((h) => Number(h.tagName[1]));
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1], `heading ${i}`).toBeLessThanOrEqual(1);
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelectorAll("header")).toHaveLength(1);
    expect(container.querySelectorAll("footer")).toHaveLength(1);
    // Every named region is named by a heading that exists.
    for (const s of container.querySelectorAll("main section[aria-labelledby]")) {
      expect(container.querySelector(`#${s.getAttribute("aria-labelledby")}`), s.id).not.toBeNull();
    }
  });

  it.each(LOCALES)("%s: every in-page jump link lands on a section that exists", (locale) => {
    const p = dictionaries[locale].site.studioPage;
    const { container } = renderPage(locale);
    const nav = screen.getByRole("navigation", { name: p.hero.jumpLabel });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(p.hero.jump.map((j) => j.label));
    for (const l of links) {
      const target = container.querySelector(l.getAttribute("href")!);
      expect(target?.tagName, l.getAttribute("href")!).toBe("SECTION");
    }
  });

  it.each(LOCALES)("%s: lists every item of the plan, the editor and publishing, and tags each drawing as an example", (locale) => {
    const p = dictionaries[locale].site.studioPage;
    const { container } = renderPage(locale);
    for (const item of [...p.plan.items, ...p.editor.items, ...p.publish.items]) {
      expect(screen.getByRole("heading", { level: 3, name: item.title })).toBeTruthy();
      expect(container.textContent).toContain(item.body);
    }
    const figures = container.querySelectorAll("figure[role=img]");
    expect(figures).toHaveLength(3);
    for (const f of figures) {
      expect(f.getAttribute("aria-label")).toBeTruthy();
      expect(f.textContent).toContain(p.example);
    }
    // The drawings carry no pictures to size and nothing to press.
    expect(container.querySelectorAll("figure img, figure button, figure a")).toHaveLength(0);
  });

  it("offers the sign-up and pricing links and states the free-credit promise nowhere (that note is the landing's)", () => {
    const { container } = renderPage("en");
    const main = container.querySelector("main")!;
    expect(within(main).getAllByRole("link", { name: /Start free/ }).every((a) => a.getAttribute("href") === "/signup")).toBe(true);
    expect(main.textContent).not.toMatch(/free credits/i);
  });

  it("the header and footer link to /studio, with the page's own item lit", () => {
    const { container } = renderPage("en");
    const nav = container.querySelector("header nav")!;
    const link = within(nav as HTMLElement).getByRole("link", { name: "Studio" });
    expect(link.getAttribute("href")).toBe("/studio");
    expect(link.getAttribute("aria-current")).toBe("page");
    const footer = container.querySelector("footer")!;
    expect(within(footer).getAllByRole("link", { name: "Studio" }).map((a) => a.getAttribute("href"))).toContain("/studio");
    // No menu came back with the new link.
    expect(container.querySelector("header [aria-expanded][aria-controls]")).toBeNull();
  });
});

describe("/studio FAQ", () => {
  it("has 8 questions", () => {
    for (const p of [studioPageEn, studioPageRu, studioPageUz]) expect(p.faq.items).toHaveLength(8);
  });

  it.each(LOCALES)("%s: the FAQPage JSON-LD answers equal the visible text, question for question", (locale) => {
    const { container } = renderPage(locale);
    const scripts = [...container.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent!));
    const faq = scripts.find((j) => j["@type"] === "FAQPage");
    expect(faq).toBeTruthy();
    expect(faq["@context"]).toBe("https://schema.org");
    const visible = [...container.querySelectorAll("#faq details")].map((d) => ({
      q: d.querySelector("summary h3")!.textContent,
      a: d.querySelector(".st-faq-body > p")!.textContent,
    }));
    const structured = faq.mainEntity.map((e: { name: string; acceptedAnswer: { text: string; "@type": string }; "@type": string }) => {
      expect(e["@type"]).toBe("Question");
      expect(e.acceptedAnswer["@type"]).toBe("Answer");
      return { q: e.name, a: e.acceptedAnswer.text };
    });
    expect(structured).toEqual(visible);
    expect(visible).toHaveLength(8);
    // Plain text: nothing a crawler could read differently from what a person reads.
    for (const v of visible) expect(v.a).not.toMatch(/[<>]/);
  });

  it("the JSON-LD builder is a pure function of the items", () => {
    const j = faqPageJsonLd([{ id: "x", q: "Q?", a: "A." }]) as { mainEntity: unknown[] };
    expect(j.mainEntity).toEqual([{ "@type": "Question", name: "Q?", acceptedAnswer: { "@type": "Answer", text: "A." } }]);
  });
});

describe("/studio in the public paths, the sitemap and the metadata", () => {
  it("is a public page for a signed-out visitor, and the old section link for a signed-in one", () => {
    expect(STUDIO_PAGE_PATH).toBe("/studio");
    expect(isPublicPath("/studio")).toBe(true);
    expect(gateDecision("/studio", false)).toBe("pass");
    expect(gateDecision("/studio/", false)).toBe("pass");
    // Signed in, `/studio` keeps meaning "the Studio section": the middleware redirects it to /<channel>/studio.
    expect(gateDecision("/studio", true)).toBe("app");
    expect(isAlwaysPublicPath("/studio")).toBe(false);
    // Nothing under it opens: a channel's studio is still behind the sign-in.
    expect(gateDecision("/chronos/studio", false)).toBe("to-login");
    expect(gateDecision("/studio/x", false)).not.toBe("pass");
  });

  it("is listed in the sitemap and in next.config's .rsc redirects", () => {
    expect(SITEMAP_PATHS).toContain("/studio");
    expect(PUBLIC_PAGE_PATHS).toContain("/studio");
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    const entries = sitemap();
    const hit = entries.find((e) => e.url === "https://nightshift.example/studio");
    expect(hit).toBeTruthy();
    expect(hit!.priority).toBeGreaterThan(0.6);
    expect(entries.map((e) => e.url).filter((u) => u.endsWith("/studio"))).toHaveLength(1);
  });

  it.each(LOCALES)("%s: title, description, canonical, OpenGraph and Twitter card use the shared og image", async (locale) => {
    dict.locale = locale;
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    const t = dictionaries[locale];
    const m = await generateMetadata();
    expect(m.title).toEqual({ absolute: t.site.studioPage.meta.title });
    expect(m.description).toBe(t.site.studioPage.meta.description);
    expect(m.description!.length).toBeLessThanOrEqual(200);
    expect(m.alternates?.canonical).toBe("/studio");
    expect(String(m.metadataBase)).toBe("https://nightshift.example/");
    const og = m.openGraph as { url: string; title: string; locale: string; images: { url: string; alt: string; width: number; height: number }[] };
    expect(og.url).toBe("https://nightshift.example/studio");
    expect(og.title).toBe(t.site.studioPage.meta.title);
    expect(og.locale).toBe({ en: "en_US", ru: "ru_RU", uz: "uz_UZ" }[locale]);
    expect(og.images[0]).toMatchObject({ url: "https://nightshift.example/og.png", width: 1200, height: 630, alt: t.landing.meta.ogAlt });
    const tw = m.twitter as { card: string; images: { url: string }[] };
    expect(tw.card).toBe("summary_large_image");
    expect(tw.images[0].url).toBe("https://nightshift.example/og.png");
    // One URL serves all three languages, so there are no per-language alternates to declare.
    expect(m.alternates).not.toHaveProperty("languages");
    dict.locale = "en";
  });

  it("with no known origin the card has no image and no canonical (never localhost)", async () => {
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    const m = await generateMetadata();
    expect(JSON.stringify(m)).not.toMatch(/localhost/);
    expect(m.alternates).toBeUndefined();
  });
});
