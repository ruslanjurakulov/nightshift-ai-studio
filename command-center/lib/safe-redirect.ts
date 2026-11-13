/**
 * Where a sign-in link may send the browser afterwards.
 *
 * `/auth/callback?next=…` is reachable by anyone and is the page an emailed
 * link opens, so `next` is attacker-writable: a link that confirms a real
 * account and then forwards to `https://evil.example/login` is a phishing page
 * with our domain in front of it. Only a path on this origin is accepted.
 *
 * Browsers are generous about what counts as "a path": `//evil.com` and
 * `/\evil.com` are both protocol-relative URLs to another host, and a tab or
 * newline inside a URL is silently stripped. So the check is a whitelist of
 * shape followed by the URL parser's own verdict, never a prefix test alone.
 */

export const DEFAULT_AFTER_AUTH = "/welcome";

const MAX_NEXT_LENGTH = 512;
const PROBE_ORIGIN = "https://nightshift.invalid";

export function safeNextPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_AFTER_AUTH,
  maxLength: number = MAX_NEXT_LENGTH,
): string {
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  if (!value || value.length > maxLength) return fallback;
  // One leading slash, then not another slash or a backslash.
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  // Backslashes are read as slashes by browsers; control characters are
  // stripped before parsing — either can turn a "path" into another host.
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback;

  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;
  // Sending the callback back to itself would loop on a spent code.
  if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) return fallback;
  const out = `${url.pathname}${url.search}${url.hash}`;
  // Dot segments are resolved by the parser: `/a/..//evil.com` becomes the
  // path `//evil.com`, which `new URL(next, origin)` and router.push read as
  // another host. The shape check above ran on the raw value; run it again on
  // what is actually returned.
  if (out.startsWith("//") || out.includes("\\")) return fallback;
  return out;
}

/** The page an AI app's connection request sends a signed-out person through
 *  sign-in and back to. Its query (PKCE challenge, state, redirect URI) is
 *  longer than an ordinary `next`, so it gets a longer bound — and it is the
 *  ONLY longer path: anything else falls back to the ordinary rule. */
export function safeLoginReturn(raw: string | null | undefined, fallback: string): string {
  const long = safeNextPath(raw, "", 2048);
  if (long === "/oauth/authorize" || long.startsWith("/oauth/authorize?")) return long;
  return safeNextPath(raw, fallback);
}

/**
 * The Studio form in the all-channels workspace (`/all-channels/create…`): the one kind of `next` sign-up carries through /welcome.
 * A model sample's "Try it" on the public site (lib/site/showcase-link.ts) sends a signed-out visitor to
 * `/signup?next=/all-channels/create?…`, and that is all it ever emits. Pinned to that one segment rather than any channel slug, so
 * no reserved root (/api, /oauth, /auth, /admin …) can ever pass as one. The slug is lib/channels ALL_CHANNELS_SLUG, written out here
 * so this module stays free of the channel code (tests/site-showcase.test.tsx holds the two equal).
 */
export const STUDIO_NEXT_PREFIX = "/all-channels/create";
const STUDIO_NEXT_RE = /^\/all-channels\/create(?:\?|$)/;

export function studioNext(raw: string | null | undefined): string | null {
  const next = safeNextPath(raw, "");
  return next && STUDIO_NEXT_RE.test(next) ? next : null;
}

/**
 * Where a new account goes once it is signed in. Always /welcome first: an account without a workspace is sent there by the
 * (app) layout anyway, and a `next` given to the callback directly would be dropped on that redirect. With a Studio form to come
 * back to, /welcome carries it (`/welcome?next=…`) and its last button opens it. The whole thing must still be a `next` the
 * callback accepts (MAX_NEXT_LENGTH); one that would not fit is dropped rather than cut, and the person lands on plain /welcome.
 */
export function afterSignupPath(raw: string | null | undefined): string {
  const next = studioNext(raw);
  if (!next) return DEFAULT_AFTER_AUTH;
  const wrapped = `${DEFAULT_AFTER_AUTH}?next=${encodeURIComponent(next)}`;
  return wrapped.length <= MAX_NEXT_LENGTH ? wrapped : DEFAULT_AFTER_AUTH;
}

/** Whether afterSignupPath() still carries this Studio path (the try-it link builder sizes its words to it). */
export function fitsAfterSignup(next: string): boolean {
  return afterSignupPath(next) !== DEFAULT_AFTER_AUTH;
}
