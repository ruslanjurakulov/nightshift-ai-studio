// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/roadmap",
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
import { RoadmapPage } from "@/components/site/RoadmapPage";
import { roadmapEn } from "@/lib/i18n/roadmap/en";
import { roadmapRu } from "@/lib/i18n/roadmap/ru";
import { roadmapUz } from "@/lib/i18n/roadmap/uz";
import { ROADMAP_ITEMS, ROADMAP_ITEM_IDS, shownNames } from "@/lib/roadmap";
import { BANNED_PROVIDER_NAMES, bannedHits } from "@/lib/marketing-banned";
import { ROADMAP_PATH, RESERVED_ROOT_SEGMENTS, SITEMAP_PATHS, gateDecision, isAlwaysPublicPath } from "@/lib/public-paths";
import { isValidChannelId } from "@/lib/channels";
import { UNCOUNTED_PAGE_PATHS, listedPagePaths } from "@/lib/site-pages";
import { llmsTxt } from "@/lib/llms";
import { PUBLIC_PAGE_PATHS } from "../next.config";
import sitemap from "@/app/sitemap";
import { generateMetadata } from "@/app/roadmap/page";
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
const COPY = { en: roadmapEn, ru: roadmapRu, uz: roadmapUz } as const;

function renderPage(locale: (typeof LOCALES)[number]) {
  const t = dictionaries[locale];
  return render(
    <PublicI18nProvider locale={locale} t={publicDictionary(t)}>
      <PublicShell t={t} fresh>
        <RoadmapPage t={t} />
      </PublicShell>
    </PublicI18nProvider>,
  );
}

/** Every string of a dictionary, joined: what the page can ever say. */
const allText = (v: unknown): string =>
  Array.isArray(v) ? v.map(allText).join("\n") : v && typeof v === "object" ? Object.values(v).map(allText).join("\n") : typeof v === "string" ? v : "";

/**
 * The owner's approved Uzbek text (2026-11-11), word for word as it was handed over, and the only changes made to it.
 * A change that is not listed here fails the master-text test below; each one is also listed in the PR body.
 */
const APPROVED_UZ = {
  title: "Kutilayotgan yangiliklar",
  items: [
    ["Professional video editor", "koʻp qatlamli vaqt chizigʻi, effektlar va animatsiyalar, ritmga moslash, rang va maskalar, jimlikni avtomatik kesish, subtitrlar, ovoz yozish, 4K eksport"],
    ["Eng kuchli video AI modellar", "matndan va rasmdan video, videoni tahrirlash, qahramonni almashtirish, har biri oʻz yaratuvchisining API'si orqali"],
    // 2026-11-21 (L1-01): the owner's text had no description here; the one line was added because a bare title read as unfinished.
    ["Rasm, ovoz va musiqa yaratish", "qisqa tavsifdan rasm, ovoz va musiqa yaratib, ularni videongizda ishlatish"],
    ["Reklama fabrikasi", "saytingizni skanerlab brendingizga mos reklama tayyorlash"],
    ["Namunalar galereyasi", "har bir model natijasini koʻrib, bir tugma bilan sinab koʻrish"],
    ["Ijtimoiy tarmoqlarga avtomatik joylash", "tayyor videoni studiyadan chiqmasdan YouTube, Instagram va boshqa ijtimoiy tarmoqlarga sizning roziligingiz bilan yuborish va vaqtini rejalashtirish."],
  ],
  closing: ["Hammasi bitta studiyada.", "NIGHTSHIFT siz uchun hammasini bir joyga yigʻadi.", "Tez orada."],
} as const;
const WORDING_CHANGES: readonly [from: string, to: string, why: string][] = [
  ["Eng kuchli", "Kuchli va zamonaviy", "banned superlative: docs/news/banned-claims.json rule superlative, \\beng\\s+(yaxshi|zo'r|tez|arzon|kuchli)"],
  ["API'si", "API’si", "an ASCII apostrophe inside a word fails tests/uz-apostrophes.test.ts; a suffix after a Latin name takes U+2019"],
];
const applyChanges = (s: string) => WORDING_CHANGES.reduce((acc, [from, to]) => acc.split(from).join(to), s);

