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
import { HeroBackdrop, SLOT_ART, slotArt, type SlotArt } from "@/components/site/art";
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
  const fixed = [HERO_ART, HERO_ART_SM, THUMB_ART];
  const slots = SLOT_DEFS.map((d) => d.slug);
  const budgets: Record<string, number> = { [HERO_ART]: 220 * KB, [HERO_ART_SM]: 90 * KB, [THUMB_ART]: 150 * KB, ...Object.fromEntries(slots.map((n) => [n, 90 * KB])) };
  it("holds one WebP for the hero, its phone cut, the thumbnail and each of the eleven slots, within their byte budgets, and nothing else (derivatives only: the PNG originals are not in the repository)", () => {
    const names = [...fixed, ...slots];
    expect(readdirSync(join(ROOT, "components/site/art")).sort()).toEqual(names.map((n) => `${n}.webp`).sort());
    for (const n of names) {
      const size = statSync(join(ROOT, "components/site/art", `${n}.webp`)).size;
      expect(size, n).toBeGreaterThan(5 * KB);
      expect(size, n).toBeLessThanOrEqual(budgets[n]);
    }
  });

  /** A WebP's pixel size from its header: plain lossy ("VP8 ": a 14-bit width and height) or extended ("VP8X", which the slots' alpha makes it: canvas width and height minus one, 24 bits each). */
  const dims = (name: string) => {
    const b = readFileSync(join(ROOT, "components/site/art", `${name}.webp`));
    expect(b.toString("latin1", 0, 4), name).toBe("RIFF");
    expect(b.toString("latin1", 8, 12), name).toBe("WEBP");
    const kind = b.toString("latin1", 12, 16);
    if (kind === "VP8X") return { kind, alpha: (b[20] & 0x10) !== 0, width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    expect(kind, name).toBe("VP8 ");
    return { kind, alpha: false, width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  };
  it("declares each file's real width and height (the img reserves its box from them), read from the WebP header, and the slots' files carry an alpha channel while the backdrops do not", () => {
    for (const [name, size] of Object.entries(ART_SIZE)) expect({ width: dims(name).width, height: dims(name).height }, name).toEqual(size);
    for (const d of SLOT_DEFS) {
      const h = dims(d.slug);
      expect({ width: h.width, height: h.height }, d.slug).toEqual({ width: d.w, height: d.h });
      expect(h.alpha, `${d.slug} has an alpha channel`).toBe(true);
    }
    for (const n of fixed) expect(dims(n).alpha, n).toBe(false);
    expect(Object.keys(ART_SIZE).sort()).toEqual([...fixed].sort());
  });

  it("keeps the converter's entries, budgets and clean-up for the eleven slots (alpha below 12 cleared, border trimmed, the same margin on every picture)", () => {
    const script = read("scripts/make-site-art.py");
    for (const d of SLOT_DEFS) expect(script, d.slug).toContain(`"${d.slug}": (${d.w}, 90 * KB)`);
    expect(script).toMatch(/ALPHA_FLOOR = 12/);
    expect(script).toMatch(/MARGIN = 0\.07/);
    expect(script).toMatch(/skipped/);
  });

  it("configures every slot from one list that the files, the script and the markup share, steps square and tools 4:3, all filled", () => {
    expect(SLOT_ART.map((x) => x.slug)).toEqual(SLOT_DEFS.map((d) => d.slug));
    for (const d of SLOT_DEFS) expect(d.w / d.h, d.slug).toBe(d.kind === "step" ? 1 : 4 / 3);
    expect(SLOT_ART.filter((x) => !x.src)).toEqual([]);
  });
});

