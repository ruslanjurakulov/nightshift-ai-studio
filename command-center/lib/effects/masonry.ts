/**
 * Row spans and columns for the public Effects gallery (components/site/EffectsGallery.tsx, effects-gallery.css): a masonry
 * built on CSS grid, worked out on the server, with no script in the browser and no CSS multi-column.
 *
 * Why not `columns`: the section was multi-column, and it broke twice over. Column balancing with unbreakable cards of very
 * different heights leaves one column far shorter than the next (in Chromium a 680 px hole at 1440 px, 630 px at 768 px), and
 * Safari paints a composited box inside a column (the cards' backdrop blur; a playing <video> is another) at the wrong place:
 * on the owner's phone the first card of the second and third columns was missing from the top of its column and drawn as a
 * blurred box over the sections below the gallery, and another card over the sticky header.
 *
 * How the grid fits each card: its rows are a small unit that grows with the column, u = (W + REF) / UNITS, where W is the
 * column's width (container query units) and REF stands for a card's text block plus the gap under it. A card is its frame
 * (r * W, r = height / width, exactly the clip's or the drawing's shape) plus its text, so in rows it needs
 * UNITS * (r * W + REF) / (W + REF): for a square that is the same at every width, and for a 9:16 or a 16:9 frame it drifts by
 * a few per cent across a breakpoint, so one number per card and column count is enough. It is worked out at the column width
 * the layout is drawn for (MASONRY_COLUMN). Wider or narrower than that, a card may have a few rows spare, which go to its text
 * block (the key stays at the foot, the picture keeps its shape), or need a few more: the stylesheet's rows are
 * minmax(u, auto), so the rows it crosses grow to hold it (the cards beside it grow with them) and nothing ever spills over the
 * card below. The same holds for words longer than REF (a long name in Russian on a narrow column).
 */

/** Rows per (column width + REF). More rows, smaller rounding: 64 keeps a row near 10 px at every width. */
export const MASONRY_UNITS = 64;
/** A card's text block (kind, name, line, needs, the key: 236 px in en, ru and uz on a column of 350 px or more) and the 20 px
 *  gap below the card, in CSS px. */
export const MASONRY_REF = 256;

/**
 * The column width (CSS px) each column count is sized for, from the site's frame (site.css: --st-max 1240, gutters 24 px from
 * 640 and 40 px from 1024) and the gallery's own 20 px gaps. Two columns from 640 to 1023 px: the middle of that band (its
 * columns run from 286 to 478 px). Three from 1024 px: the column every screen of 1240 px or more draws (373 px; 301 px at 1024).
 */
export const MASONRY_COLUMN = {
  2: ((640 + 1023) / 2 - 2 * 24 - 20) / 2,
  3: (1240 - 2 * 40 - 2 * 20) / 3,
} as const;

/** The rows a card with a frame of height / width `ratio` spans at `columns` columns. */
export function masonrySpan(ratio: number, columns: keyof typeof MASONRY_COLUMN): number {
  if (!(ratio > 0) || !Number.isFinite(ratio)) throw new Error(`masonrySpan: ratio ${ratio}`);
  const w = MASONRY_COLUMN[columns];
  // A square needs exactly UNITS rows; floating point must not turn 64 into 65.
  return Math.ceil((MASONRY_UNITS * (ratio * w + MASONRY_REF)) / (w + MASONRY_REF) - 1e-9);
}

/** Rows one card read out of page order costs, against rows of ragged bottom (4 rows: about 40 px). */
const ORDER_WEIGHT = 4;
/** Above this many layouts to weigh, the grid's own placement is used (each card into the column that frees up first). */
const SEARCH_LIMIT = 200_000;

/**
 * Which column (1-based) each card goes in at `columns` columns, given the rows each spans, or null to let the grid place them.
 *
 * The grid's own placement puts each card, in page order, into the column that frees up first. With today's eight that left
 * one of three columns 470 px short of the others at 1440 px (a 9:16 card and a square in it, everything else in the other
 * two), and no later card may fill it without moving above an earlier one. So the server weighs every layout that keeps the
 * first row in page order (card 1, 2, 3 left to right) and takes the one whose columns end most evenly, paying ORDER_WEIGHT
 * rows for each pair of cards a reader meets out of page order (top to bottom, then left to right). Today that is three
 * columns ending within 60 px of each other, with one pair swapped (a square that starts higher than the 9:16 card before it).
 */
export function masonryColumns(spans: readonly number[], columns: number): readonly number[] | null {
  // The catalog changes with a deploy, not per request: weigh each set of cards once per server.
  const key = `${columns}:${spans.join(",")}`;
  if (!LAYOUTS.has(key)) LAYOUTS.set(key, searchColumns(spans, columns));
  return LAYOUTS.get(key)!;
}

const LAYOUTS = new Map<string, number[] | null>();

function searchColumns(spans: readonly number[], columns: number): number[] | null {
  const n = spans.length;
  if (n <= columns) return spans.map((_, i) => i + 1);
  if (columns ** (n - columns) > SEARCH_LIMIT) return null;
  const pick = spans.map((_, i) => (i < columns ? i : 0));
  let best: number[] | null = null;
  let bestCost = Infinity;
  const ends = new Array<number>(columns);
  const starts = new Array<number>(n);
  const walk = (i: number) => {
    if (i === n) {
      ends.fill(0);
      for (let k = 0; k < n; k++) {
        starts[k] = ends[pick[k]];
        ends[pick[k]] += spans[k];
      }
      let out = 0;
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (starts[b] < starts[a] || (starts[b] === starts[a] && pick[b] < pick[a])) out++;
      const cost = Math.max(...ends) - Math.min(...ends) + ORDER_WEIGHT * out;
      if (cost < bestCost) {
        bestCost = cost;
        best = pick.slice();
      }
      return;
    }
    for (let c = 0; c < columns; c++) {
      pick[i] = c;
      walk(i + 1);
    }
  };
  walk(columns);
  return best && (best as number[]).map((c) => c + 1);
}
