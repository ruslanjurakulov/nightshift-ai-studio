// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { dictionaries, LOCALES } from "@/lib/i18n";
import { Landing } from "@/components/landing/Landing";
import { HeroBackdrop } from "@/components/site/art";
import { ART_IDS, ART_SIZE, HERO_ART, STEP_ART, THUMB_ART, TOOL_ART } from "@/lib/site/art";

/**
 * The AI-generated illustrations (lib/site/art.ts): the desktop hero's backdrop, the three steps, the eight tool tiles and the
 * sample thumbnail. What would break: a picture shown without a description in one language, a picture that says it is a photo or a
 * screenshot, the 94 KB hero fetched on a phone that never draws it, a file that grew past its budget, a layout that moves when a
 * picture arrives, and a page that still says "every picture is stock" now that it is not.
 */
const ROOT = join(__dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const css = read("components/site/site-next.css");
const KB = 1024;
const landing = (locale: "en" | "ru" | "uz" = "en") =>
  render(<Landing t={dictionaries[locale]} locale={locale} pricing={{ kind: "announced" }} anchor={{ pack: { kind: "none" }, api: null, site: null }} showcase={[]} />);

afterEach(cleanup);

describe("the files", () => {
  const budgets: Record<string, number> = { [HERO_ART]: 220 * KB, [THUMB_ART]: 150 * KB };
  it("holds one WebP for the hero, each step, each tool and the thumbnail, within its byte budget, and nothing else (derivatives only: the PNG originals are not in the repository)", () => {
    const names = [HERO_ART, ...ART_IDS].sort();
    expect(readdirSync(join(ROOT, "components/site/art")).sort()).toEqual(names.map((n) => `${n}.webp`));
    for (const n of names) {
      const size = statSync(join(ROOT, "components/site/art", `${n}.webp`)).size;
      expect(size, n).toBeGreaterThan(5 * KB);
      expect(size, n).toBeLessThanOrEqual(budgets[n] ?? 90 * KB);
    }
  });

  it("declares each file's real width and height (the <img> reserves its box from them), read from the WebP header", () => {
    for (const [name, size] of Object.entries(ART_SIZE)) {
      const b = readFileSync(join(ROOT, "components/site/art", `${name}.webp`));
      expect(b.toString("latin1", 0, 4), name).toBe("RIFF");
      expect(b.toString("latin1", 8, 12), name).toBe("WEBP");
      // A lossy WebP: the "VP8 " chunk, its 3-byte frame tag and start code, then the 14-bit width and height.
      expect(b.toString("latin1", 12, 16), name).toBe("VP8 ");
      expect({ width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }, name).toEqual(size);
    }
    expect(Object.keys(ART_SIZE).sort()).toEqual([HERO_ART, ...ART_IDS].sort());
  });

  it("maps three steps and eight tools to eleven different pictures, and names only steps and tools the page lists", () => {
    expect(new Set([...Object.values(STEP_ART), ...Object.values(TOOL_ART)]).size).toBe(11);
    expect(ART_IDS).toHaveLength(12);
    for (const { code } of LOCALES) {
      const s = dictionaries[code].site;
      const steps = s.how.simple.steps.map((x) => x.id);
      for (const id of Object.keys(STEP_ART)) expect(steps, `${code} ${id}`).toContain(id);
      const tools = s.studio.tools.map((x) => x.id);
      for (const id of Object.keys(TOOL_ART)) expect(tools, `${code} ${id}`).toContain(id);
    }
  });
});

describe("the descriptions (en, ru, uz)", () => {
  it.each(LOCALES.map((l) => l.code))("%s: every illustration has its own short description, and says it is an illustration or an AI-generated image, never a photo or a screenshot", (code) => {
    const alts = dictionaries[code].site.art.alts as Record<string, string>;
    expect(Object.keys(alts).sort()).toEqual([...ART_IDS].sort());
    const says = code === "en" ? /^(Illustration|AI-generated image): / : code === "ru" ? /^(Иллюстрация|Изображение, созданное нейросетью): / : /^(Illyustratsiya|Sunʼiy intellekt yaratgan tasvir): /;
    for (const [id, alt] of Object.entries(alts)) {
      expect(alt, id).toMatch(says);
      expect(alt.length, id).toBeLessThan(120);
      expect(alt, id).not.toMatch(/screenshot|скриншот|skrinshot|photo\b|фото/i);
    }
    expect(new Set(Object.values(alts)).size).toBe(ART_IDS.length);
  });

  it("is different in every language (a copied English alt is a missing translation)", () => {
    const en = dictionaries.en.site.art.alts as Record<string, string>;
    for (const code of ["ru", "uz"] as const) {
      const other = dictionaries[code].site.art.alts as Record<string, string>;
      for (const id of ART_IDS) expect(other[id], `${code} ${id}`).not.toBe(en[id]);
    }
  });
});

describe("the page says what the pictures are", () => {
  it.each(LOCALES.map((l) => l.code))("%s: the wall's label and note, the thumbnail's caption and the footer's credits all say AI-generated, and none still calls the wall stock", (code) => {
    const s = dictionaries[code].site;
    const AI = /AI-generated|нейросет|sunʼiy intellekt/i;
    const STOCK = /stock|стоков|stok/i;
    expect(s.wall.label).toMatch(AI);
    expect(s.wall.note).toMatch(AI);
    expect(s.wall.label + s.wall.note).not.toMatch(STOCK);
    expect(s.try.thumbArtNote).toMatch(AI);
    expect(s.credits.lead).toMatch(AI);
  });
});

describe("the hero's backdrop", () => {
  it("is decorative (an empty alt, which assistive tech skips) and fetched only from 1024 px up: below that the <img> is a 1 x 1 GIF, so a phone never asks for the picture", () => {
    const { container } = render(<HeroBackdrop />);
    const pic = container.querySelector("picture")!;
    const img = pic.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("src")).toMatch(/^data:image\/gif/);
    const src = pic.querySelector("source")!;
    expect(src.getAttribute("media")).toBe("(min-width: 1024px)");
    expect(src.getAttribute("srcset")).toMatch(/hero-night/);
    // Eager and high priority (it is the largest paint on a wide first screen), with its real size so the box is reserved.
    expect(img.getAttribute("loading")).toBe("eager");
    expect(img.getAttribute("fetchpriority")).toBe("high");
    expect(img.getAttribute("decoding")).toBe("async");
    expect(Number(img.getAttribute("width"))).toBe(1672);
    expect(Number(img.getAttribute("height"))).toBe(941);
  });

  it("is a dark panel with white words in both themes from 1024 px, hidden below it, and keeps the chat card on the theme's own tokens", () => {
    expect(css).toMatch(/\.nx-hero-bg \{ display: none; \}/);
    const block = css.slice(css.indexOf("/* The hero's backdrop"));
    const wide = block.slice(block.indexOf("@media (min-width: 1024px)"));
    expect(wide).toMatch(/\.nx-hero \{ background: #0b0a09;/);
    expect(wide).toMatch(/\.nx-hero-copy \{ --ns-text: #fff;/);
    // The tokens are bound on the copy column only: `.nx-hero` itself must not turn the card's text white on a light page.
    expect(wide).not.toMatch(/\.nx-hero \{[^}]*\bcolor: #fff/);
    expect(wide).toMatch(/\.nx-hero \.nx-fx \{ display: none; \}/);
  });

  it("sits under the hero's content and ahead of the drifting light, in the page's hero", () => {
    const { container } = landing();
    const hero = container.querySelector("section.nx-hero")!;
    expect(hero.firstElementChild?.matches("picture.nx-hero-bg")).toBe(true);
    expect(hero.querySelector(".nx-fx")).not.toBeNull();
  });
});

describe("the steps and the tool wall", () => {
  it.each(LOCALES.map((l) => l.code))("%s: each step has its picture first, with its description, explicit size and lazy loading; each tool tile has its own", (code) => {
    const t = dictionaries[code];
    const { container } = landing(code);
    const steps = [...container.querySelectorAll(".nx-strip-step")];
    expect(steps).toHaveLength(3);
    for (const [i, li] of steps.entries()) {
      const img = li.querySelector("img.nx-strip-pic")!;
      const id = STEP_ART[t.site.how.simple.steps[i].id as keyof typeof STEP_ART];
      expect(img.getAttribute("alt")).toBe(t.site.art.alts[id]);
      expect(img.getAttribute("data-art-id")).toBe(id);
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("decoding")).toBe("async");
      expect(Number(img.getAttribute("width"))).toBeGreaterThan(0);
      expect(Number(img.getAttribute("height"))).toBeGreaterThan(0);
      expect(li.firstElementChild).toBe(img);
    }
    const tiles = [...container.querySelectorAll("#tools .nx-wall-tile img")];
    expect(tiles.map((x) => x.getAttribute("data-art-id"))).toEqual(Object.values(TOOL_ART));
    for (const img of tiles) {
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("width")).toBe("800");
      expect(img.getAttribute("height")).toBe("600");
      expect(Number(img.getAttribute("height")) / Number(img.getAttribute("width"))).toBe(0.75);
    }
  });

  it("draws a step's picture as a small square beside its words on a phone and a full-width square above them on a desktop, and a tile in 4:3 so the whole picture shows", () => {
    expect(css).toMatch(/\.nx-strip-pic \{[^}]*aspect-ratio: 1;/);
    expect(css).toMatch(/\.nx-strip-step:has\(\.nx-strip-pic\) \.nx-strip-pic \{ grid-column: 1; grid-row: 1 \/ span 3; width: 88px;/);
    expect(css).toMatch(/\.nx-wall-frame \{[^}]*aspect-ratio: 4 \/ 3;/);
    // Dark pictures sit in their own dark rounded box, never on the page's ground (a light page shows a dark card).
    expect(css).toMatch(/\.nx-strip-pic \{[^}]*border-radius: 20px; background: #0b0a1c;/);
    expect(css).toMatch(/\.nx-wall-frame \{[^}]*background: #0b0a1c;/);
  });

  it("still lets the best-visible tile drift only where motion is allowed (reduced motion and the pause switch keep it still)", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\n  \.nx-wall-pic \{ transition: transform 7s/);
    expect(css).toMatch(/html\[data-motion="paused"\] \.nx-wall-pic \{ transition: none; transform: none !important; \}/);
  });
});

describe("the sample thumbnail", () => {
  it("shows the Silk Road picture only behind the Silk Road example, with the words kept over a scrim", () => {
    const { container } = landing();
    const pic = container.querySelector(".nx-try-thumb-pic")!;
    expect(pic.getAttribute("data-picture")).toBe("true");
    expect(pic.querySelector("img")?.getAttribute("data-art-id")).toBe(THUMB_ART);
    expect(pic.querySelector(".nx-try-thumb-scrim")).not.toBeNull();
    expect(pic.querySelector("svg[data-art='thumb'] rect[fill]:not([fill='none'])")).toBeNull();
    expect(css).toMatch(/\.nx-try-thumb-scrim \{[^}]*rgba\(6, 6, 12, 0\.86\)/);
  });
});
