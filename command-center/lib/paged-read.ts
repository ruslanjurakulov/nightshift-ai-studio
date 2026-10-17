/**
 * Reads a table page by page, newest first, up to a sane ceiling, and says when it stopped short.
 *
 * Why: PostgREST answers at most `max_rows` rows a request (1,000 on Supabase's default), whatever `.limit()` asks. A
 * single `.limit(10000)` with no ORDER BY therefore handed the Billing page an arbitrary 1,000 rows, and burn, ledger
 * balance and unit cost were computed from them with no warning. Here the query is ordered (the caller's builder must
 * order newest first, with a unique tie-break), read in pages of `pageSize`, and the result carries `truncated` so the
 * page can print "cut at N rows" instead of presenting a partial sum as the whole.
 */

export interface PageResult<T> {
  data: T[] | null;
  error: unknown;
}

export interface PagedRead<T> {
  rows: T[];
  /** The first error any page returned: the read as a whole failed and `rows` must not be used as "everything". */
  error: unknown;
  /** The ceiling was reached with more rows still there: `rows` are the NEWEST `rows.length`, older ones are missing. */
  truncated: boolean;
}

export const PAGE_SIZE = 1000;
/** 20 pages of 1,000: enough for 20,000 ledger rows, a handful of seconds at worst. */
export const MAX_PAGES = 20;

export async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<PagedRead<T>> {
  const size = Math.max(1, Math.floor(opts.pageSize ?? PAGE_SIZE));
  const max = Math.max(1, Math.floor(opts.maxPages ?? MAX_PAGES));
  const rows: T[] = [];
  for (let i = 0; i < max; i++) {
    let res: PageResult<T>;
    try {
      res = await page(i * size, i * size + size - 1);
    } catch (e) {
      return { rows: [], error: e ?? new Error("read failed"), truncated: false };
    }
    if (res.error || !Array.isArray(res.data)) return { rows: [], error: res.error ?? new Error("no data"), truncated: false };
    rows.push(...res.data);
    // A short page is the end. A full page might be the end too; one more request settles it.
    if (res.data.length < size) return { rows, error: null, truncated: false };
  }
  return { rows, error: null, truncated: true };
}
