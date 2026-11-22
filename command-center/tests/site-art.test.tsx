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
import { HeroBackdrop, SLOT_ART } from "@/components/site/art";
import { ART_IDS, ART_SIZE, HERO_ART, HERO_ART_SM, SLOT_DEFS } from "@/lib/site/art";
import { SHOWCASE_ENTRIES } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { EXAMPLE_JOBS, EXAMPLE_PHONE_JOB, EXAMPLE_THUMB_JOB, exampleMedia, landingExcludedJobs } from "@/components/site/slots";
import { APPROVALS_HREF } from "@/components/landing/Showcases";
import { ApprovalCard } from "@/components/landing/ApprovalCard";
import { TryDemo } from "@/components/landing/TryDemo";
import { effectPreviewJobs, landingGalleryJobs, sampleSectionJobs } from "@/components/site/landing-samples";
import { ChatCard, chatCopy } from "@/components/landing/HeroCard";
import { SignOffPicture } from "@/components/site/SolutionPictures";
import { FlowCard } from "@/components/auth/FlowCard";

/**
 * The AI-generated pictures (lib/site/art.ts): the hero's backdrop (wide, and a portrait cut for phones) and the eleven slots, and
 * the example topic's clips beside its ask. What would break: a picture without a description in one language, a picture that says it is a photo
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
  // The Silk Road thumbnail (thumb-silkroad) is gone with its example: the example topic's result is its own clips now.
  const fixed = [HERO_ART, HERO_ART_SM];
  const slots = SLOT_DEFS.map((d) => d.slug);
  const budgets: Record<string, number> = { [HERO_ART]: 220 * KB, [HERO_ART_SM]: 90 * KB, ...Object.fromEntries(slots.map((n) => [n, 90 * KB])) };
  it("holds one WebP for the hero, its phone cut and each of the eleven slots, within their byte budgets, and nothing else (derivatives only: the PNG originals are not in the repository)", () => {
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

  it("configures every slot from one list that the files, the script and the markup share, steps square and tools 4:3, all emptied in round 10 (the steps are live pieces and the tools real outputs)", () => {
    expect(SLOT_ART.map((x) => x.slug)).toEqual(SLOT_DEFS.map((d) => d.slug));
    for (const d of SLOT_DEFS) expect(d.w / d.h, d.slug).toBe(d.kind === "step" ? 1 : 4 / 3);
    expect(SLOT_ART.filter((x) => x.src)).toEqual([]);
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
  it.each(LOCALES.map((l) => l.code))("%s: the thumbnail's caption and the footer's credits say AI-generated decoration; the wall says its pictures are real outputs from our Studio, and never stock", (code) => {
    const s = dictionaries[code].site;
    const AI = /AI-generated|нейросет|sunʼiy intellekt/i;
    const STOCK = /stock|стоков|stok/i;
    expect(s.try.thumbArtNote).toMatch(AI);
    expect(s.credits.lead).toMatch(AI);
    expect(s.credits.leadNoStock).toMatch(AI);
    // Round 10: the wall shows real jobs, each labelled by its own card; its words say so and call nothing decoration.
    expect(s.wall.label).toMatch(code === "en" ? /Real outputs/ : code === "ru" ? /Настоящие результаты/ : /haqiqiy natijalar/);
    expect(s.wall.label + s.wall.note).not.toMatch(STOCK);
    expect(s.wall.note).not.toMatch(/decoration|оформлени|bezak/i);
    // An AI-generated clip or picture is not the product either, in every language. No decoration picture is left to name: the
    // Registan was the last one, and the footer no longer mentions it.
    expect(s.credits.lead).toMatch(code === "en" ? /not a screenshot of the product/ : code === "ru" ? /не скриншот продукта/ : /mahsulotning skrinshoti emas/);
    for (const v of [s.credits.lead, s.credits.leadNoStock, s.credits.generated]) expect(v).not.toMatch(/Registan|Регистан|Registon|Silk Road|Шёлков|Ipak yoʻli/);
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

  // Round 10: the hero slot's own picture (one of our samples once merged) took the first screen edge to edge, so the backdrop is
  // no longer printed on the landing, and the credits no longer say there is one.
  it("is no longer on the landing, and the credits do not claim it", () => {
    const { container } = landing();
    // The first screen is our own Studio clip (components/landing/home/HomeHero.tsx): no drawn backdrop under it or beside it.
    const hero = container.querySelector("section.hm-hero")!;
    expect(container.querySelector("picture.nx-hero-bg-wide, picture.nx-hero-bg-phone, [data-art-id^='hero-night']")).toBeNull();
    expect(hero.firstElementChild?.matches(".hm-hero-media")).toBe(true);
    for (const l of LOCALES) expect(dictionaries[l.code].site.credits.lead).not.toMatch(/hero’s backdrop|фон главного экрана|bosh ekran foni/);
  });
});

describe("the steps and the tool wall", () => {
  // Round 10: the clay pictures are gone from the landing. Each step shows a live piece of the product instead (the ask typed, the
  // Generate key and its price, a channel's video waiting private), and each tool tile a real output or its icon.
  it.each(LOCALES.map((l) => l.code))("%s: each step shows its live piece first (above the numeral), and no clay picture is left on the page", (code) => {
    const t = dictionaries[code];
    const { container } = landing(code);
    const steps = [...container.querySelectorAll(".nx-strip-step")];
    expect(steps).toHaveLength(3);
    expect(steps.map((li) => li.firstElementChild?.getAttribute("data-step"))).toEqual(["topic", "price", "approve"]);
    // The third step's words stop at two sentences; the whole approval story is behind its own link.
    expect(steps.map((li) => [...li.children].slice(1).map((c) => c.tagName))).toEqual([["SPAN", "H3", "P"], ["SPAN", "H3", "P"], ["SPAN", "H3", "P", "A"]]);
    const more = steps[2].lastElementChild as HTMLAnchorElement;
    expect(more.getAttribute("href")).toBe("/solutions/youtube-channels");
    expect(more.textContent).toBe(t.site.caps.items.find((i) => i.id === "approvals")!.cta);
    // The same page the Approvals band linked to (components/landing/Showcases.tsx APPROVALS_HREF), which is off the landing now.
    expect(APPROVALS_HREF).toBe(more.getAttribute("href"));
    const approveBody = steps[2].querySelector("p")!.textContent!;
    expect(approveBody.split(/(?<=[.!?])\s+/).filter(Boolean)).toHaveLength(2);
    // 1: the chat card's own example ask, typed; a picture of a box, hidden from assistive tech.
    const topic = steps[0].firstElementChild!;
    expect(topic.getAttribute("aria-hidden")).toBe("true");
    expect(topic.textContent).toContain(t.site.caps.items[0].bubble);
    // 2: the Studio's own Generate key, and where its price appears (no price list here, so no figure).
    const price = steps[1].firstElementChild!;
    expect(price.querySelector(".nx-step-key")?.textContent).toBe(t.gen.generate);
    expect(price.querySelector(".nx-step-price")?.textContent).toBe(t.site.how.priceLater);
    expect(price.textContent).not.toMatch(/\d/);
    // 3: the finished video of step 1's ask playing in a phone, under "Private on YouTube": the example's own vertical clip,
    // labelled AI-generated and described for what it shows. It was a sneaker falling on a street, then a still of the Registan
    // ("you asked for a video and put a picture as the result", owner, 2026-11-14).
    const phone = steps[2].firstElementChild as HTMLElement;
    const box = phone.querySelector(".nx-step-phone")!;
    expect(box.getAttribute("data-showcase-entry")).toBe(EXAMPLE_PHONE_JOB);
    expect(box.getAttribute("data-clip")).toBe("sample");
    const shot = box.querySelector("img")!;
    expect(shot.getAttribute("data-sample-job")).toBe(EXAMPLE_PHONE_JOB);
    expect(shot.getAttribute("alt")).toBe(t.site.how.phoneAlt);
    expect(shot.classList.contains("nx-step-shot") && shot.classList.contains("nx-drift-pic")).toBe(true);
    // The stock labels are not on it (labels={false}): only the AI badge and the private chip.
    expect(box.querySelector(".nx-result-badge, .nx-result-credit, [data-sample]")).toBeNull();
    expect(phone.querySelector(".nx-step-private")?.textContent).toBe((t.site.stage.steps.find((s) => s.id === "approve") as { lamp: string }).lamp);
    expect(phone.querySelector(".nx-step-credit")?.textContent).toContain(t.site.gallery.badge);
    expect(shot.getAttribute("loading")).toBe("lazy");
    expect(container.querySelector("img.nx-strip-pic, img.nx-wall-pic, [data-art-id^='step-'], [data-art-id^='tool-']")).toBeNull();
  });

  // The owner saw the phone small and standing above steps 1 and 2, its still opening on a cut-off shoe (2026-11-14).
  it("puts the three live pieces on stages of one fixed height from 860 px, the phone filling its stage, its vertical clip centred in it", () => {
    expect(css).toMatch(/@media \(min-width: 860px\) \{ \.nx-step-live \{ height: 264px;/);
    expect(css).toMatch(/\.nx-step-live \{[^}]*border-radius: 20px; border: 1px solid var\(--ns-rule\); background: var\(--ns-ground\); \}/);
    expect(css).toMatch(/@media \(min-width: 860px\) \{ \.nx-step-phone \{ height: 100%; \} \}/);
    expect(css).toMatch(/\.nx-step-phone \{[^}]*aspect-ratio: 9 \/ 16;/);
    // The clip is already about 9:16 (1280 x 2240): centred, almost no crop. The clip itself covers its frame the same way (.nx-clip).
    expect(css).toMatch(/\.nx-step-shot \{[^}]*object-fit: cover; object-position: 50% 50%; \}/);
    expect(SHOWCASE_ENTRIES.find((e) => e.jobId === EXAMPLE_PHONE_JOB)!.height / SHOWCASE_ENTRIES.find((e) => e.jobId === EXAMPLE_PHONE_JOB)!.width).toBeCloseTo(16 / 9, 1);
    // Its first frame's slow push-in is the shared drift: absent under reduced motion, held by the page's pause switch, off while the clip plays.
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.nx-drift-pic \{ animation: nx-poster-drift/);
    expect(css).toMatch(/html\[data-motion="paused"\] \.nx-drift-pic \{ animation-play-state: paused !important; \}/);
    expect(css).toMatch(/\[data-live="true"\] > \.nx-drift-pic \{ animation: none; \}/);
    // Only a min-height was shared before, which let the pieces end at different heights.
    expect(css).not.toMatch(/\.nx-step-live \{ min-height: 196px; \}/);
  });

  // Scrolled to "How it works", the Approvals card's empty lower strip was all that showed under the header (owner, 2026-11-14).
  it("sizes the drawn Approvals card to its words and its screen, not to a photograph band's 560 px floor", () => {
    expect(css).toMatch(/\.nx-show-card\[data-art="drawn"\] \{ display: grid; grid-template-columns: 46% minmax\(0, 1fr\); align-items: center; min-height: 0;/);
    expect(css).toMatch(/\.nx-show-card\[data-art="drawn"\] \.nx-show-pic \{ position: relative; inset: auto;/);
  });

  it("prints the price on the Generate key's step only when the live price list holds it", () => {
    const { container } = render(<Landing t={dictionaries.en} locale="en" pricing={{ kind: "announced" }} anchor={{ pack: { kind: "none" }, api: null, site: { perMinute: 60, minimum: 30, usd: null } }} showcase={[]} />);
    const price = container.querySelector(".nx-step-live[data-step='price'] .nx-step-price")!;
    expect(price.getAttribute("data-known")).toBe("true");
    expect(price.textContent).toContain("60");
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
  // The plan demo left the landing on 2026-11-22 (the first screen's idea box says what it said); the demo itself keeps its rule.
  it("shows the example clip's first frame only behind the example topic, with the words kept over a scrim", () => {
    const t = dictionaries.en;
    const m = exampleMedia(EXAMPLE_THUMB_JOB)!;
    const thumb = { src: m.files.posterSm, width: m.entry.width, height: m.entry.height, job: m.entry.jobId, alt: t.site.how.thumbAlt };
    const { container } = render(<TryDemo copy={t.site.try} thumb={thumb} note="" />);
    const pic = container.querySelector(".nx-try-thumb-pic")!;
    expect(pic.getAttribute("data-picture")).toBe("true");
    expect(pic.querySelector("img")?.getAttribute("data-sample-job")).toBe(EXAMPLE_THUMB_JOB);
    expect(pic.querySelector(".nx-try-thumb-scrim")).not.toBeNull();
    expect(pic.querySelector("svg[data-art='thumb'] rect[fill]:not([fill='none'])")).toBeNull();
    expect(css).toMatch(/\.nx-try-thumb-scrim \{[^}]*rgba\(6, 6, 12, 0\.86\)/);
  });
});

/**
 * The example topic is one story: the ask (step 1, the chat card, the plan demo, the sign-in stage), the video it makes and that
 * video waiting for approval (step 3, the Approvals card, the /pricing card, the publish desk). Its pictures showed other prompts'
 * samples (a falling sneaker, a jungle explorer, a chocolate pour, a giant dog) and the owner read them as "the result need not
 * match the prompt"; then a still of the Registan beside "make a video" read as "you asked for a video and got a picture" (both
 * 2026-11-14). The topic became football in 2050, told with two real clips made in our Studio from prompts about it. What would
 * break: anything beside the topic that is not one of those two clips (another sample, a stock picture, a drawing's still), or a
 * still where a clip should play.
 */
