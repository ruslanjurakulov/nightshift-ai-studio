/**
 * Redirect URIs and resource identifiers, validated.
 *
 * validateRedirectUri is the TypeScript twin of oauth_redirect_uri_ok (0093):
 * https with a real lower-case DNS name, or http to a loopback address (a
 * native or command-line app), and exactly one private-use scheme, the Cursor
 * editor's own callback. No fragment, userinfo, wildcard, whitespace, control
 * character or backslash; no IP literal or single-label host over https; no
 * javascript:, data: or other custom scheme. The database checks again with
 * the same rule, and the authorize endpoint compares the string EXACTLY with
 * what was registered — this module never normalizes a URI into a match.
 */

export type RedirectProblem =
  | "empty"
  | "too_long"
  | "forbidden_character"
  | "not_allowed"
  | "bad_port";

const HTTPS =
  /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9](?::([0-9]{1,5}))?(?:\/[^?#]*)?(?:\?[^#]*)?$/;
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?(?:\/[^?#]*)?(?:\?[^#]*)?$/;
const CURSOR = /^cursor:\/\/anysphere\.cursor-retrieval\/oauth\/[A-Za-z0-9._~/-]{1,200}$/;

export function validateRedirectUri(uri: unknown): { ok: true } | { ok: false; reason: RedirectProblem } {
  if (typeof uri !== "string" || uri.length === 0) return { ok: false, reason: "empty" };
  if (uri.length > 300) return { ok: false, reason: "too_long" };
  if (/[\s\u0000-\u001f\u007f-\u009f\\#@*]/.test(uri)) return { ok: false, reason: "forbidden_character" };
  const m = HTTPS.exec(uri) ?? LOOPBACK.exec(uri);
  if (m) {
    if (m[1] !== undefined && Number(m[1]) > 65535) return { ok: false, reason: "bad_port" };
    return { ok: true };
  }
  if (CURSOR.test(uri)) return { ok: true };
  return { ok: false, reason: "not_allowed" };
}

/** What the consent screen shows next to the app's name: where the browser will
 *  be sent. A loopback address is the person's own computer. */
export function describeRedirect(uri: string): { host: string; local: boolean } {
  try {
    const u = new URL(uri);
    if (u.protocol === "cursor:") return { host: "cursor://" + u.host, local: true };
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    return { host: u.host, local };
  } catch {
    return { host: "?", local: false };
  }
}

/**
 * The resource a token is for (RFC 8707). Only the MCP server's own URL is a
 * resource here; the scheme and host may arrive in any case and one trailing
 * slash is tolerated (the MCP spec asks servers to accept both). Anything else
 * — another host, a path below it, a query, a fragment, userinfo — is not ours.
 * Absent means "the MCP server": there is no other resource to mean.
 */
export function normalizeResource(raw: string | null | undefined, canonical: string): string | null {
  if (raw == null || raw === "") return canonical;
  if (raw.length > 255 || /[\s\u0000-\u001f]/.test(raw)) return null;
  let u: URL;
  let want: URL;
  try {
    u = new URL(raw);
    want = new URL(canonical);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash || raw.includes("#") || raw.includes("?")) return null;
  const path = u.pathname.replace(/\/+$/, "");
  if (u.origin !== want.origin || path !== want.pathname) return null;
  return canonical;
}

/** An app's name as shown to a person: printable, no direction overrides, bounded. */
export function cleanClientName(raw: unknown, fallbackHost: string): string {
  const s = typeof raw === "string" ? raw : "";
  const cleaned = s
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || fallbackHost.slice(0, 80);
}
