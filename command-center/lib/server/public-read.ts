/**
 * A backend read a PUBLIC page makes for every visitor (the price lists on
 * /, /pricing and /docs/api), bounded in time and shared between requests.
 *
 * Why (BR-L-047): these pages are rendered per request, and an unbounded read
 * meant a stalled backend held the front door for as long as the socket did
 * (over 25 s in the lab), and every anonymous hit became fresh backend calls.
 * So each read:
 *   - gives up after PUBLIC_READ_TIMEOUT_MS (the signal aborts the request;
 *     a timer also settles it, in case a client ignores the signal) and is
 *     then null — which every caller already renders as "no price published";
 *   - is kept for OK_TTL_MS when it worked (a price list changes rarely), and
 *     for FAIL_TTL_MS when it did not, so a down backend is retried soon but
 *     not by every visitor;
 *   - is shared while in flight: concurrent visitors wait on one read.
 * The cache is this server instance's memory: nothing private is kept in it,
 * only public price lists.
 */

export const PUBLIC_READ_TIMEOUT_MS = 1500;
export const OK_TTL_MS = 60_000;
export const FAIL_TTL_MS = 10_000;

type Entry = { value: unknown; until: number };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

export async function cachedPublicRead<T>(
  key: string,
  read: (signal: AbortSignal) => Promise<T | null>,
  /** A read that worked but is incomplete (part of it failed) is kept only as
   *  long as a failure, so the gap is retried soon (BR-L-131). */
  degraded: (value: T) => boolean = () => false,
): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value as T | null;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T | null>;

  const run = (async () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, PUBLIC_READ_TIMEOUT_MS);
    });
    let value: T | null;
    try {
      value = await Promise.race([read(controller.signal).catch(() => null), timeout]);
    } finally {
      clearTimeout(timer);
    }
    const short = value === null || degraded(value as T);
    cache.set(key, { value, until: Date.now() + (short ? FAIL_TTL_MS : OK_TTL_MS) });
    return value;
  })();
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

/** Tests only: forget every kept read. */
export function resetPublicReads(): void {
  cache.clear();
  inflight.clear();
}
