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

export function safeNextPath(raw: string | null | undefined, fallback: string = DEFAULT_AFTER_AUTH): string {
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  if (!value || value.length > MAX_NEXT_LENGTH) return fallback;
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
  return `${url.pathname}${url.search}${url.hash}`;
}
