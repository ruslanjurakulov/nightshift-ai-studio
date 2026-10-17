import { NextResponse } from "next/server";
import { isSameOriginPost } from "@/lib/auth-confirm";
import { publicOrigin } from "@/lib/server/public-origin";

/**
 * One same-origin gate for every state-changing route that a browser calls with
 * its cookies (docs/security/ADMIN_MFA.md, "Same-origin check"; ledger BR-S-018).
 *
 * `SameSite=Lax` already keeps a cross-site POST from carrying the session
 * cookie, but it is one layer: a sibling host, a Lax bypass or a future
 * `SameSite=None` would turn every cookie-authenticated POST into a CSRF
 * target. The check is the existing `isSameOriginPost`: an `Origin` that is ours
 * (the configured APP_ORIGIN or the request's own), and `Sec-Fetch-Site`, when
 * the browser sends it, saying `same-origin`. A missing, `null` or foreign
 * Origin is refused with 403 before the handler reads anything or touches the
 * session.
 *
 * Do NOT wrap a machine-to-machine route (a webhook, the public API, MCP, the
 * OAuth token endpoints, signed media, review links, one-click unsubscribe):
 * those authenticate with their own token or signature and are called without
 * our origin. tests/same-origin-routes.test.ts keeps the list of those, each
 * with its reason, and fails for any other mutating route that has neither
 * this wrapper nor an equivalent check.
 */
const NO_STORE = { "cache-control": "no-store" };

export interface SameOriginOptions {
  /**
   * Accept a request with NO Origin header, but only when the browser itself says `Sec-Fetch-Site: same-origin`.
   * For the XHR upload PUT, where some browsers omit Origin on a same-origin PUT. `Sec-Fetch-Site` is set by the
   * browser and a page cannot forge or remove it (it is a forbidden header name), so a cross-site page cannot
   * use this; `Origin: null`, a foreign Origin, and a missing Origin without that header are still refused.
   */
  allowMissingOriginWhenSameOrigin?: boolean;
}

/** The 403 to send when the request did not come from our own page, or null to carry on. */
export function rejectCrossOrigin(request: Request, options: SameOriginOptions = {}): NextResponse | null {
  const ours = [publicOrigin(request), new URL(request.url).origin];
  if (isSameOriginPost(request.headers, ours)) return null;
  if (
    options.allowMissingOriginWhenSameOrigin &&
    request.headers.get("origin") === null &&
    request.headers.get("sec-fetch-site") === "same-origin"
  ) {
    return null;
  }
  return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
}

/**
 * Wrap a route handler (POST, PUT, PATCH or DELETE) so it only runs for a
 * same-origin request. The wrapper keeps the handler's exact type, so Next's
 * route typing and the `{ params }` second argument are unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function requireSameOrigin<H extends (request: any, ...rest: any[]) => Response | Promise<Response>>(
  handler: H,
  options: SameOriginOptions = {},
): H {
  const wrapped = async (request: Request, ...rest: unknown[]): Promise<Response> =>
    rejectCrossOrigin(request, options) ?? (await handler(request, ...rest));
  return wrapped as unknown as H;
}