describe("the descriptions (en, ru, uz)", () => {
  it.each(LOCALES.map((l) => l.code))("%s: the thumbnail and each slot picture has its own short description that says it is an AI-generated image, never a photo or a screenshot", (code) => {
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
  it.each(LOCALES.map((l) => l.code))("%s: the thumbnail's caption, the footer's credits and the wall's label and note all say AI-generated, and the footer names the steps and the tools", (code) => {
    const s = dictionaries[code].site;
    const AI = /AI-generated|нейросет|sunʼiy intellekt/i;
    const STOCK = /stock|стоков|stok/i;
    expect(s.try.thumbArtNote).toMatch(AI);
    expect(s.credits.lead).toMatch(AI);
    expect(s.wall.label).toMatch(AI);
    expect(s.wall.note).toMatch(AI);
    expect(s.wall.label + s.wall.note).not.toMatch(STOCK);
    // Said as decoration, not as the product: the footer says so in every language.
    expect(s.credits.lead).toMatch(code === "en" ? /not screenshots of the product/ : code === "ru" ? /не скриншоты продукта/ : /mahsulotning skrinshotlari emas/);
  });

  it.each(LOCALES.map((l) => l.code))("%s: the footer and the wall's wording agree with which slots hold a picture (the steps and the tools are named exactly when one does; an icon wall says icons)", (code) => {
    const s = dictionaries[code].site;
    const filled = SLOT_ART.some((x) => x.src);
    const steps = code === "en" ? /steps/i : code === "ru" ? /шаг/i : /qadam/i;
    const AI = /AI-generated|нейросет|sunʼiy intellekt/i;
    expect(steps.test(s.credits.lead)).toBe(filled);
    expect(AI.test(s.wall.label + s.wall.note)).toBe(filled);
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
  it.each(LOCALES.map((l) => l.code))("%s: each step shows its picture first (above the numeral), each tool tile shows its picture in place of the icon, with the right description, explicit size and lazy loading", (code) => {
    const t = dictionaries[code];
    const { container } = landing(code);
    const steps = [...container.querySelectorAll(".nx-strip-step")];
    expect(steps).toHaveLength(3);
    for (const [i, li] of steps.entries()) {
      const def = SLOT_DEFS.filter((d) => d.kind === "step")[i];
      const img = li.querySelector("img.nx-strip-pic")!;
      expect(img.getAttribute("data-art-id")).toBe(def.slug);
      expect(img.getAttribute("alt")).toBe(t.site.art.alts[def.altKey]);
      expect([img.getAttribute("width"), img.getAttribute("height"), img.getAttribute("loading"), img.getAttribute("decoding")]).toEqual(["800", "800", "lazy", "async"]);
      expect(li.firstElementChild).toBe(img);
      expect([...li.children].map((c) => c.tagName)).toEqual(["IMG", "SPAN", "H3", "P"]);
    }
    const tiles = [...container.querySelectorAll("#tools .nx-wall-tile")];
    const named = t.site.studio.tools.filter((x) => x.id !== "editor");
    expect(tiles).toHaveLength(8);
    for (const [i, tile] of tiles.entries()) {
      const def = SLOT_DEFS.find((d) => d.kind === "tool" && d.target === named[i].id)!;
      const img = tile.querySelector(".nx-wall-frame img.nx-wall-pic")!;
      expect(img.getAttribute("data-art-id")).toBe(def.slug);
      expect(img.getAttribute("alt")).toBe(t.site.art.alts[def.altKey]);
      expect([img.getAttribute("width"), img.getAttribute("height"), img.getAttribute("loading"), img.getAttribute("decoding")]).toEqual(["800", "600", "lazy", "async"]);
      expect(tile.querySelector("svg.nx-wall-icon")).toBeNull();
    }
  });

  it("falls back when a slot is emptied: a step with no picture is text, a tile with none shows its icon (the others keep their pictures)", () => {
    const set = (slug: string, src: SlotArt["src"]) => (SLOT_ART.find((x) => x.slug === slug)!.src = src);
    const keep = { step: SLOT_ART.find((x) => x.slug === "step-1")!.src, voice: SLOT_ART.find((x) => x.slug === "tool-voice")!.src };
    try {
      set("step-1", null);
      set("tool-voice", null);
      expect(slotArt("step", "topic")).toBeNull();
      expect(slotArt("step", "price")?.slug).toBe("step-2");
      const { container } = landing();
      const first = container.querySelector(".nx-strip-step")!;
      expect(first.querySelector("img")).toBeNull();
      expect([...first.children].map((c) => c.tagName)).toEqual(["SPAN", "H3", "P"]);
      expect(container.querySelectorAll(".nx-strip-step img")).toHaveLength(2);
      const voice = container.querySelector('.nx-wall-frame[data-tool="voice"]')!;
      expect(voice.querySelector("img")).toBeNull();
      expect(voice.querySelector("svg.nx-wall-icon")?.getAttribute("aria-hidden")).toBe("true");
      expect(container.querySelectorAll(".nx-wall-frame img.nx-wall-pic")).toHaveLength(7);
      expect(container.querySelectorAll(".nx-wall-frame svg.nx-wall-icon")).toHaveLength(1);
    } finally {
      set("step-1", keep.step);
      set("tool-voice", keep.voice);
    }
  });

  it("draws the pictures on the page's own surface in both themes: no dark box, no shadow, contained (never cropped), the tile 4:3 with the base surface and the panels' hairline; the icon tile keeps its dark gradient", () => {
    expect(css).toMatch(/\.nx-strip-pic \{ display: block; width: 100%; max-width: 260px; height: auto; aspect-ratio: 1; object-fit: contain; \}/);
    expect(css).toMatch(/\.nx-strip-step \{ align-content: start; \}/);
    // The three step pictures share one baseline and one left edge (the converter puts each object against the canvas's bottom and left), and step-1, a thin bar, has a smaller margin.
    const script = read("scripts/make-site-art.py");
    expect(script).toMatch(/SLOT_MARGIN = \{"step-1": 0\.01\}/);
    expect(script).toMatch(/STEP_LEFT = 0\.01/);
    expect(script).toMatch(/STEP_BOTTOM = 0\.04/);
    expect(css).toMatch(/\.nx-strip-step:has\(\.nx-strip-pic\) \.nx-strip-pic \{ grid-column: 1; grid-row: 1 \/ span 3; width: 104px; \}/);
    expect(css).toMatch(/\.nx-wall-frame:has\(\.nx-wall-pic\) \{ aspect-ratio: 4 \/ 3; background: var\(--ns-ground\); border: 1px solid var\(--ns-rule\); \}/);
    expect(css).toMatch(/\.nx-wall-pic \{ display: block; width: 100%; height: 100%; object-fit: contain; \}/);
    const block = css.slice(css.indexOf("/* ── The step and tool pictures"), css.indexOf("/* ── The sample thumbnail's background"));
    expect(block).not.toMatch(/box-shadow|drop-shadow|gradient/);
    expect(css).toMatch(/\.nx-wall-frame:has\(\.nx-wall-icon\) \{ display: flex; align-items: center; justify-content: center; background: radial-gradient\(ellipse 70% 90% at 50% 55%, #2b2566 0%, #15122f 55%, #0b0a1c 100%\); \}/);
    expect(css).toMatch(/\.nx-wall-icon \{[^}]*color: #b3acff;/);
    // The picture's drift is only where motion is allowed (reduced motion and the pause switch keep it still); so is the icon's.
    expect(css).toMatch(/html\[data-motion="paused"\] \.nx-wall-pic \{ transition: none; transform: none !important; \}/);
    expect(css).toMatch(/html\[data-motion="paused"\] \.nx-wall-icon \{ transition: none; transform: none !important; \}/);
  });

  it("lightens the muted text of \"How it works\" in dark mode only, in that section only (the shared token is the whole site's muted text, so no global value moves)", () => {
    const g = read("app/globals.css");
    expect(g).toContain("--ns-text-dim: #b4aea1;");
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \.nx-section#how \{ --ns-text-dim: #d3cdc1; \} \}/);
    expect(css).toMatch(/:root\[data-theme="dark"\] \.nx-section#how \{ --ns-text-dim: #d3cdc1; \}/);
    // 4.5:1 is the floor; the aim for this small text is about 7:1. It sits on the raised section's #1b1a17 (the ground is darker): the brighter of the two is the worst case.
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    expect(ratio("#d3cdc1", "#1b1a17")).toBeGreaterThanOrEqual(7);
    expect(ratio("#d3cdc1", "#1b1a17")).toBeGreaterThan(ratio("#b4aea1", "#1b1a17"));
  });

  it("has the fallback icon's colour at 4.5:1 or better on the tile's brightest point (the icon tile never changes with the theme)", () => {
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
