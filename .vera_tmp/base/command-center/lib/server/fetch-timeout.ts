/**
 * `fetch` that gives up. A bare fetch to GitHub, Paddle or Slack waits as long as the platform lets a request run, so a
 * slow third party made the owner's whole page spin and then fail. Every server-side call that happens while a page
 * renders goes through this: after `ms` the request is aborted and the caller's existing `catch` (which already turns a
 * failure into "could not check", not "not set") takes over.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 8_000;

export function fetchWithTimeout(input: string | URL, init: RequestInit = {}, ms: number = DEFAULT_FETCH_TIMEOUT_MS): Promise<Response> {
  const timeout = AbortSignal.timeout(ms);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}
