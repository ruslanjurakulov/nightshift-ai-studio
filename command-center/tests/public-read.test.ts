import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAIL_TTL_MS, OK_TTL_MS, PUBLIC_READ_TIMEOUT_MS, cachedPublicRead, resetPublicReads } from "@/lib/server/public-read";

/**
 * BR-L-047: /, /pricing and /docs/api read the public price lists for every
 * visitor. A stalled backend must not hold the page (it hung > 25 s), and
 * anonymous traffic must not become a backend call per hit.
 */
beforeEach(() => {
  resetPublicReads();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("a public page's backend read", () => {
  it("gives up after the timeout, aborts the request and reads as null (no price published)", async () => {
    let aborted = false;
    const stalled = (signal: AbortSignal) =>
      new Promise<number>(() => signal.addEventListener("abort", () => (aborted = true)));
    const out = cachedPublicRead("k", stalled);
    await vi.advanceTimersByTimeAsync(PUBLIC_READ_TIMEOUT_MS);
    await expect(out).resolves.toBeNull();
    expect(aborted).toBe(true);
  });

  it("settles on time even when the client ignores the abort signal", async () => {
    const out = cachedPublicRead("k", () => new Promise<number>(() => {}));
    await vi.advanceTimersByTimeAsync(PUBLIC_READ_TIMEOUT_MS + 1);
    await expect(out).resolves.toBeNull();
  });

  it("keeps a good read for a minute: the next visitors cost no backend call", async () => {
    const read = vi.fn(async () => 120);
    expect(await cachedPublicRead("k", read)).toBe(120);
    expect(await cachedPublicRead("k", read)).toBe(120);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(OK_TTL_MS + 1);
    await cachedPublicRead("k", read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps a failure only briefly, so a recovered backend is read again soon", async () => {
    const read = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await cachedPublicRead("k", read)).toBeNull();
    expect(await cachedPublicRead("k", read)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FAIL_TTL_MS + 1);
    await cachedPublicRead("k", read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(FAIL_TTL_MS).toBeLessThan(OK_TTL_MS);
  });

  it("shares one read between concurrent visitors", async () => {
    let resolve: (v: number) => void = () => {};
    const read = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    const a = cachedPublicRead("k", read);
    const b = cachedPublicRead("k", read);
    resolve(60);
    expect(await Promise.all([a, b])).toEqual([60, 60]);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
