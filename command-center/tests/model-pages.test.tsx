// @vitest-environment jsdom
/**
 * The public model pages (/models, /models/<slug>): what would break without these.
 *
 * - The facts the pages print drift from schemas/model_registry.json (the copy is what the web image is built with).
 * - A page claims what nobody can back: "on sale", a price, a speed, a rating; or shows a "Powered by" line, a link to a maker or
 *   a visible pause button (owner's rule, 2026-11-13).
 * - A model is named outside its own box, or a page exists for a model with no real sample.
 * - The gate opens more than one-segment model URLs, or closes them; the sitemap, llms.txt and the built slugs disagree.
 *
 * The real data file and its facts are read as shipped; only the generated file module is replaced (a Vite test cannot resolve
 * a `.webp` import to Next's `{ src }`), with paths shaped like Next's, so the share card and JSON-LD can be checked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/models",
  useRouter: () => ({ push() {}, refresh() {}, back() {}, replace() {}, prefetch() {} }),
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
  headers: async () => new Headers(),
}));
const dict = vi.hoisted(() => ({ locale: "en" as "en" | "ru" | "uz" }));
vi.mock("@/lib/i18n/server", async () => {
  const { dictionaries } = await import("@/lib/i18n");
  return { getDictionary: async () => ({ locale: dict.locale, t: dictionaries[dict.locale] }), getLocale: async () => dict.locale };
});
vi.mock("@/components/site/showcase-assets", async () => {
  const raw = (await import("@/lib/site/showcase.json")).default as { entries: { jobId: string; kind: string }[] };
  const m = "/_next/static/media";
  return {
    SHOWCASE_FILES: Object.fromEntries(
      raw.entries.map((e) => [
        e.jobId,
        {
          poster: `${m}/${e.jobId}-poster.webp`,
          posterSm: `${m}/${e.jobId}-poster-sm.webp`,
          clip: e.kind === "video" ? { mp4: `${m}/${e.jobId}.mp4`, webm: `${m}/${e.jobId}.webm`, smMp4: `${m}/${e.jobId}-sm.mp4`, smWebm: `${m}/${e.jobId}-sm.webm` } : null,
        },
      ]),
    ),
  };
});

import { dictionaries, fmt, LOCALES as LOCALE_LIST, type Locale } from "@/lib/i18n";
import showcaseRaw from "@/lib/site/showcase.json";
import factsRaw from "@/lib/site/model-facts.json";
import { SHOWCASE_ENTRIES } from "@/lib/site/showcase";
import {
  MODEL_FACTS,
  buildModelPages,
  durationText,
  heroSample,
  modelAvailability,
  modelPageJsonLd,
  modelSlug,
  parseModelFacts,
  type ModelFacts,
  type ModelPage,
} from "@/lib/site/model-pages";
import { MODEL_PAGES, SAMPLE_ITEMS, modelPageHref } from "@/components/site/model-catalog";
import { ModelDetailView, ModelIndexView } from "@/components/site/ModelPages";
import { ShowcaseGallery } from "@/components/site/ShowcaseGallery";
import { MODELS_PATH, gateDecision, isModelPagePath } from "@/lib/public-paths";
import { listedPagePaths } from "@/lib/site-pages";
import { llmsTxt } from "@/lib/llms";
import { PUBLIC_PAGE_PATHS } from "../next.config";
import sitemap from "@/app/sitemap";
import * as indexRoute from "@/app/models/page";
import * as slugRoute from "@/app/models/[slug]/page";
import { projectModelFacts, renderModelFacts } from "../scripts/export-model-facts.mjs";
import { PROVIDER_BRANDS } from "./helpers/brands";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  dict.locale = "en";
});

const ROOT = join(__dirname, "..");
const LOCALES: Locale[] = LOCALE_LIST.map((l) => l.code);
const ORIGIN = "https://nightshift.example";
const TODAY = new Date("2026-11-13T12:00:00Z");
const MAKER_LINK = /runway(?:ml)?\.com|ideogram\.ai|minimax(?:i)?\.(?:io|com)|powered by/i;
const MONEY = /[$€£₽]\s?\d|\d\s?(?:USD|EUR|UZS|RUB|so['ʻ’]m|сум|credits?|кредит|kredit)\b/i;
const SPEED = /\b\d+\s?(?:s|sec|seconds|min|minutes|с|сек|секунд|мин|soniya|daqiqa)\b[^.]*\b(?:to (?:make|generate)|генер|yarat)/i;

function page(id: string): ModelPage {
  const p = MODEL_PAGES.find((x) => x.facts.id === id);
  if (!p) throw new Error(`no page for ${id}`);
  return p;
}

function renderDetail(p: ModelPage, locale: Locale = "en", now: Date = TODAY, signedIn = false) {
  return render(<ModelDetailView t={dictionaries[locale]} locale={locale} page={p} pages={MODEL_PAGES} all={SAMPLE_ITEMS} signedIn={signedIn} now={now} />);
}

describe("the facts copy (lib/site/model-facts.json)", () => {
  it("equals the registry's public half for every sampled model: on a mismatch run `node command-center/scripts/export-model-facts.mjs`", () => {
    const registry = JSON.parse(readFileSync(join(ROOT, "..", "schemas", "model_registry.json"), "utf8"));
    const expected = renderModelFacts(projectModelFacts(registry, showcaseRaw));
    expect(readFileSync(join(ROOT, "lib/site/model-facts.json"), "utf8")).toBe(expected);
  });

  it("parses every model it holds (a malformed one would silently lose its page)", () => {
    expect(MODEL_FACTS.length).toBe((factsRaw as { models: unknown[] }).models.length);
  });

  it("carries no price, credit unit, terms note or maker credit line", () => {
    const text = JSON.stringify(factsRaw);
    expect(text).not.toMatch(/usd|pricing|credit_unit|terms|attribution|powered by|https?:/i);
  });

  it("refuses a malformed model rather than guessing a field", () => {
    const good = (factsRaw as { models: Record<string, unknown>[] }).models[0];
    expect(parseModelFacts(good)).not.toBeNull();
    for (const bad of [{ ...good, output: "audio" }, { ...good, aspectRatios: ["wide"] }, { ...good, durationsS: [-1] }, { ...good, operatorPreview: "true" }, { ...good, capabilities: [] }]) {
      expect(parseModelFacts(bad)).toBeNull();
    }
  });
});

describe("which models get a page", () => {
  it("every model with a shipped sample and facts, and no other; each lists exactly its own samples", () => {
    const sampled = new Set(SHOWCASE_ENTRIES.map((e) => e.modelId));
    expect(MODEL_PAGES.length).toBeGreaterThan(0);
    expect(new Set(MODEL_PAGES.map((p) => p.facts.id))).toEqual(new Set([...sampled].filter((id) => MODEL_FACTS.some((f) => f.id === id))));
    for (const p of MODEL_PAGES) {
      expect(p.samples.map((s) => s.e.jobId)).toEqual(SHOWCASE_ENTRIES.filter((e) => e.modelId === p.facts.id).map((e) => e.jobId));
      expect(p.samples).toContain(p.hero);
    }
  });

  it("slugs are the id with dots as dashes, unique, and the shape the gate passes", () => {
    expect(modelSlug("runway-gen4.5")).toBe("runway-gen4-5");
    expect(modelSlug("ideogram-4.5")).toBe("ideogram-4-5");
    expect(modelSlug("minimax-h3")).toBe("minimax-h3");
    expect(modelSlug("a..b")).toBeNull();
    const slugs = MODEL_PAGES.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const p of MODEL_PAGES) expect(isModelPagePath(p.path), p.path).toBe(true);
    for (const id of ["minimax-h3", "runway-gen4.5", "ideogram-4.5"]) expect(modelPageHref(id)).toBe(`/models/${modelSlug(id)}`);
  });

  it("two ids that would share a slug get no page at all, never one page for two models", () => {
    const f = MODEL_FACTS[0];
    const a: ModelFacts = { ...f, id: "same-1.5" };
    const b: ModelFacts = { ...f, id: "same-1-5" };
    const items = SAMPLE_ITEMS.slice(0, 1).flatMap((s) => [{ ...s, e: { ...s.e, modelId: a.id } }, { ...s, e: { ...s.e, modelId: b.id, jobId: `${s.e.jobId}x` } }]);
    expect(buildModelPages(items, [a, b])).toEqual([]);
    // Either one alone gets its page.
    expect(buildModelPages(items, [a]).map((p) => p.slug)).toEqual(["same-1-5"]);
  });

  it("leads with a sample that plays over a still", () => {
    const withClip = MODEL_PAGES.find((p) => p.samples.some((s) => s.e.kind === "video" && s.f.clip));
    if (withClip) expect(heroSample(withClip.samples)?.f.clip).not.toBeNull();
  });

  it("every tool a page model has is named in every language (a missing label would hide a capability)", () => {
    for (const p of MODEL_PAGES) {
      for (const cap of p.facts.capabilities) {
        for (const l of LOCALES) expect((dictionaries[l].site.modelPages.caps as Record<string, string>)[cap], `${l} ${cap}`).toBeTruthy();
      }
    }
  });
});

describe("the gate", () => {
  it("/models is the page signed out and the app's Models section signed in (like /studio)", () => {
    expect(gateDecision("/models", false)).toBe("pass");
    expect(gateDecision("/models/", false)).toBe("pass");
    expect(gateDecision("/models", true)).toBe("app");
  });

  it("a model's page is public to everyone; nothing deeper, dotted or upper-case is", () => {
    for (const p of MODEL_PAGES) {
      expect(gateDecision(p.path, false)).toBe("pass");
      expect(gateDecision(p.path, true)).toBe("pass");
    }
    for (const p of ["/models/x/y", "/models/a.rsc", "/models/Foo", "/models/-a", "/models/a--b", "/chronos/models", "/modelsx"]) {
      expect(gateDecision(p, false), p).not.toBe("pass");
    }
    expect(gateDecision("/chronos/models", true)).toBe("app");
  });

  it("builds exactly the listed slugs and nothing else (any other slug is the 404)", () => {
    expect(slugRoute.dynamicParams).toBe(false);
    expect(slugRoute.generateStaticParams()).toEqual(MODEL_PAGES.map((p) => ({ slug: p.slug })));
  });

  it("/models has no .rsc form (next.config PUBLIC_PAGE_PATHS)", () => {
    expect(PUBLIC_PAGE_PATHS).toContain(MODELS_PATH);
  });
});

describe("sitemap and llms.txt", () => {
  it("the sitemap lists /models and every model page once", () => {
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    const paths = sitemap().map((e) => new URL(e.url).pathname);
    expect(paths).toContain(MODELS_PATH);
    for (const p of MODEL_PAGES) expect(paths.filter((x) => x === p.path)).toHaveLength(1);
  });

  it("llms.txt lists /models but no model's page, and still names no model", () => {
    expect(listedPagePaths(false)).toContain(MODELS_PATH);
    const txt = llmsTxt(ORIGIN, false);
    expect(txt).toContain(`${ORIGIN}/models)`);
    for (const p of MODEL_PAGES) expect(txt).not.toContain(p.path + ")");
    expect(txt).not.toMatch(PROVIDER_BRANDS);
  });
});

describe.each(LOCALES)("a model's page (%s)", (locale) => {
  it("shows every sample of the model once, each AI-generated, named, with its words and a Studio link, and the other models", () => {
    for (const p of MODEL_PAGES) {
      const { container, unmount } = renderDetail(p, locale);
      const g = dictionaries[locale].site.gallery;
      const cards = [...container.querySelectorAll("[data-showcase-entry]")].filter((c) => c.getAttribute("data-model") === p.facts.id);
      expect(cards.map((c) => c.getAttribute("data-showcase-entry")).sort(), p.slug).toEqual(p.samples.map((s) => s.e.jobId).sort());
      for (const c of cards) {
        const entry = p.samples.find((s) => s.e.jobId === c.getAttribute("data-showcase-entry"))!.e;
        expect(c.textContent).toContain(g.badge);
        expect(c.textContent).toContain(entry.modelName);
        expect(c.textContent).toContain(entry.prompt.trim() ? entry.prompt : g.noPrompt);
        const link = c.querySelector("a.nx-gallery-try");
        expect(link?.getAttribute("href"), entry.jobId).toMatch(/^\/signup\?next=/);
      }
      expect(container.querySelectorAll("h1")).toHaveLength(1);
      expect(container.querySelector("h1")?.textContent).toBe(p.facts.name);
      for (const other of MODEL_PAGES.filter((x) => x !== p)) expect(container.querySelector(`a[href="${other.path}"]`), other.path).not.toBeNull();
      unmount();
    }
  });

  it("says today's truth about the Studio: no model is in it yet, none is on sale, none has a price", () => {
    const m = dictionaries[locale].site.modelPages;
    for (const p of MODEL_PAGES) {
      // Today every sampled model is an operator preview (the registry); the day one is not, this line says what changed.
      expect(modelAvailability(p.facts, TODAY), p.slug).toBe("preview");
      const { container, unmount } = renderDetail(p, locale);
      const text = container.textContent ?? "";
      expect(text).toContain(m.availability.preview);
      expect(text).toContain(m.price.none);
      expect(text).not.toContain(m.availability.unknown);
      expect(text).not.toMatch(MONEY);
      expect(text).not.toMatch(SPEED);
      unmount();
    }
  });

  it("shows no maker credit, no link to a maker and no visible pause button (owner's rule, 2026-11-13)", () => {
    for (const p of MODEL_PAGES) {
      const { container, unmount } = renderDetail(p, locale);
      expect(container.innerHTML).not.toMatch(MAKER_LINK);
      for (const a of container.querySelectorAll("a[href]")) expect(a.getAttribute("href"), a.outerHTML).toMatch(/^\//);
      expect(container.querySelector(".nx-clip-pause")).toBeNull();
      // A clip pauses by touch: one transparent toggle over it, named for a keyboard, with no visible word.
      for (const tap of container.querySelectorAll("button.ml-tap")) {
        expect(tap.getAttribute("aria-label")).toBe(dictionaries[locale].site.fx.pause);
        expect(tap.textContent).toBe("");
        expect(tap.closest("[data-clip]")).not.toBeNull();
      }
      unmount();
    }
  });

  it("names a model only inside its page or a sample's box", () => {
    for (const p of MODEL_PAGES.slice(0, 2)) {
      const { container, unmount } = renderDetail(p, locale);
      const root = container.querySelector("[data-model-page]")!;
      expect(root.getAttribute("data-model-page")).toBe(p.facts.id);
      const copy = root.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("[data-showcase-entry]").forEach((n) => n.remove());
      // Outside the sample boxes only this page's own model is named (heading, lead, crumbs), never another maker's brand.
      const rest = (copy.textContent ?? "").split(p.facts.name).join("");
      expect(rest).not.toMatch(PROVIDER_BRANDS);
      unmount();
    }
  });

  it("the index lists every model page with its lead sample, AI-generated, and a link", () => {
    const { container } = render(<ModelIndexView t={dictionaries[locale]} pages={MODEL_PAGES} />);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    const tiles = [...container.querySelectorAll("li[data-showcase-entry]")];
    expect(tiles.map((t) => t.getAttribute("data-model"))).toEqual(MODEL_PAGES.map((p) => p.facts.id));
    for (const [i, tile] of tiles.entries()) {
      expect(tile.querySelector(`a[href="${MODEL_PAGES[i].path}"]`)).not.toBeNull();
      expect(tile.textContent).toContain(dictionaries[locale].site.gallery.badge);
    }
    expect(container.innerHTML).not.toMatch(MAKER_LINK);
  });

  it("metadata: title and description fit a search result, canonical is the page, the share card is the model's own still", async () => {
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    dict.locale = locale;
    for (const p of MODEL_PAGES) {
      const m = (await slugRoute.generateMetadata({ params: Promise.resolve({ slug: p.slug }) })) as {
        title: { absolute: string };
        description: string;
        alternates: { canonical: string };
        openGraph: { url: string; images: { url: string; width: number; height: number; alt: string }[] };
        twitter: { card: string; images: { url: string }[] };
      };
      expect(m.title.absolute).toContain(p.facts.name);
      expect(m.title.absolute.length, m.title.absolute).toBeLessThanOrEqual(70);
      expect(m.description.length, m.description).toBeLessThanOrEqual(160);
      expect(m.description.length).toBeGreaterThanOrEqual(40);
      expect(m.alternates.canonical).toBe(p.path);
      expect(m.openGraph.url).toBe(`${ORIGIN}${p.path}`);
      const poster = `${ORIGIN}${p.hero.f.poster}`;
      expect(m.openGraph.images).toEqual([{ url: poster, width: p.hero.e.width, height: p.hero.e.height, alt: fmt(dictionaries[locale].site.modelPages.meta.ogAlt, { model: p.facts.name }), type: "image/webp" }]);
      expect(m.twitter.card).toBe("summary_large_image");
      expect(m.twitter.images[0].url).toBe(poster);
    }
    const idx = (await indexRoute.generateMetadata()) as { alternates: { canonical: string }; title: { absolute: string } };
    expect(idx.alternates.canonical).toBe(MODELS_PATH);
    expect(idx.title.absolute).not.toMatch(PROVIDER_BRANDS);
  });
});

describe("what the page says when the flags change", () => {
  const p = MODEL_PAGES[0];
  const as = (f: Partial<ModelFacts>): ModelPage => ({ ...p, facts: { ...p.facts, ...f } });

  it("a model whose shutdown day has come says it is gone, with the day", () => {
    const { container } = renderDetail(as({ operatorPreview: false, shutdownOn: "2026-11-01" }));
    expect(container.textContent).toContain(fmt(dictionaries.en.site.modelPages.availability.gone, { date: "November 1, 2026" }));
  });

  it("a model with neither flag claims nothing: the Studio shows what a workspace can choose and the price", () => {
    const m = dictionaries.en.site.modelPages;
    const { container } = renderDetail(as({ operatorPreview: false, shutdownOn: null }));
    expect(container.textContent).toContain(m.availability.unknown);
    expect(container.textContent).toContain(m.price.studio);
    expect(container.textContent).not.toMatch(/on sale now|available now|buy now/i);
  });

  it("a row with nothing in the registry is left out, never filled with a default", () => {
    const m = dictionaries.en.site.modelPages.can;
    const { container } = renderDetail(as({ resolutions: [], durationsS: [], aspectRatios: [] }));
    const terms = [...container.querySelectorAll(".ml-facts dt")].map((d) => d.textContent);
    expect(terms).not.toContain(m.resolutions);
    expect(terms).not.toContain(m.lengths);
    expect(terms).not.toContain(m.ratios);
  });

  it("lengths read as a range only when there is no gap", () => {
    const r = (a: string, b: string) => `${a}–${b}`;
    const one = (n: string) => `${n}s`;
    expect(durationText([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], r, one)).toBe("4–15");
    expect(durationText([5, 10], r, one)).toBe("5s, 10s");
    expect(durationText([], r, one)).toBeNull();
  });
});

describe("structured data", () => {
  it("is breadcrumbs and the samples, with no rating, review, offer or price; nothing without an origin", () => {
    for (const p of MODEL_PAGES) {
      const ld = modelPageJsonLd({ page: p, origin: ORIGIN, title: "t", description: "d", homeName: "Home", modelsName: "Models", noPrompt: "none" });
      const text = JSON.stringify(ld);
      expect(text).not.toMatch(/aggregateRating|review|offers|price|"author"|"publisher"|"brand"/i);
      expect(ld.map((d) => d["@type"])).toEqual(["BreadcrumbList", "CollectionPage"]);
      const parts = (ld[1] as { hasPart: { "@type": string; uploadDate: string }[] }).hasPart;
      expect(parts).toHaveLength(p.samples.length);
      for (const [i, s] of p.samples.entries()) {
        expect(parts[i]["@type"]).toBe(s.e.kind === "video" && s.f.clip ? "VideoObject" : "ImageObject");
        expect(parts[i].uploadDate).toBe(s.e.createdAt);
      }
      expect(modelPageJsonLd({ page: p, origin: null, title: "t", description: "d", homeName: "H", modelsName: "M", noPrompt: "n" })).toEqual([]);
    }
  });
});

describe("links in from the landing", () => {
  it("each explore card names its model as a link to the model's page", () => {
    const { container } = render(<ShowcaseGallery t={dictionaries.en} locale="en" />);
    for (const card of container.querySelectorAll("[data-showcase-entry]")) {
      const href = modelPageHref(card.getAttribute("data-model") ?? "");
      if (href) expect(card.querySelector(`.nx-gallery-model a[href="${href}"]`), href).not.toBeNull();
    }
  });
});
