/**
 * The authorization request and its two ends: what the URL asks for, and where
 * the person is sent back. Pure; the page and the decision route use it.
 */

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string | null;
  scope: string | null;
  resource: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Raw = Record<string, string | string[] | undefined>;

function single(raw: Raw, name: string): string | null | undefined {
  const v = raw[name];
  if (Array.isArray(v)) return v.length === 1 ? v[0] : null; // a repeated parameter is refused
  return v;
}

/** The request's parameters, or why it cannot be served at all (no redirect). */
export function parseAuthorizeParams(raw: Raw): { ok: true; params: AuthorizeParams } | { ok: false; reason: "bad_request" | "unknown_client" } {
  const clientId = single(raw, "client_id");
  const redirectUri = single(raw, "redirect_uri");
  if (!clientId || !UUID_RE.test(clientId)) return { ok: false, reason: "unknown_client" };
  if (!redirectUri || redirectUri.length > 300) return { ok: false, reason: "bad_request" };
  const other = ["response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"].map((n) => single(raw, n));
  if (other.some((v) => v === null)) return { ok: false, reason: "bad_request" };
  const [responseType, codeChallenge, method, state, scope, resource] = other as (string | undefined)[];
  return {
    ok: true,
    params: {
      clientId: clientId.toLowerCase(),
      redirectUri,
      responseType: responseType ?? "",
      codeChallenge: codeChallenge ?? "",
      codeChallengeMethod: method ?? "",
      state: state ?? null,
      scope: scope ?? null,
      resource: resource ?? null,
    },
  };
}

/** The registered redirect URI with the answer added. RFC 9207: `iss` is on
 *  every response, errors included, so a client talking to several servers can
 *  tell which one answered. */
export function redirectWith(redirectUri: string, params: Record<string, string | null | undefined>, issuer: string): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") q.set(k, v);
  q.set("iss", issuer);
  return redirectUri + (redirectUri.includes("?") ? "&" : "?") + q.toString();
}

/** Where the sign-in sends a person back: this page, same query, nothing else. */
export function authorizeReturnPath(search: string): string {
  return "/oauth/authorize" + (search.startsWith("?") ? search : search ? "?" + search : "");
}
