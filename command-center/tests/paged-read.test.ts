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
  it("stops at the ceiling and SAYS it stopped short", async () => {
    const page = vi.fn(async (from: number) => ({ data: rows(1000, from), error: null }));
    const out = await readAllPages(page, { pageSize: 1000, maxPages: 3 });
    expect(page).toHaveBeenCalledTimes(3);
    expect(out.rows).toHaveLength(3000);
    expect(out.truncated).toBe(true);
  });
  it("one failed page fails the read: no partial rows to be mistaken for everything", async () => {
    const out = await readAllPages(async (from) => (from === 0 ? { data: rows(1000), error: null } : { data: null, error: { message: "boom" } }));
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
