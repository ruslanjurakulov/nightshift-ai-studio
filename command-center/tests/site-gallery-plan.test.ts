/**
 * The explore grid ends level (lib/site/gallery-plan.ts). What would break if these failed: the live page's four columns ended
 * at 1109, 946, 946 and 1106 px, a 160 px hole under two of them, and the owner has twice complained about holes in a grid.
 *
 * At three and four columns every column's planned bottom is the same row (a row is a hundredth of a column, so "the same row"
 * is within a pixel or two on any screen, inside the 8 px asked for), for the samples the landing ships and for random sets of
 * 5 to 12. The plan keeps the page's order as the grid's reading order (no card starts above the one before it), adds nothing
 * that is not a sample, never shrinks a card, and grows only the last card of a column.
 */
import { describe, expect, it } from "vitest";
import { GRID_GUTTER_ROWS, PLANNED_COLUMNS, gridSpan, level, levelOrder, place } from "@/lib/site/gallery-plan";
import { showcaseItems } from "@/components/site/ShowcaseGallery";
import { landingGalleryJobs } from "@/components/site/landing-samples";
import { landingExcludedJobs } from "@/components/site/slots";

/** The bottom row of every column that holds a card. */
function bottoms(cells: { col: number; row: number; span: number }[], cols: number): number[] {
  const out: number[] = [];
  for (let c = 1; c <= cols; c++) {
    const mine = cells.filter((x) => x.col === c);
    if (mine.length) out.push(Math.max(...mine.map((x) => x.row + x.span - 1)));
  }
  return out;
}

/** What a plan must keep, whatever the spans. */
function holds(spans: number[], cols: number) {
  const order = levelOrder(spans);
  expect([...order].sort((a, b) => a - b)).toEqual(spans.map((_, i) => i));
  const ordered = order.map((i) => spans[i]);
  const { cells, bottom } = level(ordered, cols);
  // Every card is there once, in its own cells: columns do not overlap within a column.
  expect(cells).toHaveLength(spans.length);
  for (let c = 1; c <= cols; c++) {
    const mine = cells.filter((x) => x.col === c).sort((a, b) => a.row - b.row);
    for (let k = 1; k < mine.length; k++) expect(mine[k].row).toBe(mine[k - 1].row + mine[k - 1].span);
    if (mine.length) expect(mine[0].row).toBe(1);
  }
  // Level: every column that holds a card ends on the same row; with at least as many cards as columns, every column holds one.
  const b = bottoms(cells, cols);
  expect(new Set(b).size, `${cols} columns: ${b.join(", ")}`).toBe(1);
  expect(b[0]).toBe(bottom);
  if (spans.length >= cols) expect(b).toHaveLength(cols);
  // The page's order is the reading order: no card starts above the one before it, and a tie goes left to right.
  for (let k = 1; k < cells.length; k++) {
    const [p, q] = [cells[k - 1], cells[k]];
    expect(q.row > p.row || (q.row === p.row && q.col > p.col), `card ${k}`).toBe(true);
  }
  // Nothing shrinks, and only a column's last card grows.
  const raw = place(ordered, cols).cells;
  cells.forEach((cell, k) => {
    expect(cell.span).toBeGreaterThanOrEqual(ordered[k]);
    const last = cells.every((o, j) => o.col !== cell.col || j <= k);
    if (!last) expect(cell.span).toBe(raw[k].span);
  });
}

/** A small seeded generator, so a failure names a set that can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** The shapes the samples come in: 16:9, 1280×732, 1280×718, square, 4:5, 9:16 and 1280×2276. */
const SHAPES: [number, number][] = [
  [1280, 720],
  [1280, 732],
  [1280, 718],
  [1280, 1280],
  [1280, 1600],
  [1280, 2240],
  [1280, 2276],
];

describe("the explore grid's plan", () => {
  it("a span is the file's height in hundredths of a column, plus the gutter", () => {
    expect(GRID_GUTTER_ROWS).toBe(4);
    expect(gridSpan(1280, 720)).toBe(60);
    expect(gridSpan(1280, 718)).toBe(gridSpan(1280, 720));
    expect(gridSpan(1280, 2240)).toBe(179);
  });

  it("the landing's shipped samples end level at three and four columns, with almost no crop", () => {
    const share = landingGalleryJobs(landingExcludedJobs());
    const items = showcaseItems().filter(({ e }) => share.includes(e.jobId));
    if (items.length === 0) return;
    const spans = items.map(({ e }) => gridSpan(e.width, e.height));
    for (const cols of PLANNED_COLUMNS) {
      holds(spans, cols);
      // Chosen to level, the shipped grid crops a card by at most a few rows (a twentieth of its height), not by half.
      const ordered = levelOrder(spans).map((i) => spans[i]);
      level(ordered, cols).cells.forEach((cell, k) => expect((cell.span - ordered[k]) / ordered[k], `${cols} columns, card ${k}`).toBeLessThanOrEqual(0.05));
    }
  });

  it("every shipped sample at once (the gallery on its own) ends level too", () => {
    const spans = showcaseItems().map(({ e }) => gridSpan(e.width, e.height));
    for (const cols of PLANNED_COLUMNS) holds(spans, cols);
  });

  it("random sets of 5 to 12 cards end level at three and four columns", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const r = rng(seed);
      const n = 5 + Math.floor(r() * 8);
      const spans = Array.from({ length: n }, () => {
        const [w, h] = SHAPES[Math.floor(r() * SHAPES.length)];
        return gridSpan(w, h);
      });
      for (const cols of PLANNED_COLUMNS) holds(spans, cols);
    }
  });

  it("is the same plan every time for the same cards (the server and every visitor agree)", () => {
    const spans = [61, 60, 182, 60, 61, 179, 179, 61];
    expect(levelOrder(spans)).toEqual(levelOrder([...spans]));
    expect(level(spans, 4)).toEqual(level([...spans], 4));
  });
});
