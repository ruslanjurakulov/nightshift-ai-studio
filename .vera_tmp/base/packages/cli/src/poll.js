import { CliError, EXIT } from "./errors.js";

/**
 * Poll a GET until `isDone`. Backoff 2s -> x1.5 -> 15s; a 429 waits out its
 * Retry-After; up to 5 failures in a row (network, 5xx) are tolerated because
 * a GET is safe to repeat. Never used for a POST.
 *
 * @template T
 * @param {object} o
 * @param {() => Promise<T>} o.fetchOnce
 * @param {(v: T) => boolean} o.isDone
 * @param {(v: T) => void} [o.onUpdate]
 * @param {import("./io.js").Io} o.io
 * @param {number} o.timeoutSeconds
 * @param {string} o.what
 */
export async function pollUntil({ fetchOnce, isDone, onUpdate, io, timeoutSeconds, what }) {
  const started = io.now();
  const deadline = started + timeoutSeconds * 1000;
  let delay = 2000;
  let failures = 0;
  for (;;) {
    let value;
    try {
      value = await fetchOnce();
      failures = 0;
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      const transient = e.code === "network_error" || e.code === "timeout" || (e.status != null && e.status >= 500) || e.status === 429;
      if (!transient || ++failures > 5) throw e;
      const wait = e.status === 429 ? Math.max(1, e.retryAfter ?? 5) * 1000 : delay;
      if (io.now() + wait >= deadline) throw timedOut(what, timeoutSeconds);
      await io.sleep(wait);
      continue;
    }
    if (onUpdate) onUpdate(value);
    if (isDone(value)) return value;
    if (io.now() + delay >= deadline) throw timedOut(what, timeoutSeconds);
    await io.sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), 15000);
  }
}

function timedOut(what, seconds) {
  return new CliError("wait_timeout", `Stopped waiting for ${what} after ${seconds}s. It is still going on the server; nothing was cancelled.`, {
    exit: EXIT.ERROR,
  });
}
