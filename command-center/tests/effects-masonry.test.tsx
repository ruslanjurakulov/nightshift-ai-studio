// @vitest-environment jsdom
/**
 * The landing's Effects gallery as a grid masonry, the model tiles under it, and the models strip between them.
 *
 * What broke on the owner's phone (2026-11-14): the Effects section was CSS multi-column; Safari drew the first card of the
 * second and third columns as blurred boxes over the next sections (a backdrop-filter card is a composited layer, and Safari
 * places those wrongly inside columns), one card over the sticky header, and column balancing left 600 px+ holes. The model
 * tiles had lost their own rule (a 76 px still alone in a wide cell), and the strip stood still on touch as a list with
 * dangling dots. These tests hold the fix in place; the layout itself was checked in a browser (the PR's screenshots).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n";
import { EFFECTS } from "@/lib/effects/catalog";
import { MASONRY_COLUMN, MASONRY_REF, MASONRY_UNITS, levelSpans, masonryColumns, masonrySpan } from "@/lib/effects/masonry";
import { effectFrameRatio, effectSample } from "@/components/effects/effect-sample";
import { EffectsGallery } from "@/components/site/EffectsGallery";
import { modelTileColumns } from "@/components/landing/Landing";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const GALLERY_CSS = read("components/site/effects-gallery.css");
// The stylesheet's rules without its comments (a comment may name what the rules no longer do).
const rules = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("the Effects gallery's masonry", () => {
  it("is a grid, never CSS columns, and its cards carry no backdrop blur (Safari misplaced both)", () => {
    const css = rules(GALLERY_CSS);
    expect(css).not.toMatch(/(^|[\s;{])columns\s*:/);
    expect(css).not.toMatch(/column-count|break-inside/);
    expect(css).not.toMatch(/backdrop-filter/);
    expect(css).toMatch(/\.efx-grid \{ display: grid;/);
  });

  it("measures its rows with the same numbers the spans were worked out with", () => {
    const css = rules(GALLERY_CSS);
    expect(css).toContain(`+ ${MASONRY_REF}px) / ${MASONRY_UNITS}), auto);`);
    // minmax(…, auto): a card that needs more than its rows grows them; it never spills over the card below.
    expect(css).toMatch(/grid-auto-rows: minmax\(calc\([^;]*\), auto\);/);
    expect(css).toContain("grid-row-end: span var(--efx-n2)");
    expect(css).toContain("grid-row-end: span var(--efx-n3)");
    // Media first (owner decision 22 Nov): the frame is the card, starting at its shape and growing into its levelled rows.
    expect(css).toMatch(/\.efx-frame \{ flex: 1 0 auto;/);
    expect(css).toMatch(/\.nx-section#effects > \.nx-wrap \{ container-type: inline-size; \}/);
  });

  it("gives a card enough rows for its picture and the gap under it at the width it is laid out for", () => {
    for (const ratio of [16 / 9, 2240 / 1280, 1, 732 / 1280, 9 / 16]) {
      for (const cols of [2, 3] as const) {
        const w = MASONRY_COLUMN[cols];
        const row = (w + MASONRY_REF) / MASONRY_UNITS;
        const n = masonrySpan(ratio, cols);
        expect(n * row, `${ratio} at ${cols}`).toBeGreaterThanOrEqual(ratio * w + MASONRY_REF - 1e-6);
        expect(n * row - (ratio * w + MASONRY_REF), `${ratio} at ${cols}: more than a row spare`).toBeLessThan(row);
      }
    }
    // A square is the same number of rows at every width: exactly UNITS, not one more from rounding.
    expect(masonrySpan(1, 2)).toBe(MASONRY_UNITS);
    expect(masonrySpan(1, 3)).toBe(MASONRY_UNITS);
    expect(() => masonrySpan(0, 2)).toThrow();
    expect(() => masonrySpan(Number.NaN, 3)).toThrow();
  });

  it("sizes each card from its sample's real shape when that is its effect's shape, else the effect's (the drawing's), in page order", () => {
    const { container, unmount } = render(<EffectsGallery t={dictionaries.en} />);
    const cards = [...container.querySelectorAll<HTMLElement>(".efx-card")];
    expect(cards.map((c) => c.dataset.effect)).toEqual(EFFECTS.map((e) => e.id));
    for (const e of EFFECTS) {
      const li = container.querySelector<HTMLElement>(`[data-effect="${e.id}"]`)!;
      const s = effectSample(e);
      const ratio = effectFrameRatio(e);
      const own = e.aspect === "9:16" ? 16 / 9 : e.aspect === "16:9" ? 9 / 16 : 1;
      const real = s ? s.entry.height / s.entry.width : own;
      expect(ratio, e.id).toBeCloseTo(Math.abs(real / own - 1) <= 0.03 ? real : own, 9);
      // The frame the browser draws is the same shape the grid was planned on.
      const frame = li.querySelector<HTMLElement>(".fx-frame, .efx-frame")!;
      const [w, h] = frame.style.aspectRatio.split("/").map(Number);
      expect(h / w, e.id).toBeCloseTo(ratio, 6);
      // Never fewer rows than its shape needs; the levelled columns may add some (levelSpans).
      expect(Number(li.style.getPropertyValue("--efx-n2")), e.id).toBeGreaterThanOrEqual(masonrySpan(ratio, 2));
      expect(Number(li.style.getPropertyValue("--efx-n3")), e.id).toBeGreaterThanOrEqual(masonrySpan(ratio, 3));
    }
    unmount();
  });

  it("picks columns that end evenly, the first row in page order, and puts each card in one", () => {
    const ends = (spans: readonly number[], cols: readonly number[], n: number) => {
      const e = new Array(n).fill(0);
      spans.forEach((s, i) => (e[cols[i] - 1] += s));
      return e;
    };
    for (const n of [2, 3] as const) {
      const spans = EFFECTS.map((e) => masonrySpan(effectFrameRatio(e), n));
      const cols = masonryColumns(spans, n)!;
      expect(cols, `${n} columns`).toHaveLength(EFFECTS.length);
      expect(cols.slice(0, n)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      for (const c of cols) expect(c >= 1 && c <= n).toBe(true);
      // The placement alone leaves the columns apart (a card is its frame alone since the cards went media first, owner decision
      // 22 Nov); levelSpans stretches the shorter ones to end exactly level, cutting no frame by more than a fifth of its height.
      // The placement itself still has to be good (a masonryColumns regression must fail here, not hide behind the stretching):
      // within 40 rows (about 240 px at three columns) before stretching; the multi-column layout left 600 px and more.
      const placed = ends(spans, cols, n);
      expect(Math.max(...placed) - Math.min(...placed), `${n} columns placed: ${placed}`).toBeLessThanOrEqual(40);
      const levelled = levelSpans(spans, cols, n);
      const e = ends(levelled, cols, n);
      expect(Math.max(...e) - Math.min(...e), `${n} columns: ${e}`).toBe(0);
      levelled.forEach((v, i) => {
        expect(v).toBeGreaterThanOrEqual(spans[i]);
        expect((v - spans[i]) / spans[i], `${EFFECTS[i].id} at ${n}`).toBeLessThanOrEqual(0.2);
      });
    }
    // product-burst's sample came from a 4:5 still: at 4:5 no arrangement of the eight is level (13 rows apart at two columns),
    // so it is shown in its effect's square and only a sample of its effect's shape sets a frame of its own.
    const burst = EFFECTS.find((x) => x.id === "product-burst")!;
    expect(effectSample(burst)?.entry.height).toBeGreaterThan(effectSample(burst)!.entry.width);
    expect(effectFrameRatio(burst)).toBe(1);
    // The case that broke: two 9:16 cards side by side with everything else stacked elsewhere.
    const tall = 94, square = 64, wide = 48;
    const e = ends([tall, square, tall, tall, square, wide, square, wide], masonryColumns([tall, square, tall, tall, square, wide, square, wide], 3)!, 3);
    expect(Math.max(...e) - Math.min(...e)).toBeLessThanOrEqual(6);
    // Too many cards to weigh every layout: the grid places them itself.
    expect(masonryColumns(new Array(40).fill(64), 3)).toBeNull();
    expect(masonryColumns([64, 64], 3)).toEqual([1, 2]);
    // No plan, no stretching; a plan's shorter column shares its spare rows in proportion.
    expect(levelSpans([64, 48], null, 2)).toEqual([64, 48]);
    expect(levelSpans([100, 40, 20], [1, 2, 2], 2)).toEqual([100, 67, 33]);
  });

  it("gives the stylesheet each card's column and flows the grid densely, so a card goes straight under the one above it", () => {
    const { container, unmount } = render(<EffectsGallery t={dictionaries.en} />);
    for (const n of [2, 3] as const) {
      const cols = masonryColumns(EFFECTS.map((e) => masonrySpan(effectFrameRatio(e), n)), n)!;
      EFFECTS.forEach((e, i) => expect(container.querySelector<HTMLElement>(`[data-effect="${e.id}"]`)!.style.getPropertyValue(`--efx-c${n}`), e.id).toBe(String(cols[i])));
    }
    unmount();
    const css = rules(GALLERY_CSS);
    expect(css).toContain("grid-auto-flow: row dense;");
    expect(css).toContain("grid-column: var(--efx-c2, auto);");
    expect(css).toContain("grid-column: var(--efx-c3, auto);");
  });

  it("works its sample out on the server from a module that is not a Client Component", () => {
    // A Server Component calling a function imported from a "use client" file gets a client reference it cannot call.
    expect(read("components/effects/effect-sample.ts")).not.toMatch(/^\s*["']use client["']/);
    const gallery = read("components/site/EffectsGallery.tsx");
    expect(gallery).toContain('from "@/components/effects/effect-sample"');
    expect(gallery).not.toMatch(/import \{[^}]*effectSample[^}]*\} from "@\/components\/effects\/EffectFrame"/);
  });
});

describe("the model tiles", () => {
  it("never leave one tile alone under a full row when three or four across can avoid it", () => {
    expect(modelTileColumns(9)).toBe(3);
    expect(modelTileColumns(8)).toBe(4);
    expect(modelTileColumns(6)).toBe(3);
    expect(modelTileColumns(2)).toBe(2);
    for (let n = 2; n <= 12; n++) {
      const c = modelTileColumns(n);
      const last = n % c || c;
      expect(last, `${n} tiles at ${c} across`).toBeGreaterThan(1);
    }
  });

  // 2026-11-22: the sample fills the whole card (the AI studios' model cards), the name at its top, the prompt over a dark foot.
  it("lead with the sample filling a tall card, the label on its corner, and scroll sideways on a phone", () => {
    const css = rules(read("components/site/site-next.css"));
    expect(css).toMatch(/\.nx-model \{ position: relative; display: flex; flex-direction: column; min-width: 0; aspect-ratio: 4 \/ 5;/);
    expect(css).toMatch(/\.nx-model-media \{ position: absolute; inset: 0;/);
    expect(css).toMatch(/\.nx-model-media::after \{[^}]*rgba\(5, 5, 9, 0\.86\) 62%, rgba\(5, 5, 9, 0\.94\) 100%/);
    expect(css).toMatch(/\.nx-model \.nx-ai-badge \{ position: absolute;/);
    // The stale fixed size that pinned the still at 76 px is gone.
    expect(css).not.toMatch(/\.nx-model-pic \{[^}]*76px/);
    const phone = css.slice(css.indexOf("@media (max-width: 639.98px) {\n  .nx-models-grid"));
    expect(phone).toMatch(/scroll-snap-type: x mandatory/);
    expect(phone).toMatch(/scroll-snap-align: start/);
  });
});

describe("the models strip", () => {
  it("sits still where it cannot move (a touch screen, reduced motion): two centred rows, no copy, no animation", () => {
    const css = rules(read("components/site/site-motion.css"));
    // Still is the default; motion, the second copy and the one-line rows exist only where the pointer can stop them.
    expect(css).toMatch(/\.nx-marquee-row\[data-copy="1"\] \{ display: none; \}/);
    expect(css).not.toMatch(/\.nx-marquee \{ display: none; \}/);
    const moving = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference) and (hover: hover) {\n  .nx-marquee-track"));
    expect(moving).toMatch(/\.nx-marquee-row\[data-copy="1"\] \{ display: flex; \}/);
    expect(moving).toMatch(/\.nx-marquee-track\[data-dir="right"\] \{ animation: nx-marquee [^}]*reverse; \}/);
    expect(moving).toMatch(/\.nx-marquee:is\(:hover, :has\(:focus-visible\)\) \.nx-marquee-track \{ animation-play-state: paused; \}/);
  });
});
