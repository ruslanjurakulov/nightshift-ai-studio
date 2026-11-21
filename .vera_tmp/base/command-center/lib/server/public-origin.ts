/**
 * The origin the browser actually used — the one Google must redirect back to.
 *
 * On Vercel `request.url` already carries it. Behind our own reverse proxy it
 * does not: the standalone server builds `request.url` from the address it is
 * bound to, so a request that arrived as https://app.example.com/... reads as
 * https://0.0.0.0:3000/... (measured on the container in deploy/). An OAuth
 * redirect_uri built from that is one Google has never heard of, and the
 * "Connect YouTube" button fails at the consent screen.
 *
 * So a self-hosted deploy states its origin once, in APP_ORIGIN (compose sets it
 * from DOMAIN), rather than trusting a Host or X-Forwarded-* header a client can
 * write. Unset — as on Vercel — the request's own origin is used, exactly as
 * before. A value that is not an http(s) URL is ignored rather than trusted:
 * a typo must not become the redirect target.
 */
export function publicOrigin(request: Request): string {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      /* fall through to the request's own origin */
    }
  }
  return new URL(request.url).origin;
}