/** The makers we have written to, and the ones the registry uses: none may appear on the page while nothing is nameable. */
const MAKERS = [
  "BytePlus", "ByteDance", "Kling", "Kuaishou", "Recraft", "Luma", "MiniMax", "Hailuo", "Alibaba", "Qwen", "Black Forest", "BFL", "Vidu",
  "Shengshu", "Pika", "LTX", "Lightricks", "Magnific", "Krea", "Sonilo", "AssemblyAI", "OpenAI", "Google", "Gemini", "Veo", "Ideogram",
  "ElevenLabs", "Runway", "xAI", "Grok", "Seedance", "Seedream", "Flux", "Wan",
];
const nameRe = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}_-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_-])`, "iu");

describe("/roadmap copy", () => {
  it("is complete in ru and uz with the same shape and ids as en", () => {
    const shape = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(shape) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v === "string" ? (v.trim() === "" ? "EMPTY" : "TEXT") : typeof v;
    expect(shape(roadmapRu)).toEqual(shape(roadmapEn));
    expect(shape(roadmapUz)).toEqual(shape(roadmapEn));
    for (const c of Object.values(COPY)) expect(c.items.map((i) => i.id)).toEqual([...ROADMAP_ITEM_IDS]);
  });

  it("the uz master text is the owner's approved text, apart from the listed wording changes", () => {
    expect(roadmapUz.title).toBe(APPROVED_UZ.title);
    expect(roadmapUz.items.map((i) => [i.title, i.body ?? ""])).toEqual(APPROVED_UZ.items.map(([title, body]) => [applyChanges(title), applyChanges(body)]));
    expect([roadmapUz.closing.title, roadmapUz.closing.body, roadmapUz.closing.soon]).toEqual([...APPROVED_UZ.closing]);
    // Every listed change was needed: the approved wording really fails the rule it names.
    expect(bannedHits({ uz: "Eng kuchli video AI modellar" }).map((h) => h.id)).toContain("superlative");
    expect(/[A-Za-z]'[a-z]/.test("API'si")).toBe(true);
  });

  it.each(LOCALES)("%s: passes the banned-claims and banned-names check (docs/news/banned-claims.json)", (locale) => {
    expect(bannedHits({ [locale]: allText(COPY[locale]) })).toEqual([]);
  });

  it.each(LOCALES)("%s: names no AI provider, model family or competitor (tests/helpers/brands.ts), and no price or date", (locale) => {
    const all = allText(COPY[locale]);
    expect(all).not.toMatch(PROVIDER_BRANDS);
    expect(all).not.toMatch(/[$€£₽]\s?\d|\d\s?(?:USD|EUR|UZS|RUB|credits?|kredit\w*|кредит\w*)\b/i);
    expect(all).not.toMatch(/\b20\d\d\b/);
  });

  it("uses the Uzbek letters ʻ / ʼ, never a straight apostrophe after o or g", () => {
    const all = allText(roadmapUz);
    expect(all).not.toMatch(/[oOgG]'/);
    expect(all).toContain("ʻ");
  });
});

describe("names are shown only when an item is nameable", () => {
  it("ships with every item not nameable and with no names", () => {
    expect(ROADMAP_ITEMS.map((i) => i.id)).toEqual([...ROADMAP_ITEM_IDS]);
    for (const item of ROADMAP_ITEMS) {
      expect(item.nameable, item.id).toBe(false);
      expect(item.names, item.id).toEqual([]);
    }
  });

  it("shownNames gives nothing for an item that is not nameable, even when it carries names", () => {
    expect(shownNames({ nameable: false, names: ["Some Maker"] })).toEqual([]);
    expect(shownNames({ nameable: true, names: ["Some Maker"] })).toEqual(["Some Maker"]);
  });

  it("a nameable name must already be off every banned provider list (the owner clears it in the same PR)", () => {
    for (const item of ROADMAP_ITEMS) {
      for (const name of shownNames(item)) {
        expect(name, item.id).not.toMatch(PROVIDER_BRANDS);
        expect(BANNED_PROVIDER_NAMES.some((b) => nameRe(b).test(name)), `${item.id}: ${name}`).toBe(false);
      }
    }
  });

  it.each(LOCALES)("%s: the rendered page shows no maker or model name", (locale) => {
    const { container } = renderPage(locale);
    const main = container.querySelector("main")!.textContent!;
    // Not nameable: nothing an item carries reaches the page; and no maker we know of is named in the copy either.
    for (const item of ROADMAP_ITEMS) if (!item.nameable) for (const name of item.names) expect(main).not.toMatch(nameRe(name));
    for (const name of [...MAKERS, ...BANNED_PROVIDER_NAMES]) expect(main, name).not.toMatch(nameRe(name));
    expect(container.querySelectorAll(".rm-item-names")).toHaveLength(0);
  });
});

describe("/roadmap page", () => {
  it.each(LOCALES)("%s: one h1, an h2 per item and for the closing line, in the approved order, landmarks single", (locale) => {
    const r = dictionaries[locale].site.roadmap;
    const { container } = renderPage(locale);
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([r.title]);
    const main = container.querySelector("main")!;
    const h2 = [...main.querySelectorAll("h2")].map((h) => h.textContent);
    expect(h2).toEqual([...r.items.map((i) => i.title), r.closing.title]);
    for (const item of r.items) if (item.body) expect(main.textContent).toContain(item.body);
    // An item with no description would render its title alone; "create" has one now, so it shows a paragraph.
    expect(main.querySelectorAll('[data-id="create"] p')).toHaveLength(1);
    expect(main.textContent).toContain(r.closing.body);
    // Not the landing's .nx-sub, which site-next.css hides inside .nx-final on a phone: the closing line must show at every width.
    expect(main.querySelector(".rm-closing .nx-sub")).toBeNull();
    expect(main.textContent).toContain(r.closing.soon);
    const levels = [...container.querySelectorAll("h1,h2,h3,h4")].map((h) => Number(h.tagName[1]));
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1], `heading ${i}`).toBeLessThanOrEqual(1);
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelectorAll("header")).toHaveLength(1);
    expect(container.querySelectorAll("footer")).toHaveLength(1);
    for (const s of main.querySelectorAll("section[aria-labelledby]")) {
      expect(container.querySelector(`#${s.getAttribute("aria-labelledby")}`)).not.toBeNull();
    }
  });

  it("has no status, button, form, picture or script of its own", () => {
    const { container } = renderPage("uz");
    const main = container.querySelector("main")!;
    expect(main.querySelectorAll("button, form, input, img, video, iframe, script")).toHaveLength(0);
    expect(main.querySelectorAll("a")).toHaveLength(0);
    for (const word of ["Ishlayapti", "Qurilmoqda", "Rejada", "tasdigʻini kutmoqda"]) expect(main.textContent).not.toContain(word);
  });

  it.each(LOCALES)("%s: the footer links to /roadmap; the header links it only inside its Resources panel, not on the bar", (locale) => {
    const r = dictionaries[locale].site.roadmap;
    const { container } = renderPage(locale);
    const footer = container.querySelector("footer")!;
    expect(within(footer).getByRole("link", { name: r.footer }).getAttribute("href")).toBe("/roadmap");
    // The bar keeps its five items; /roadmap is one of the Resources panel's links (lib/public-nav.ts) and the sheet's.
    expect(container.querySelector('header nav.st-nav > a[href="/roadmap"]')).toBeNull();
    expect(container.querySelectorAll('header .st-mm a[href="/roadmap"]')).toHaveLength(1);
  });

  it("the stylesheet keeps a phone free of sideways scroll: one column below 760 px, long words wrap", () => {
    const css = readFileSync(join(__dirname, "..", "components/site/roadmap-page.css"), "utf8");
    expect(css).toMatch(/\.rm-list \{[^}]*grid[^}]*\}/);
    expect(css).toMatch(/@media \(min-width: 760px\) \{ \.rm-list \{ grid-template-columns/);
    expect(css).toMatch(/\.rm-item \{[^}]*min-width: 0/);
    expect(css).toMatch(/\.rm-item-body \{[^}]*overflow-wrap: anywhere/);
    // Tokens only: no colour typed into this file.
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});

