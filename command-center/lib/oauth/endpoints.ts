/**
 * The unauthenticated OAuth endpoints, as pure functions over an injected
 * database call: dynamic client registration (RFC 7591), the token endpoint
 * (authorization_code and refresh_token) and revocation (RFC 7009). The route
 * files only wire the anon-key `rpc` in, so every refusal here is unit-tested
 * with a fake and proven again against the real functions in tests/security.
 *
 * What these never do: log a token, code or verifier; accept a client secret
 * (every client is public, PKCE is the proof); accept a query-string body;
 * answer with anything cacheable.
 */

import type { Rpc } from "@/lib/api/operations";
import { checkClientName, describeRedirect, normalizeResource, validateRedirectUri } from "@/lib/oauth/redirect";
import {
  CODE_RE,
  CODE_VERIFIER_RE,
  REFRESH_TOKEN_RE,
  ACCESS_TOKEN_RE,
  hashSecret,
  newAccessToken,
  newRefreshToken,
} from "@/lib/oauth/tokens";
import { boundedText, clientIp, oauthError, oauthJson } from "@/lib/oauth/responses";

export interface OauthDeps {
  rpc: Rpc;
  /** The server's origin (config.oauthOrigin()). */
  origin: string;
  /** The MCP resource URL a token is for. */
  resource: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRANTS = ["authorization_code", "refresh_token"];

function dbDown(): Response {
  return oauthError("server_error", "The authorization service is not available right now. Try again in a moment.", 503, {
    "retry-after": "30",
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// ── registration ────────────────────────────────────────────────────────────

export async function registerEndpoint(request: Request, deps: OauthDeps): Promise<Response> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
    return oauthError("invalid_client_metadata", "Send the registration as application/json.", 415);
  const text = await boundedText(request, 8192);
  if (text === null) return oauthError("invalid_client_metadata", "The registration is too large.", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return oauthError("invalid_client_metadata", "The registration is not valid JSON.");
  }
  if (!isObject(body)) return oauthError("invalid_client_metadata", "Send a JSON object.");

  // Public clients only: no secret is ever issued, and the answer below says
  // "none" whatever was asked for (RFC 7591 3.2.1 lets a server state the values
  // it actually registered). A client that asks for a secret-based method is
  // registered as the public client it will in fact be (PKCE is its proof);
  // methods that need a key or certificate we do not hold are refused.
  const method = body.token_endpoint_auth_method;
  if (method !== undefined && method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic")
    return oauthError("invalid_client_metadata", 'Only public clients are supported: token_endpoint_auth_method must be "none".');
  const grants = body.grant_types;
  if (grants !== undefined && (!Array.isArray(grants) || grants.length === 0 || grants.some((g) => !GRANTS.includes(g as string))))
    return oauthError("invalid_client_metadata", "grant_types may contain authorization_code and refresh_token only.");
  const responses = body.response_types;
  if (responses !== undefined && (!Array.isArray(responses) || responses.length !== 1 || responses[0] !== "code"))
    return oauthError("invalid_client_metadata", 'response_types must be ["code"].');

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5)
    return oauthError("invalid_redirect_uri", "Register 1 to 5 redirect URIs.");
  for (const u of uris) {
    const v = validateRedirectUri(u);
    if (!v.ok)
      return oauthError(
        "invalid_redirect_uri",
        "Redirect URIs must be https, or http on localhost, 127.0.0.1 or [::1], with no fragment, userinfo or wildcard.",
      );
  }
  const list = [...new Set(uris as string[])];
  // The name a person will read on the consent screen: it must show something,
  // fit 80 characters and not pass itself off as Nightshift (lookalikes, leet,
  // invisible and direction characters included). No name at all means the host.
  const named = checkClientName(body.client_name);
  if (!named.ok)
    return oauthError(
      "invalid_client_metadata",
      named.reason === "reserved"
        ? 'client_name may not contain "Nightshift": choose the name of your app.'
        : named.reason === "too_long"
          ? "client_name is limited to 80 characters."
          : "client_name must show at least one visible character.",
    );
  const name = named.name ?? describeRedirect(list[0]).host.slice(0, 80);

  const { data, error } = await deps.rpc("oauth_register_client", {
    p_name: name,
    p_redirect_uris: list,
    p_ip: clientIp(request),
  });
  if (error) return dbDown();
  const r = (isObject(data) ? data : {}) as { ok?: boolean; error?: string; description?: string; client_id?: string };
  if (r.ok && typeof r.client_id === "string") {
    return oauthJson(
      {
        client_id: r.client_id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: list,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  }
  if (r.error === "rate_limited") return oauthError("temporarily_unavailable", r.description ?? "Too many registrations; try again later.", 429, { "retry-after": "600" });
  if (r.error === "invalid_redirect_uri" || r.error === "invalid_client_metadata")
    return oauthError(r.error, r.description ?? "The registration was refused.");
  return dbDown();
}

// ── token ───────────────────────────────────────────────────────────────────

function one(params: URLSearchParams, name: string): string | null | undefined {
  const all = params.getAll(name);
  if (all.length > 1) return null; // a repeated parameter is refused, never "the first wins"
  return all[0];
}

export async function tokenEndpoint(request: Request, deps: OauthDeps): Promise<Response> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded"))
    return oauthError("invalid_request", "Send the request as application/x-www-form-urlencoded.");
  const text = await boundedText(request, 8192);
  if (text === null) return oauthError("invalid_request", "The request is too large.", 413);
  const p = new URLSearchParams(text);
  // A public client proves itself with PKCE and has no secret. The one header a
  // library may still send is Basic with the client_id and an EMPTY password;
  // anything with a password is a secret we never issued.
  const basic = /^basic\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (basic) {
    let decoded = "";
    try {
      decoded = atob(basic[1]);
    } catch {
      /* falls through to the refusal */
    }
    const at = decoded.indexOf(":");
    const user = at < 0 ? "" : decodeURIComponent(decoded.slice(0, at));
    const password = at < 0 ? "x" : decoded.slice(at + 1);
    const fromBody = one(p, "client_id");
    if (password !== "" || !user || (fromBody != null && fromBody !== user))
      return oauthError("invalid_client", "This server has only public clients: send client_id (no secret) and the PKCE code_verifier.", 401);
    if (fromBody === undefined) p.set("client_id", user);
  }
  const grantType = one(p, "grant_type");
  const clientId = one(p, "client_id");
  const rawResource = one(p, "resource");
  if (grantType === null || clientId === null || rawResource === null) return oauthError("invalid_request", "A parameter was sent twice.");
  if (!clientId || !UUID_RE.test(clientId)) return oauthError("invalid_client", "Unknown client_id.", 401);
  const resource = normalizeResource(rawResource, deps.resource);
  if (resource === null) return oauthError("invalid_target", `The resource must be ${deps.resource}.`);

  const access = newAccessToken();
  const refreshTok = newRefreshToken();
  let data: unknown;
  let error: { code?: string; message?: string } | null;

  if (grantType === "authorization_code") {
    const code = one(p, "code");
    const verifier = one(p, "code_verifier");
    const redirectUri = one(p, "redirect_uri");
    if (!code || !verifier || !redirectUri || redirectUri.length > 300)
      return oauthError("invalid_request", "code, code_verifier and redirect_uri are required.");
    // Shape first: a malformed code or verifier never costs a database call.
    if (!CODE_RE.test(code) || !CODE_VERIFIER_RE.test(verifier)) return oauthError("invalid_grant", "The authorization code is invalid or expired.");
    ({ data, error } = await deps.rpc("oauth_exchange_code", {
      p_code_hash: await hashSecret(code),
      p_client_id: clientId,
      p_redirect_uri: redirectUri,
      // The database derives the S256 challenge itself: this function is callable with the public key, so it must not trust a digest from a caller.
      p_verifier: verifier,
      p_resource: resource,
      p_access_hash: await hashSecret(access),
      p_refresh_hash: await hashSecret(refreshTok),
    }));
  } else if (grantType === "refresh_token") {
    const refresh = one(p, "refresh_token");
    if (!refresh) return oauthError("invalid_request", "refresh_token is required.");
    if (!REFRESH_TOKEN_RE.test(refresh)) return oauthError("invalid_grant", "The refresh token is invalid, expired or already used.");
    ({ data, error } = await deps.rpc("oauth_refresh", {
      p_refresh_hash: await hashSecret(refresh),
      p_client_id: clientId,
      p_resource: resource,
      p_new_access_hash: await hashSecret(access),
      p_new_refresh_hash: await hashSecret(refreshTok),
    }));
  } else {
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  if (error) return dbDown();
  const r = (isObject(data) ? data : {}) as { ok?: boolean; error?: string; scope?: string; expires_in?: number };
  if (r.ok) {
    return oauthJson({
      access_token: access,
      token_type: "Bearer",
      expires_in: typeof r.expires_in === "number" ? r.expires_in : 3600,
      refresh_token: refreshTok,
      scope: r.scope ?? "",
    });
  }
  switch (r.error) {
    case "subscription_required":
      // invalid_grant is what every client knows how to answer: start over, and
      // the consent page then explains the plan. Nothing was spent in the database.
      return oauthError(
        "invalid_grant",
        `Connecting an AI app to Nightshift needs a paid plan. Choose one at ${deps.origin}/pricing, then connect again.`,
      );
    case "invalid_target":
      return oauthError("invalid_target", `The resource must be ${deps.resource}.`);
    case "invalid_grant":
      return oauthError("invalid_grant", "The grant is invalid, expired, revoked or already used.");
    default:
      return dbDown();
  }
}

// ── revocation ──────────────────────────────────────────────────────────────

export async function revokeEndpoint(request: Request, deps: OauthDeps): Promise<Response> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded"))
    return oauthError("invalid_request", "Send the request as application/x-www-form-urlencoded.");
  const text = await boundedText(request, 4096);
  if (text === null) return oauthError("invalid_request", "The request is too large.", 413);
  const p = new URLSearchParams(text);
  const token = one(p, "token");
  const clientId = one(p, "client_id");
  if (!token) return oauthError("invalid_request", "token is required.");
  if (!clientId || !UUID_RE.test(clientId)) return oauthError("invalid_client", "Unknown client_id.", 401);
  // RFC 7009 2.2: the answer never says whether the token was known.
  if (REFRESH_TOKEN_RE.test(token) || ACCESS_TOKEN_RE.test(token)) {
    const { error } = await deps.rpc("oauth_revoke_token", { p_token_hash: await hashSecret(token), p_client_id: clientId });
    if (error) return dbDown();
  }
  return oauthJson({});
}
