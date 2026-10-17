/**
 * A Supabase stub that RECORDS the chain of calls each query makes, so a test can assert what was asked (a filter, an
 * order, a range, `head: true`), not only what came back. `resolve` decides the answer from the table and the calls.
 */
export type Call = [method: string, args: unknown[]];
export type Res = { data: unknown; error: unknown; count?: number | null };
export interface Query {
  table: string;
  calls: Call[];
}

export function recordingSupabase(resolve: (table: string, calls: Call[]) => Res) {
  const log: Query[] = [];
  function builder(table: string): unknown {
    const calls: Call[] = [];
    log.push({ table, calls });
    const q: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          return (res: (v: Res) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(resolve(table, calls)).then(res, rej);
        }
        return (...args: unknown[]) => {
          calls.push([String(prop), args]);
          return q;
        };
      },
      apply: () => q,
    });
    return q;
  }
  return {
    log,
    client: { from: (table: string) => builder(table), rpc: (fn: string) => builder(fn), auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } },
    /** Every query made on `table` (optionally only those that made this call). */
    of: (table: string, method?: string) => log.filter((q) => q.table === table && (!method || q.calls.some(([m]) => m === method))),
  };
}

export const has = (q: Query, method: string, ...args: unknown[]) =>
  q.calls.some(([m, a]) => m === method && args.every((x, i) => JSON.stringify(a[i]) === JSON.stringify(x)));
export const arg = (q: Query, method: string, i = 0) => q.calls.find(([m]) => m === method)?.[1][i];
