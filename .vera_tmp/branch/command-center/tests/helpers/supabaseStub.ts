/**
 * A chainable Supabase query-builder stub. Every method returns the builder;
 * awaiting it (or `.maybeSingle()` / `.single()`) resolves to the scripted
 * result, so `scopeQuery(...).order(...).limit(...)` works unchanged.
 */
export type StubResult = { data: unknown; error: unknown };

export const FAILED: StubResult = { data: null, error: { message: "boom", code: "XX000" } };
export const EMPTY: StubResult = { data: [], error: null };
export const NO_ROW: StubResult = { data: null, error: null };

function builder(result: StubResult): unknown {
  const q: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: StubResult) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      return () => q;
    },
    apply: () => q,
  });
  return q;
}

export type Handler = (name: string) => StubResult;

/** `handler` gets the table name (from) or function name (rpc). */
export function supabaseStub(handler: Handler, user: { id: string; email: string } | null = { id: "u1", email: "me@example.com" }) {
  return {
    from: (table: string) => builder(handler(table)),
    rpc: (fn: string) => builder(handler(fn)),
    auth: { getUser: async () => ({ data: { user } }) },
  };
}

export const failingSupabase = () => supabaseStub(() => FAILED);
export const emptySupabase = () => supabaseStub(() => EMPTY);

/** The way React escapes text into markup, so a translated string can be searched for in it. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}
