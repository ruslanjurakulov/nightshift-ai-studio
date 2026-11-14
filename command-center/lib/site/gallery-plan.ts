/**
 * Where each card of the explore grid goes (components/site/ShowcaseGallery.tsx), planned on the server so the grid ends level.
 *
 * The grid's row is a hundredth of a column's width (site-next.css .nx-gallery), and a card spans its file's height in those rows
 * plus the gutter (gridSpan). Left to the browser, cards in a masonry end where they end: the live page's four columns stopped at
 * 1109, 946, 946 and 1106 px, a 160 px hole under two of them, and the owner has twice complained about holes in a grid. So:
 *
 * 0. which cards: on the landing, after the ones the model tiles link to, the grid fills its few places with the samples that
 *    make the columns come out level (components/site/landing-samples.tsx; two 9:16 clips and six 16:9 ones end level at both
 *    three and four columns, where three and five left a 160 px hole);
 * 1. the order: a few swaps of the cards, kept only while they make the columns end closer together (at three and at four
 *    columns at once, since the page has one order for both);
 * 2. the place: each card, in that order, goes to the column that ends highest (the leftmost of a tie), so the cards' start rows
 *    never go back up: the page's order is the grid's reading order, row by row, and Tab follows it;
 * 3. the level: the last card of each column that ends short grows to the common bottom. Its picture is drawn `object-fit:
 *    cover` from the centre, so it crops a little; nothing is added to the grid that is not a sample.
 *
 * Pure arithmetic over whole rows, so the planned bottoms are equal exactly, and tests/site-gallery-plan.test.ts holds it for the
 * shipped samples and for random sets.
 */

/**
 * How many of the grid's rows a card spans: a row is a hundredth of a column's width, so a card of width w and height h spans
 * 100·h/w rows, plus four for the gutter under it. Two cards whose files differ by a few pixels (1280×718 and 1280×720) span the
 * same rows, so their tops and bottoms line up.
 */
export const GRID_GUTTER_ROWS = 4;
export function gridSpan(width: number, height: number): number {
  return Math.round((100 * height) / width) + GRID_GUTTER_ROWS;
}

/** One card's place: its column and first row (1-based, as CSS grid lines count) and how many rows it spans. */
export type Cell = { col: number; row: number; span: number };

/** The column counts the page plans (site-next.css: three from 760 px, four from 1240 px; a phone's two flow by themselves). */
export const PLANNED_COLUMNS = [3, 4] as const;

/** Places `spans`, in order, each in the column that ends highest (the leftmost of a tie). Returns the cells and the bottoms. */
export function place(spans: readonly number[], cols: number): { cells: Cell[]; bottoms: number[] } {
  const bottoms = new Array<number>(cols).fill(0);
  const cells = spans.map((span) => {
    let c = 0;
    for (let i = 1; i < cols; i++) if (bottoms[i] < bottoms[c]) c = i;
    const cell = { col: c + 1, row: bottoms[c] + 1, span };
    bottoms[c] += span;
    return cell;
  });
  return { cells, bottoms };
}

/** `place`, then the last card of each column that ends short grows to the lowest bottom, so every column ends on the same row. */
export function level(spans: readonly number[], cols: number): { cells: Cell[]; bottom: number } {
  const { cells, bottoms } = place(spans, cols);
  const bottom = Math.max(0, ...bottoms);
  for (let c = 1; c <= cols; c++) {
    const last = cells.reduce<number>((at, cell, i) => (cell.col === c ? i : at), -1);
    if (last >= 0) cells[last] = { ...cells[last], span: cells[last].span + (bottom - bottoms[c - 1]) };
  }
  return { cells, bottom };
}

/**
 * How much a plan crops: for each card that grows, the share of its height that is added, squared (one card cropped by half is
 * worse than two cropped by a quarter), summed over the planned column counts. 0 when the columns already end level.
 */
export function levelCost(spans: readonly number[]): number {
  let total = 0;
  for (const cols of PLANNED_COLUMNS) {
    const grown = level(spans, cols).cells;
    grown.forEach((cell, i) => {
      const add = (cell.span - spans[i]) / spans[i];
      total += add * add;
    });
  }
  return total;
}

/**
 * The order to lay the cards out in: the given one, improved by swapping two cards while a swap lowers the crop (cost), up to a
 * bounded number of passes so a page render stays cheap. Returns indices into `spans`. Deterministic: the same spans, the same
 * order, on the server and in every test.
 */
export function levelOrder(spans: readonly number[], passes = 4): number[] {
  const order = spans.map((_, i) => i);
  const of = (o: readonly number[]) => levelCost(o.map((i) => spans[i]));
  let best = of(order);
  for (let p = 0; p < passes && best > 0; p++) {
    let improved = false;
    for (let a = 0; a < order.length; a++) {
      for (let b = a + 1; b < order.length; b++) {
        [order[a], order[b]] = [order[b], order[a]];
        const c = of(order);
        if (c < best - 1e-9) {
          best = c;
          improved = true;
        } else {
          [order[a], order[b]] = [order[b], order[a]];
        }
      }
    }
    if (!improved) break;
  }
  return order;
}

/** The crop of the best order levelOrder finds for these spans (what choosing which cards to show compares). */
export function bestLevelCost(spans: readonly number[]): number {
  return levelCost(levelOrder(spans).map((i) => spans[i]));
}
