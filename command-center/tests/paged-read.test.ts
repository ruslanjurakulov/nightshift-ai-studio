import { describe, expect, it, vi } from "vitest";
import { readAllPages } from "@/lib/paged-read";
import { TIMED_OUT, timed } from "@/lib/server/read-timeout";
import { fetchWithTimeout } from "@/lib/server/fetch-timeout";

const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

describe("readAllPages", () => {
  it("reads page after page until a short page, in the ranges PostgREST understands", async () => {
    const ranges: Array<[number, number]> = [];
    const out = await readAllPages(
      async (from, to) => {
        ranges.push([from, to]);
        return { data: from === 0 ? rows(1000) : from === 1000 ? rows(1000, 1000) : rows(250, 2000), error: null };
      },
      { pageSize: 1000 },
    );
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(out.rows).toHaveLength(2250);
    expect(out.truncated).toBe(false);
    expect(out.error).toBeNull();
  });
  it("the default page is 500 rows", async () => {
    const ranges: Array<[number, number]> = [];
    await readAllPages(async (from, to) => {
      ranges.push([from, to]);
      return { data: [], error: null };
    });
    expect(ranges).toEqual([[0, 499]]);
  });
  it("a server that caps BELOW the page size does not end the read: the next page starts after what was received, and the exact total decides", async () => {
    const table = rows(1000);
    const ranges: Array<[number, number]> = [];
    const out = await readAllPages(
      async (from, to) => {
        ranges.push([from, to]);
        // a max_rows of 300, whatever was asked
        return { data: table.slice(from, Math.min(to + 1, from + 300)), error: null, count: 1000 };
      },
      { pageSize: 500, keyOf: (r) => r.id },
    );
    expect(out.rows).toHaveLength(1000);
    expect(out.truncated).toBe(false);
    expect(ranges.map(([f]) => f)).toEqual([0, 300, 600, 900]);
  });
  it("without a total, a short page is the end", async () => {
    const out = await readAllPages(async () => ({ data: rows(120), error: null }), { pageSize: 500 });
    expect(out.rows).toHaveLength(120);
    expect(out.truncated).toBe(false);
  });
  it("a row repeated because an insert shifted the offsets is counted once", async () => {
    const out = await readAllPages(
      async (from) => ({ data: from === 0 ? rows(4) : [{ id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }], error: null, count: 8 }),
      { pageSize: 4, keyOf: (r) => r.id },
    );
    expect(out.rows.map((r) => r.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it("stops at the ceiling and SAYS it stopped short", async () => {
    const page = vi.fn(async (from: number) => ({ data: rows(1000, from), error: null }));
    const out = await readAllPages(page, { pageSize: 1000, maxPages: 3 });
    expect(page).toHaveBeenCalledTimes(3);
    expect(out.rows).toHaveLength(3000);
    expect(out.truncated).toBe(true);
    expect(out.reason).toBe("ceiling");
  });
  it("an overall time budget: past it the rows so far come back as a partial, flagged as cut", async () => {
    let calls = 0;
    const out = await readAllPages(
      async (from) => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 30));
        return { data: rows(500, from), error: null, count: 100000 };
      },
      { pageSize: 500, budgetMs: 80 },
    );
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(out.truncated).toBe(true);
    expect(out.reason).toBe("time");
    expect(out.rows.length).toBeGreaterThanOrEqual(500);
    expect(out.error).toBeNull();
  });
  it("a first page that does not answer in the budget is a failed read, not an empty partial", async () => {
    const out = await readAllPages(() => new Promise<never>(() => {}), { budgetMs: 30 });
    expect(out.error).toBeTruthy();
    expect(out.rows).toEqual([]);
  });
  it("one failed page fails the read: no partial rows to be mistaken for everything", async () => {
    const out = await readAllPages(async (from) => (from === 0 ? { data: rows(500), error: null } : { data: null, error: { message: "boom" } }));
    expect(out.error).toBeTruthy();
    expect(out.rows).toEqual([]);
  });
  it("a thrown request fails the read too", async () => {
    const out = await readAllPages(async () => {
      throw new Error("network");
    });
    expect(out.error).toBeTruthy();
    expect(out.rows).toEqual([]);
  });
});

describe("timed (a read that never answers becomes a failed read)", () => {
  it("passes a fast answer through", async () => {
    expect(await timed(Promise.resolve({ data: [1], error: null }), 50)).toEqual({ data: [1], error: null });
  });
  it("gives up on a hung read: data null, error set, count null", async () => {
    const hung = new Promise<never>(() => {});
    const out = (await timed(hung, 20)) as typeof TIMED_OUT;
    expect(out.data).toBeNull();
    expect(out.count).toBeNull();
    expect(out.error.code).toBe("timeout");
  });
  it("a rejected read is a failed read, not an exception", async () => {
    const out = (await timed(Promise.reject(new Error("x")), 50)) as typeof TIMED_OUT;
    expect(out.error).toBeTruthy();
  });
});

describe("fetchWithTimeout", () => {
  it("aborts a request that does not answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: unknown, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "TimeoutError"))))),
    );
    await expect(fetchWithTimeout("https://example.test/x", {}, 20)).rejects.toBeTruthy();
    vi.unstubAllGlobals();
  });
  it("passes a fast answer through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    expect(await (await fetchWithTimeout("https://example.test/x", {}, 1000)).text()).toBe("ok");
    vi.unstubAllGlobals();
  });
});
