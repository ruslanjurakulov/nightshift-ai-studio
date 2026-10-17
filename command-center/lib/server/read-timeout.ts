/**
 * A page read that cannot hang the page. A Supabase request that never answers left the Command Center on its skeleton
 * for ever (no message, no retry). `timed` races the read against a timer: past `ms` it resolves to a failed read
 * (`error` set, `data` null, `count` null), which every owner page already renders as "unknown" / "could not read" with a
 * Retry, never as an empty list or a zero. The request itself is not cancelled; its late answer is simply ignored.
 */
export const READ_TIMEOUT_MS = 8_000;

export const TIMED_OUT = Object.freeze({
  data: null,
  count: null,
  status: 0,
  statusText: "timeout",
  error: Object.freeze({ code: "timeout", message: "The read took too long and was given up on.", details: "", hint: "" }),
});

export function timed<R>(read: PromiseLike<R>, ms: number = READ_TIMEOUT_MS): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<R>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT as unknown as R), ms);
  });
  return Promise.race([Promise.resolve(read).catch(() => TIMED_OUT as unknown as R), late]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