describe("the example topic: beside it there are only its own two football clips", () => {
  const ABOUT_IT = /football in the year 2050/i;
  /** The pieces of a page that tell this example: the topic and anything drawn as its result sit inside one of these. */
  const STORY = ".nx-strip, .nx-approve-art, figure, .st-monitor, .nx-try, .nx-fcard";
  const topics = (code: "en" | "ru" | "uz") => {
    const s = dictionaries[code].site;
    const brief = s.stage.steps.find((x) => x.id === "brief") as { field: string };
    return [brief.field, s.caps.items[0].bubble, s.try.topics[0], s.solutions.pictures.signoff.video];
  };
  /** The smallest story piece around each place the topic is printed. */
  const besideTopic = (root: HTMLElement, code: "en" | "ru" | "uz") => {
    const hits = new Set<Element>();
    for (const topic of topics(code)) {
      for (const el of root.querySelectorAll("*")) {
        if (!el.textContent?.includes(topic) || [...el.children].some((c) => c.textContent?.includes(topic))) continue;
        const piece = el.closest(STORY);
        if (piece) hits.add(piece);
      }
    }
    return [...hits];
  };
  /** Every sample and picture in a piece is one of the example's two clips (its first frame, or the clip over it); nothing else. */
  const problems = (piece: Element): string[] => {
    const out: string[] = [];
    for (const node of piece.querySelectorAll("[data-showcase-entry], [data-sample-job]")) {
      const job = node.getAttribute("data-showcase-entry") ?? node.getAttribute("data-sample-job")!;
      if (!EXAMPLE_JOBS.includes(job)) out.push(`sample ${job}`);
    }
    for (const img of piece.querySelectorAll("img")) {
      if (!EXAMPLE_JOBS.includes(img.getAttribute("data-sample-job") ?? "")) out.push(`picture ${img.getAttribute("src")}`);
    }
    if (piece.querySelector("[data-sample], [data-art-id]")) out.push("a stock picture or a drawing's still");
    return out;
  };

  it("has two clips, made in our Studio from prompts about football in 2050, both merged with their files and clips", () => {
    for (const job of EXAMPLE_JOBS) {
      const e = SHOWCASE_ENTRIES.find((x) => x.jobId === job)!;
      expect(e, job).toBeTruthy();
      expect(e.kind).toBe("video");
      expect(e.prompt).toMatch(ABOUT_IT);
      expect(SHOWCASE_FILES[job]?.clip, job).toBeTruthy();
    }
    const phone = SHOWCASE_ENTRIES.find((x) => x.jobId === EXAMPLE_PHONE_JOB)!;
    const thumb = SHOWCASE_ENTRIES.find((x) => x.jobId === EXAMPLE_THUMB_JOB)!;
    expect(phone.height).toBeGreaterThan(phone.width);
    expect(thumb.width / thumb.height).toBeCloseTo(16 / 9, 1);
  });

  it("names the topic in every language, in title form beside the result and as an ask in the chat card and step 1", () => {
    const want = { en: "What football will look like in 2050", ru: "Каким будет футбол в 2050 году", uz: "2050-yilda futbol qanday boʻladi" } as const;
    const ask = { en: "Make a video about what football will look like in 2050.", ru: "Сделай видео о том, каким будет футбол в 2050 году.", uz: "2050-yilda futbol qanday boʻlishi haqida video qil." } as const;
    for (const l of LOCALES) {
      const [field, bubble, tryTopic, desk] = topics(l.code);
      expect([field, tryTopic, desk]).toEqual([want[l.code], want[l.code], want[l.code]]);
      expect(bubble).toBe(ask[l.code]);
    }
  });

  it.each(LOCALES.map((l) => l.code))("%s: on the landing (the steps and the chat card under them)", (code) => {
    const { container } = landing(code);
    const pieces = besideTopic(container, code);
    // The steps and the chat card at least: the check cannot pass by finding nothing. (The Approvals card and the plan demo left the
    // landing on 2026-11-22; the card is checked on its own below.)
    for (const sel of [".nx-strip", "figure.nx-chat"]) expect(pieces.some((p) => p.matches(sel)), sel).toBe(true);
    for (const p of pieces) expect(problems(p), p.className).toEqual([]);
    expect(container.querySelector(".nx-step-phone img")?.getAttribute("data-sample-job")).toBe(EXAMPLE_PHONE_JOB);
  });

  it.each(LOCALES.map((l) => l.code))("%s: on the drawn approval screen (components/landing/ApprovalCard.tsx)", (code) => {
    const t = dictionaries[code];
    const { container } = render(<ApprovalCard t={t} />);
    // The Approvals card's thumbnail plays the wide clip, labelled AI-generated and private.
    const thumb = container.querySelector(".nx-approve-thumb")!;
    expect(thumb.getAttribute("data-showcase-entry")).toBe(EXAMPLE_THUMB_JOB);
    expect(thumb.getAttribute("data-clip")).toBe("sample");
    expect(thumb.querySelector("img")?.getAttribute("data-sample-job")).toBe(EXAMPLE_THUMB_JOB);
    expect(container.querySelector(".nx-approve-art")?.hasAttribute("id")).toBe(false);
    expect(thumb.querySelector(".nx-ai-badge")?.textContent).toBe(t.site.gallery.badge);
    expect(thumb.querySelector(".nx-approve-private")?.textContent).toBe((t.site.stage.steps.find((s) => s.id === "approve") as { lamp: string }).lamp);
  });

  it.each(LOCALES.map((l) => l.code))("%s: on the /pricing chat card, the publish desk of /solutions and the sign-in stage", (code) => {
    const t = dictionaries[code];
    for (const [name, node, sel] of [
      ["chat card", <ChatCard key="c" copy={chatCopy(t)} />, "figure.nx-chat"],
      ["publish desk", <SignOffPicture key="d" t={t} />, ".st-monitor"],
      ["sign-in stage", <FlowCard key="f" stage={t.site.stage} />, ".nx-fcard"],
    ] as const) {
      const { container } = render(node);
      const pieces = besideTopic(container, code);
      expect(pieces.some((p) => p.matches(sel)), name).toBe(true);
      for (const p of pieces) expect(problems(p), name).toEqual([]);
      cleanup();
    }
  });

  it("keeps both clips out of every sample surface of the landing (gallery, carousel, ticker, picture → video, Effects)", () => {
    const out = landingExcludedJobs();
    for (const job of EXAMPLE_JOBS) {
      expect(out, job).toContain(job);
      expect(landingGalleryJobs(out)).not.toContain(job);
      expect(sampleSectionJobs(out)).not.toContain(job);
      expect(effectPreviewJobs()).not.toContain(job);
    }
  });

  it("leaves no Silk Road picture anywhere: the art file, its id and its descriptions are gone", () => {
    expect(readdirSync(join(ROOT, "components/site/art"))).not.toContain("thumb-silkroad.webp");
    expect(read("lib/site/art.ts")).not.toMatch(/THUMB_ART|thumb-silkroad/);
    expect(read("components/site/art.tsx")).not.toMatch(/ArtImg|thumb-silkroad/);
    for (const l of LOCALES) expect(Object.keys(dictionaries[l.code].site.art.alts)).not.toContain("thumb-silkroad");
    for (const l of LOCALES) expect(dictionaries[l.code].site.how.phoneAlt).toMatch(/football|футбол|futbol/i);
  });
});
