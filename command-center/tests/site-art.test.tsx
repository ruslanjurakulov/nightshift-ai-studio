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
import { HeroBackdrop, SLOT_ART, slotArt } from "@/components/site/art";
import { ART_IDS, ART_SIZE, HERO_ART, HERO_ART_SM, SLOT_DEFS, THUMB_ART } from "@/lib/site/art";

/**
 * The AI-generated pictures (lib/site/art.ts): the hero's backdrop (wide, and a portrait cut for phones) and the Silk Road sample
 * thumbnail's background. What would break: the thumbnail without a description in one language, a picture that says it is a photo
 * or a screenshot, the 94 KB wide hero fetched on a phone (or the phone's cut on a desktop), a file that grew past its budget, a
 * box that moves when a picture arrives, a tool tile that is a picture again, and a page that still says "every picture is stock".
 */
const ROOT = join(__dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const css = read("components/site/site-next.css");
const KB = 1024;
const landing = (locale: "en" | "ru" | "uz" = "en") =>
  render(<Landing t={dictionaries[locale]} locale={locale} pricing={{ kind: "announced" }} anchor={{ pack: { kind: "none" }, api: null, site: null }} showcase={[]} />);

afterEach(cleanup);

describe("the files", () => {
  const budgets: Record<string, number> = { [HERO_ART]: 220 * KB, [HERO_ART_SM]: 90 * KB, [THUMB_ART]: 150 * KB };
  it("holds one WebP for the hero, its phone cut and the thumbnail, within their byte budgets, and nothing else (derivatives only: the PNG originals are not in the repository)", () => {
    const names = [HERO_ART, HERO_ART_SM, THUMB_ART];
    expect(readdirSync(join(ROOT, "components/site/art")).sort()).toEqual(names.map((n) => `${n}.webp`).sort());
    for (const n of names) {
      const size = statSync(join(ROOT, "components/site/art", `${n}.webp`)).size;
      expect(size, n).toBeGreaterThan(5 * KB);
      expect(size, n).toBeLessThanOrEqual(budgets[n]);
    }
  });

  it("declares each file's real width and height (the img reserves its box from them), read from the WebP header", () => {
    for (const [name, size] of Object.entries(ART_SIZE)) {
      const b = readFileSync(join(ROOT, "components/site/art", `${name}.webp`));
      expect(b.toString("latin1", 0, 4), name).toBe("RIFF");
      expect(b.toString("latin1", 8, 12), name).toBe("WEBP");
      // A lossy WebP: the "VP8 " chunk, its 3-byte frame tag and start code, then the 14-bit width and height.
      expect(b.toString("latin1", 12, 16), name).toBe("VP8 ");
      expect({ width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }, name).toEqual(size);
    }
    expect(Object.keys(ART_SIZE).sort()).toEqual([HERO_ART, HERO_ART_SM, THUMB_ART].sort());
  });

  it("keeps the converter ready for the eleven step and tool pictures at their budgets (a missing PNG is skipped), and carries none of them today", () => {
    const script = read("scripts/make-site-art.py");
    for (const d of SLOT_DEFS) expect(script, d.slug).toContain(`"${d.slug}": (${d.w}, 90 * KB)`);
    expect(script).toMatch(/skipped/);
    // None is configured: no file for any slot is in the directory (the files test above), and no slot has a src.
    expect(SLOT_ART.filter((x) => x.src)).toEqual([]);
  });

  it("configures every slot's width and height from one list that the files, the script and the markup share", () => {
    expect(SLOT_ART.map((x) => x.slug)).toEqual(SLOT_DEFS.map((d) => d.slug));
    for (const d of SLOT_DEFS) expect(d.w / d.h, d.slug).toBe(d.kind === "step" ? 1 : 4 / 3);
  });
});

describe("the descriptions (en, ru, uz)", () => {
  it.each(LOCALES.map((l) => l.code))("%s: the thumbnail and each optional slot picture has its own short description that says it is an AI-generated image, never a photo or a screenshot", (code) => {
    const alts = dictionaries[code].site.art.alts as Record<string, string>;
    expect(Object.keys(alts).sort()).toEqual([...ART_IDS].sort());
    const says = code === "en" ? /^AI-generated image: / : code === "ru" ? /^Изображение, созданное нейросетью: / : /^Sunʼiy intellekt yaratgan tasvir: /;
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
  it.each(LOCALES.map((l) => l.code))("%s: the thumbnail's caption and the footer's credits say AI-generated, and the wall (icons now) says neither stock nor AI", (code) => {
    const s = dictionaries[code].site;
    const AI = /AI-generated|нейросет|sunʼiy intellekt/i;
    const STOCK = /stock|стоков|stok/i;
    expect(s.try.thumbArtNote).toMatch(AI);
    expect(s.credits.lead).toMatch(AI);
    // The footer names exactly the two AI pictures, and that they are decoration, not product screenshots.
    expect(s.credits.lead).toMatch(code === "en" ? /backdrop and the sample thumbnail/ : code === "ru" ? /фон главного экрана и пример обложки/ : /bosh ekran foni va namuna muqova/);
    expect(s.wall.label + s.wall.note).not.toMatch(STOCK);
    expect(s.wall.label + s.wall.note).not.toMatch(AI);
  });

  it.each(LOCALES.map((l) => l.code))("%s: puts no step or tool picture in until the footer, the wall's label and its note say they are AI-made (reword them when SLOT_ART gets a src)", (code) => {
    const s = dictionaries[code].site;
    if (!SLOT_ART.some((x) => x.src)) return;
    expect(s.credits.lead).toMatch(code === "en" ? /steps/i : code === "ru" ? /шаг/i : /qadam/i);
    expect(s.wall.label + s.wall.note).toMatch(/AI-generated|нейросет|sunʼiy intellekt/i);
  });
});

describe("the hero's backdrop", () => {
  it.each(["wide", "phone"] as const)("%s: is decorative (an empty alt, which assistive tech skips) and fetched only in its own range of widths: elsewhere the img is a 1 x 1 GIF", (variant) => {
    const { container } = render(<HeroBackdrop variant={variant} />);
    const pic = container.querySelector("picture")!;
    const img = pic.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("src")).toMatch(/^data:image\/gif/);
    const src = pic.querySelector("source")!;
    expect(src.getAttribute("media")).toBe(variant === "wide" ? "(min-width: 1024px)" : "(max-width: 1023px)");
    expect(src.getAttribute("srcset")).toMatch(variant === "wide" ? /hero-night/ : /hero-night-sm/);
    // Eager and high priority (the largest paint of the first screen), with its real size so the box is reserved.
    expect(img.getAttribute("loading")).toBe("eager");
    expect(img.getAttribute("fetchpriority")).toBe("high");
    expect(img.getAttribute("decoding")).toBe("async");
    const size = ART_SIZE[variant === "wide" ? HERO_ART : HERO_ART_SM];
    expect([Number(img.getAttribute("width")), Number(img.getAttribute("height"))]).toEqual([size.width, size.height]);
  });

  it("is a dark panel with white words in both themes from 1024 px (the backdrop across the hero), and a portrait cut behind the phone panel's words under a veil that is heaviest under them", () => {
    expect(css).toMatch(/\.nx-hero-bg \{ display: none; \}/);
    const block = css.slice(css.indexOf("/* ── The hero's backdrop"));
    const wide = block.slice(block.indexOf("@media (min-width: 1024px)"));
    expect(wide).toMatch(/\.nx-hero \{ background: #0b0a09;/);
    expect(wide).toMatch(/\.nx-hero-copy \{ --ns-text: #fff;/);
    // The tokens are bound on the copy column only: `.nx-hero` itself must not turn the card's text white on a light page.
    expect(wide).not.toMatch(/\.nx-hero \{[^}]*\bcolor: #fff/);
    expect(wide).toMatch(/\.nx-hero \.nx-fx \{ display: none; \}/);
    const phone = block.slice(block.indexOf("@media (max-width: 1023px)"), block.indexOf("@media (min-width: 1024px)"));
    expect(phone).toMatch(/\.nx-hero-bg-phone \{ display: block; position: absolute; inset: 0; z-index: -1;/);
    expect(phone).toMatch(/rgba\(6, 6, 12, 0\.9\) 100%\)/);
  });

  it("is printed twice in the page: the wide one in the hero, the phone's in the dark panel before the pill", () => {
    const { container } = landing();
    const hero = container.querySelector("section.nx-hero")!;
    expect(hero.firstElementChild?.matches("picture.nx-hero-bg-wide")).toBe(true);
    expect(hero.querySelector(".nx-fx")).not.toBeNull();
    expect(hero.querySelector(".nx-hero-top")?.firstElementChild?.matches("picture.nx-hero-bg-phone")).toBe(true);
  });
});

describe("the steps and the tool wall", () => {
  it.each(LOCALES.map((l) => l.code))("%s: the steps are text only again (a numeral, a title, a sentence), and each tool tile is a hidden icon over the tool's own name, with no picture and no credit", (code) => {
    const t = dictionaries[code];
    const { container } = landing(code);
    const steps = [...container.querySelectorAll(".nx-strip-step")];
    expect(steps).toHaveLength(3);
    for (const li of steps) {
      expect(li.querySelector("img, picture, svg")).toBeNull();
      expect([...li.children].map((c) => c.tagName)).toEqual(["SPAN", "H3", "P"]);
    }
    const tiles = [...container.querySelectorAll("#tools .nx-wall-tile")];
    expect(tiles).toHaveLength(8);
    const named = t.site.studio.tools.filter((x) => x.id !== "editor");
    for (const [i, tile] of tiles.entries()) {
      expect(tile.querySelector("img")).toBeNull();
      const icon = tile.querySelector(".nx-wall-frame svg.nx-wall-icon")!;
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      expect(tile.querySelector(".nx-wall-frame")?.getAttribute("data-tool")).toBe(named[i].id);
    }
    // One icon each: eight different shapes (lucide gives each its own class).
    expect(new Set(tiles.map((x) => x.querySelector("svg")?.getAttribute("class")?.split(" ").find((c) => c.startsWith("lucide-")))).size).toBe(8);
  });

  it("shows a configured picture in its slot and nothing in the others: a step gets its image above the numeral, a tile gets it in place of its icon, and both fall back when it is removed", () => {
    const set = (slug: string, src: string | null) => (SLOT_ART.find((x) => x.slug === slug)!.src = src);
    try {
      set("step-1", "/art/step-1.webp");
      set("tool-voice", "/art/tool-voice.webp");
      const t = dictionaries.en;
      expect(slotArt("step", "topic")?.slug).toBe("step-1");
      expect(slotArt("step", "price")).toBeNull();
      const { container } = landing();
      const first = container.querySelector(".nx-strip-step")!;
      const img = first.querySelector("img.nx-strip-pic")!;
      expect(first.firstElementChild).toBe(img);
      expect(img.getAttribute("alt")).toBe(t.site.art.alts["step-1"]);
      expect([img.getAttribute("width"), img.getAttribute("height"), img.getAttribute("loading"), img.getAttribute("decoding")]).toEqual(["800", "800", "lazy", "async"]);
      expect(container.querySelectorAll(".nx-strip-step img")).toHaveLength(1);
      const voice = container.querySelector('.nx-wall-frame[data-tool="voice"]')!;
      expect(voice.querySelector("svg")).toBeNull();
      const pic = voice.querySelector("img.nx-wall-pic")!;
      expect([pic.getAttribute("alt"), pic.getAttribute("width"), pic.getAttribute("height")]).toEqual([t.site.art.alts["tool-voice"], "800", "600"]);
      // The other seven tiles are still icons.
      expect(container.querySelectorAll(".nx-wall-frame svg.nx-wall-icon")).toHaveLength(7);
    } finally {
      set("step-1", null);
      set("tool-voice", null);
    }
    cleanup();
    const { container } = landing();
    expect(container.querySelectorAll(".nx-strip-step img, .nx-wall-frame img")).toHaveLength(0);
    // The slots' styles are ready: a step's picture is a dark rounded square, a tile's fills its tile.
    expect(css).toMatch(/\.nx-strip-pic \{[^}]*aspect-ratio: 1; border-radius: 20px; background: #0b0a1c;/);
    expect(css).toMatch(/\.nx-strip-step:has\(\.nx-strip-pic\) \.nx-strip-pic \{ grid-column: 1; grid-row: 1 \/ span 3; width: 88px;/);
    expect(css).toMatch(/\.nx-wall-pic \{ display: block; width: 100%; height: 100%; object-fit: cover; \}/);
  });

  it("keeps the wall's own tile size (2:1 on a phone, 4:3 from 640 px) and draws a dark tile with a violet icon, the same in both themes", () => {
    expect(css).toMatch(/\.nx-wall-frame \{ display: block; aspect-ratio: 2 \/ 1;/);
    expect(css).toMatch(/\.nx-wall-frame \{ aspect-ratio: 4 \/ 3; \}/);
    expect(css).toMatch(/\.nx-wall-frame \{ display: flex; align-items: center; justify-content: center; background: radial-gradient\(ellipse 70% 90% at 50% 55%, #2b2566 0%, #15122f 55%, #0b0a1c 100%\); \}/);
    expect(css).toMatch(/\.nx-wall-icon \{[^}]*color: #b3acff;/);
    // The icon's drift is only where motion is allowed (reduced motion and the pause switch keep it still).
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\n  \.nx-wall-icon \{ transition: transform 7s/);
    expect(css).toMatch(/html\[data-motion="paused"\] \.nx-wall-icon \{ transition: none; transform: none !important; \}/);
  });

  it("has the icon's colour at 4.5:1 or better on the tile's brightest point, in both themes (the tile never changes)", () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    for (const stop of ["#2b2566", "#15122f", "#0b0a1c"]) expect(ratio("#b3acff", stop), stop).toBeGreaterThanOrEqual(4.5);
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
