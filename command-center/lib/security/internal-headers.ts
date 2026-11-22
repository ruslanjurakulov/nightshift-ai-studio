/**
 * Request headers that only the middleware may write (middleware.ts).
 *
 * Server Components cannot see the URL, so the middleware hands them the channel, the path, the query string, the
 * phone-frame target and the CSP policy (whose nonce Next stamps on every script) as request headers. A header a
 * client sent under one of these names would be read by the same helpers as if the middleware had set it, and
 * several of the middleware's early returns (public pages, the public API, signed media, review links, fonts)
 * forward the request without setting them. So every name here is deleted from the request before anything else
 * runs, and a path the middleware does not fill carries none of them.
 *
 * Only headers the MIDDLEWARE owns belong here. `x-nightshift-client-ip` (lib/geo/client-ip.ts) looks like one but
 * is Caddy's: deploy/Caddyfile writes it on every request, replacing the client's, and deleting it here would leave
 * the geo block and every per-address rate limit with "unknown".
 */
import { CHANNEL_HEADER, PATH_HEADER, SEARCH_HEADER } from "@/lib/channels";
import { FRAME_SRC_HEADER } from "@/lib/view-mode";
import { CSP_HEADER, CSP_REPORT_ONLY_HEADER } from "@/lib/security/csp";

export const MIDDLEWARE_OWNED_REQUEST_HEADERS: readonly string[] = [
  CHANNEL_HEADER,
  PATH_HEADER,
  SEARCH_HEADER,
  FRAME_SRC_HEADER,
  // Both names: Next reads the nonce from `content-security-policy` first and the report-only one second, so in
  // report-only mode a client-sent enforcing header would otherwise choose the nonce. A browser never sends either.
  CSP_HEADER,
  CSP_REPORT_ONLY_HEADER,
];

/** Drops every middleware-owned header from a request, whatever the client sent under those names. */
export function stripMiddlewareOwnedHeaders(headers: Headers): void {
  for (const name of MIDDLEWARE_OWNED_REQUEST_HEADERS) headers.delete(name);
}