describe("/roadmap in the public paths, the sitemap, llms.txt and the metadata", () => {
  it("is public to everyone, and nothing under it opens", () => {
    expect(ROADMAP_PATH).toBe("/roadmap");
    expect(isAlwaysPublicPath("/roadmap")).toBe(true);
    expect(gateDecision("/roadmap", false)).toBe("pass");
    expect(gateDecision("/roadmap/", false)).toBe("pass");
    expect(gateDecision("/roadmap", true)).toBe("pass");
    expect(gateDecision("/roadmap/x", false)).toBe("to-login");
  });

  it("is a reserved word: no channel may take it as its id", () => {
    expect(RESERVED_ROOT_SEGMENTS).toContain("roadmap");
    expect(isValidChannelId("roadmap")).toBe(false);
    expect(isValidChannelId("roadmaps")).toBe(true);
  });

  it("is listed in the sitemap, llms.txt and next.config's .rsc list, but not counted (SITEMAP_PATHS is the 0104 SQL list)", () => {
    expect(SITEMAP_PATHS).not.toContain("/roadmap");
    expect(UNCOUNTED_PAGE_PATHS).toContain("/roadmap");
    expect(listedPagePaths(false)).toContain("/roadmap");
    expect(PUBLIC_PAGE_PATHS).toContain("/roadmap");
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    expect(sitemap().filter((e) => e.url === "https://nightshift.example/roadmap")).toHaveLength(1);
    const llms = llmsTxt("https://nightshift.example", false);
    expect(llms).toContain("https://nightshift.example/roadmap");
    expect(llms).toContain(roadmapEn.meta.description);
  });

  it.each(LOCALES)("%s: title, description, canonical, OpenGraph and Twitter card use the shared og image", async (locale) => {
    dict.locale = locale;
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    const t = dictionaries[locale];
    const m = await generateMetadata();
    expect(m.title).toEqual({ absolute: t.site.roadmap.meta.title });
    expect(m.description).toBe(t.site.roadmap.meta.description);
    expect(m.description!.length).toBeLessThanOrEqual(160);
    expect(m.alternates?.canonical).toBe("/roadmap");
    const og = m.openGraph as { url: string; title: string; locale: string; images: { url: string }[] };
    expect(og.url).toBe("https://nightshift.example/roadmap");
    expect(og.title).toBe(t.site.roadmap.meta.title);
    expect(og.locale).toBe({ en: "en_US", ru: "ru_RU", uz: "uz_UZ" }[locale]);
    expect(og.images[0].url).toBe("https://nightshift.example/og.png");
    expect((m.twitter as { card: string }).card).toBe("summary_large_image");
    dict.locale = "en";
  });
});
