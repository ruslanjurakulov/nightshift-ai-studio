/**
 * Reads a table page by page, newest first, up to a sane ceiling, and says when it stopped short.
 *
 * Why: PostgREST answers at most `max_rows` rows a request (1,000 on Supabase's default, and the dashboard can lower it),
 * whatever `.limit()` asks. A single `.limit(10000)` with no ORDER BY therefore handed the Billing page an arbitrary
 * 1,000 rows, and burn, ledger balance and unit cost were computed from them with no warning. Here:
 *  - the caller's query is ordered (newest first, with a unique tie-break) and asks for a page with `.range()`;
 *  - the next page starts after the rows actually RECEIVED, so a server that caps below the page size cannot make a short
 *    page look like the end; with the exact total (`count`) the read stops only when the total is reached;
 *  - rows are de-duplicated by key, because an insert between two pages shifts every offset by one;
 *  - the read has an overall time budget; past it the rows so far are returned as a partial, flagged `truncated`.
 */

export interface PageResult<T> {
  data: T[] | null;
  error: unknown;
  /** The exact number of matching rows (PostgREST `count: "exact"`), when the query asked for it. */
  count?: number | null;
}

export interface PagedRead<T> {
  rows: T[];
  /** The first error any page returned: the read as a whole failed and `rows` must not be used as "everything". */
  error: unknown;
  /** The ceiling or the time budget was reached with more rows still there: `rows` are the NEWEST `rows.length`. */
  truncated: boolean;
  /** What stopped a truncated read. */
  reason: "ceiling" | "time" | null;
}

export const PAGE_SIZE = 500;
/** 40 pages of 500: 20,000 rows. */
export const MAX_PAGES = 40;
/** Overall time budget for the whole multi-page read. */
export const READ_BUDGET_MS = 12_000;

const TIMED_OUT = Symbol("timed out");

export async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  opts: { pageSize?: number; maxPages?: number; budgetMs?: number; keyOf?: (row: T) => string | number | null | undefined } = {},
): Promise<PagedRead<T>> {
  const size = Math.max(1, Math.floor(opts.pageSize ?? PAGE_SIZE));
  const max = Math.max(1, Math.floor(opts.maxPages ?? MAX_PAGES));
  const budget = opts.budgetMs ?? READ_BUDGET_MS;
  const started = Date.now();
  const rows: T[] = [];
  const seen = new Set<string | number>();
  let from = 0;
  let total: number | null = null;

  for (let i = 0; i < max; i++) {
    const left = budget - (Date.now() - started);
    if (left <= 0) return { rows, error: null, truncated: true, reason: "time" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let res: PageResult<T> | typeof TIMED_OUT;
    try {
      res = await Promise.race([
        Promise.resolve(page(from, from + size - 1)),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), left);
        }),
      ]);
    } catch (e) {
      return { rows: [], error: e ?? new Error("read failed"), truncated: false, reason: null };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res === TIMED_OUT) {
      // Nothing at all read in the time: that is a failed read, not a partial one.
      return rows.length === 0
        ? { rows: [], error: new Error("timeout"), truncated: false, reason: null }
        : { rows, error: null, truncated: true, reason: "time" };
    }
    if (res.error || !Array.isArray(res.data)) return { rows: [], error: res.error ?? new Error("no data"), truncated: false, reason: null };
    if (total === null && typeof res.count === "number") total = res.count;
    for (const row of res.data) {
      const key = opts.keyOf?.(row);
      if (key !== undefined && key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      rows.push(row);
    }
    // The next page starts after what was received (a server cap below `size` must not end the read early).
    from += res.data.length;
    // With the exact total the read ends when that many DISTINCT rows are in hand (a repeat from a shifted offset does not
    // count), or when the server has nothing more to give: then anything short of the total is flagged as cut.
    if (total !== null) {
      if (rows.length >= total) return { rows, error: null, truncated: false, reason: null };
      if (res.data.length === 0) return { rows, error: null, truncated: true, reason: "ceiling" };
      continue;
    }
    if (res.data.length < size) return { rows, error: null, truncated: false, reason: null };
  }
  return { rows, error: null, truncated: true, reason: "ceiling" };
}
