// @vitest-environment jsdom
/**
 * The public landing "/" (components/landing/home/HomePage.tsx, S4). What would break without these:
 * - a clip on the page that is not our own Studio's output (stock footage or someone else's), or a broken frame for a missing file;
 * - a model shown as on sale that the Studio does not sell: the strip is the database's list (0193) or nothing, never a guess;
 * - "Works inside Claude and ChatGPT" said while their sign-in is off (MCP_OAUTH_LIVE);
 * - the trust section drifting from /trust (it quotes it);
 * - the hero sentence or any section missing in Russian or Uzbek.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, replace: _r, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; replace?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries, LOCALES } from "@/lib/i18n";
import { HomePage } from "@/components/landing/home/HomePage";
import { HERO_JOB, REEL, reelItem, studioPieces } from "@/components/landing/home/home-reel";
import { SHOWCASE_ITEMS } from "@/lib/showcase/items";
import { REGISTRY_NAMES } from "@/lib/creative/model-names";
import { existsSync } from "node:fs";
import { SHOWCASE_ENTRIES } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { parsePublicModels } from "@/lib/public-models";
import { packExpiry } from "@/lib/plans";
import { CREDIT_EXPIRY_MONTHS } from "@/lib/legal";

afterEach(cleanup);

const ANNOUNCED = { kind: "announced" } as const;

function page(code: (typeof LOCALES)[number]["code"], opts: { models?: Parameters<typeof HomePage>[0]["models"]; live?: boolean } = {}) {
  const t = dictionaries[code];
  return render(<HomePage t={t} locale={code} pricing={ANNOUNCED} rates={null} models={opts.models ?? null} oauthLive={opts.live ?? false} expiry={packExpiry(null, CREDIT_EXPIRY_MONTHS)} dodo={false} />);
}

describe("the landing's pictures are our own Studio's", () => {
  it("the hero is a showcase entry (a real generation) with its own clip files", () => {
    const e = SHOWCASE_ENTRIES.find((x) => x.jobId === HERO_JOB);
    expect(e, "not in lib/site/showcase.json").toBeTruthy();
    expect(e?.kind).toBe("video");
    expect(SHOWCASE_FILES[HERO_JOB]?.clip).toBeTruthy();
    expect(reelItem(HERO_JOB)).not.toBeNull();
  });

  it.each(SHOWCASE_ITEMS.map((x) => [x.slug, x] as const))("%s: its files are in public/showcase/ and the registry names its model", (slug, it) => {
    const root = process.cwd();
    expect(existsSync(path.join(root, "public/showcase", `${slug}.webp`)), "poster").toBe(true);
    if (it.kind === "video") expect(existsSync(path.join(root, "public/showcase", `${slug}.mp4`)), "clip").toBe(true);
    if (it.captions) {
      const vtt = readFileSync(path.join(root, "public/showcase", `${slug}.vtt`), "utf8");
      expect(vtt.startsWith("WEBVTT"), "captions file").toBe(true);
    }
    expect(it.modelIds.length).toBeGreaterThan(0);
    for (const id of it.modelIds) expect(REGISTRY_NAMES[id], `${id} is not a registry id`).toBeTruthy();
  });

  it("every reel entry resolves to a piece: nothing in REEL is silently left out, none repeats, none is the hero", () => {
    const pieces = studioPieces();
    expect(pieces.length).toBe(REEL.length);
    const ids = pieces.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(HERO_JOB);
    expect(ids[0]).toBe("de53f364-eaf7-4cd1-8d44-7b56b21b03b6");
    expect(pieces.length).toBeGreaterThanOrEqual(12);
  });

  it.each(REEL.filter((r) => r.from === "sample").map((r) => [(r as { jobId: string }).jobId] as const))(
    "sample %s is a real Studio job (lib/site/showcase.json) with its own small clip files and a registry-named model",
    (jobId) => {
      const e = SHOWCASE_ENTRIES.find((x) => x.jobId === jobId);
      expect(e, "not in lib/site/showcase.json").toBeTruthy();
      expect(e?.kind).toBe("video");
      expect(SHOWCASE_FILES[jobId]?.clip, "not wired in showcase-assets.ts").toBeTruthy();
      // The small renditions the reel plays (LoopClip together = the 640 files) and its small poster, on disk.
      const dir = path.join(process.cwd(), "components/site/showcase", jobId);
      for (const file of ["clip-sm.mp4", "clip-sm.webm", "poster-sm.webp"]) expect(existsSync(path.join(dir, file)), file).toBe(true);
      expect(REGISTRY_NAMES[e!.modelId], `${e!.modelId} is not a registry id`).toBeTruthy();
    },
  );

  it.each(REEL.filter((r) => r.from === "template").map((r) => [(r as { slug: string }).slug, r] as const))(
    "template %s: its preview and poster ship (public/templates, the manifest) and the registry names its model",
    (slug, r) => {
      const root = process.cwd();
      expect(existsSync(path.join(root, "public/templates", slug, "preview.mp4")), "preview").toBe(true);
      expect(existsSync(path.join(root, "public/templates", slug, "poster.webp")), "poster").toBe(true);
      const manifest = JSON.parse(readFileSync(path.join(root, "lib/templates/media-manifest.json"), "utf8"));
      expect(manifest[slug]).toEqual({ preview: true, poster: true });
      for (const id of (r as { modelIds: readonly string[] }).modelIds) expect(REGISTRY_NAMES[id], id).toBeTruthy();
      // The model credited is the one the template seeds (0183/0186): its preview was made with the template's own model.
      const seeds = ["0183_creative_templates.sql", "0186_viral_templates.sql"].map((m) => readFileSync(path.join(root, "..", "supabase", "migrations", m), "utf8")).join("\n");
      const seed = seeds.slice(seeds.indexOf(`('${slug}',`), seeds.indexOf(`('${slug}',`) + 4000);
      expect(seed).toContain(`'${(r as { modelIds: readonly string[] }).modelIds[0]}', '9:16'`);
    },
  );

  it.each(LOCALES.map((l) => l.code))("%s: every reel title the data does not carry is in the dictionary, and no title is orphaned", (code) => {
    const titles = dictionaries[code].landingHome.hero.reelTitles as Record<string, string>;
    const keys = REEL.flatMap((r) => (r.from === "studio" ? [] : [r.key]));
    for (const k of keys) expect(titles[k]?.trim(), `${code}.${k}`).toBeTruthy();
    expect(Object.keys(titles).sort()).toEqual([...keys].sort());
  });

  it("imports no stock clip (components/site/clip-assets.ts is Pexels footage)", () => {
    const root = process.cwd();
    for (const f of ["components/landing/home/HomePage.tsx", "components/landing/home/home-reel.ts", "components/site/StudioClip.tsx"]) {
      const src = readFileSync(path.join(root, f), "utf8");
      expect(src, f).not.toMatch(/from "@\/components\/site\/(clip-assets|PlaceFill|samples)"/);
    }
    // The landing reaches LoopClip only through StudioClip and ShowcaseClip, whose files come from our own lists.
    expect(readFileSync(path.join(root, "components/landing/home/HomePage.tsx"), "utf8")).not.toMatch(/from "@\/components\/site\/LoopClip"/);
  });

  it.each(LOCALES.map((l) => l.code))("%s: every piece is labelled AI-generated and credits the model that made it", (code) => {
    const { container } = page(code);
    const h = dictionaries[code].landingHome.hero;
    const pieces = studioPieces();
    const cards = [...container.querySelectorAll(".hm-reel-card")] as HTMLElement[];
    expect(cards.length).toBe(pieces.length);
    cards.forEach((card, i) => {
      const p = pieces[i];
      expect(card.dataset.piece).toBe(p.id);
      expect(within(card).getByText(h.ai)).toBeTruthy();
      const credit = card.querySelector(".hm-reel-credit")?.textContent ?? "";
      for (const m of p.models) expect(credit).toContain(m);
      expect(credit.startsWith(h.credit.split("{model}")[0])).toBe(true);
      const title = p.title ? p.title[code] : (h.reelTitles as Record<string, string>)[p.titleKey!];
      expect(card.querySelector(".hm-reel-title")?.textContent).toBe(title);
      const img = card.querySelector("img") as HTMLImageElement;
      // (jsdom's image imports carry no URL, so a sample's poster is checked on disk above, not here.)
      if (p.media.type !== "sample") expect(img.getAttribute("src")).toBe(p.poster);
      expect(img.getAttribute("loading")).toBe("lazy");
      // The figcaption carries the title; the picture says only what the eye gets from the badge, so nothing is read twice.
      expect(img.getAttribute("alt")).toBe(h.ai);
      expect(card.querySelector("[data-clip]") !== null).toBe(p.kind === "video");
    });
  });

  it.each(LOCALES.map((l) => l.code))("%s: a piece two models made credits both, joined in the visitor's language", (code) => {
    page(code);
    const h = dictionaries[code].landingHome.hero;
    const duo = document.querySelector('[data-piece="language-duo"] .hm-reel-credit')?.textContent;
    expect(duo).toBe(h.credit.replace("{model}", `Ideogram 4.5 ${h.and} MiniMax H3`));
  });

  it.each(LOCALES.map((l) => l.code))("%s: the credit line names its model exactly once", (code) => {
    const c = dictionaries[code].landingHome.hero.credit;
    expect(c.split("{model}").length - 1).toBe(1);
  });

  it("no clip is drawn while motion is not allowed (jsdom has no matchMedia): the poster is the picture", () => {
    const { container } = page("en");
    expect(container.querySelectorAll(".hm-reel-card video").length).toBe(0);
    expect(container.querySelectorAll(".hm-reel-card img").length).toBe(studioPieces().length);
  });
});

describe("the hero", () => {
  it.each(LOCALES.map((l) => l.code))("%s: the one sentence is the page's h1, then the idea box and the way to how it works", (code) => {
    const { container } = page(code);
    const h = dictionaries[code].landingHome.hero;
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(h.title);
    const hero = within(container.querySelector(".hm-hero") as HTMLElement);
    // The idea box is the first call to action: a labelled field and one button, in the visitor's language.
    expect(hero.getByLabelText(h.idea.label).tagName).toBe("TEXTAREA");
    expect(hero.getByRole("button", { name: new RegExp(h.idea.submit) })).toBeTruthy();
    expect(hero.getByText(h.idea.note)).toBeTruthy();
    expect(hero.getByRole("link", { name: h.secondary }).getAttribute("href")).toBe("#how");
  });

  it("says the brief's sentence in each language, the dash kept with the words before it", () => {
    expect(dictionaries.en.landingHome.hero.title).toBe("From idea to finished video — one Studio");
    expect(dictionaries.uz.landingHome.hero.title).toBe("Gʻoyadan tayyor videogacha — bitta Studio");
    expect(dictionaries.ru.landingHome.hero.title).toBe("От идеи до готового видео — одна Studio");
  });

  it("uses the display face, and its still is the first-screen picture (eager, high priority)", () => {
    const { container } = page("en");
    expect(screen.getByRole("heading", { level: 1 }).className).toContain("ds-display");
    const still = container.querySelector(".hm-hero-still") as HTMLImageElement;
    expect(still.getAttribute("loading")).toBeNull();
    expect(still.getAttribute("fetchpriority")).toBe("high");
    expect(still.getAttribute("width")).toBeTruthy();
    expect(still.getAttribute("height")).toBeTruthy();
  });
});

describe("how it works", () => {
  it.each(LOCALES.map((l) => l.code))("%s: three steps, Idea → Create → Export", (code) => {
    const { container } = page(code);
    const steps = [...container.querySelectorAll("#how .hm-step")].map((s) => (s as HTMLElement).dataset.step);
    expect(steps).toEqual(["idea", "create", "export"]);
  });
});

describe("the model strip is the database's list or nothing", () => {
  it("draws nothing when the list could not be read", () => {
    page("en", { models: null });
    expect(screen.queryByText(dictionaries.en.landingHome.models.title)).toBeNull();
  });

  it("draws nothing when nothing is on sale", () => {
    page("en", { models: [] });
    expect(screen.queryByText(dictionaries.en.landingHome.models.title)).toBeNull();
  });

  it("names exactly the models it was given", () => {
    page("en", { models: [{ name: "Model A", kinds: ["video"], adultOnly: false }, { name: "Model B", kinds: ["image", "voice"], adultOnly: false }] });
    const list = screen.getByRole("list", { name: dictionaries.en.landingHome.models.listLabel });
    expect(within(list).getAllByRole("listitem").map((li) => li.querySelector(".hm-model-name")?.textContent)).toEqual(["Model A", "Model B"]);
  });

  it.each(LOCALES.map((l) => l.code))("%s: an adults-only model (0192) stays listed and says so in words; the others do not", (code) => {
    const m = dictionaries[code].landingHome.models;
    page(code, { models: [{ name: "Grown Model", kinds: ["video"], adultOnly: true }, { name: "Open Model", kinds: ["image"], adultOnly: false }] });
    const items = within(screen.getByRole("list", { name: m.listLabel })).getAllByRole("listitem");
    expect(items[0].querySelector("[data-adult-only]")?.textContent).toBe(m.adultOnly);
    expect(m.adultOnly).toContain("18+");
    expect(items[1].querySelector("[data-adult-only]")).toBeNull();
  });

  it("parses the 0193 answer: names once, codes to words, unknown codes dropped, junk refused", () => {
    expect(parsePublicModels(null)).toBeNull();
    expect(parsePublicModels({})).toBeNull();
    expect(
      parsePublicModels([
        { display_name: "MiniMax H3", capabilities: ["t2v", "i2v"], adult_only: false },
        { display_name: "Ideogram 3", capabilities: ["t2i", "edit", "describe"], adult_only: true },
        { display_name: "MiniMax H3", capabilities: ["t2v"], adult_only: false },
        { display_name: "", capabilities: ["t2i"], adult_only: false },
        { capabilities: ["t2i"], adult_only: false },
        // No adults-only mark (an older answer, or a broken one): dropped, never shown as if it were not for adults only.
        { display_name: "Unmarked", capabilities: ["t2i"] },
        { display_name: "Half-marked", capabilities: ["t2i"], adult_only: "true" },
        "x",
      ]),
    ).toEqual([
      { name: "MiniMax H3", kinds: ["video"], adultOnly: false },
      { name: "Ideogram 3", kinds: ["image"], adultOnly: true },
    ]);
  });
});

describe("MCP", () => {
  it("names Claude and ChatGPT only while their sign-in is live", () => {
    const m = dictionaries.en.landingHome.mcp;
    page("en", { live: false });
    expect(screen.getByRole("heading", { name: m.titleOff })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: m.titleLive })).toBeNull();
    cleanup();
    page("en", { live: true });
    expect(screen.getByRole("heading", { name: m.titleLive })).toBeTruthy();
    expect(screen.getByRole("link", { name: new RegExp(m.cta) }).getAttribute("href")).toBe("/mcp");
  });
});

describe("trust and safety", () => {
  it.each(LOCALES.map((l) => l.code))("%s: quotes /trust word for word and links to it", (code) => {
    page(code);
    const tr = dictionaries[code].site.trust;
    for (const words of [tr.publishing.title, tr.keys.title, tr.fallback.title, tr.payments.title, tr.fallback.body, tr.payments.body[0]]) {
      expect(screen.getByText(words)).toBeTruthy();
    }
    expect(screen.getByRole("link", { name: new RegExp(dictionaries[code].landingHome.trust.more) }).getAttribute("href")).toBe("/trust");
  });
});

describe("the anchors other pages link to stay on the home page", () => {
  it.each(LOCALES.map((l) => l.code))("%s: #faq, #google-data (OAuth reviewers read it) and #autopilot exist", (code) => {
    const { container } = page(code);
    for (const id of ["faq", "google-data", "autopilot", "how", "pricing"]) expect(container.querySelector(`#${id}`), id).not.toBeNull();
  });
});

describe("pricing is the site's own teaser, unchanged", () => {
  it("links to /pricing", () => {
    page("en");
    expect(screen.getAllByRole("link").some((a) => a.getAttribute("href") === "/pricing")).toBe(true);
  });
});
