/**
 * MCP over OAuth (migration 0093): the one place the URLs, scopes and limits
 * of the authorization server are written down. Pure, so route handlers, the
 * consent page and the tests agree.
 *
 * Spec implemented: the MCP authorization specification, version 2026-07-28
 * (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
 * — OAuth 2.1 (draft-ietf-oauth-v2-1-13) with PKCE S256, RFC 9728 protected
 * resource metadata, RFC 8414 authorization server metadata, RFC 7591 dynamic
 * client registration (public clients), RFC 8707 resource indicators, RFC 7009
 * revocation and RFC 9207 issuer identification. Client ID Metadata Documents
 * are NOT implemented (fetching a client-supplied URL needs SSRF-safe fetching
 * that this deployment does not have); the metadata says so.
 */

import { docsOrigin } from "@/lib/api/docs-origin";

/** The MCP server's path: the resource a token is issued for. */
export const MCP_RESOURCE_PATH = "/api/mcp";

/** What a connection may be given; the database holds the same list (0093). */
export const OAUTH_SCOPES = ["videos:read", "videos:create", "videos:publish"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const ACCESS_TOKEN_TTL_SECONDS = 3600;

/** The origin this deployment is served at: APP_ORIGIN, else the production
 *  domain — server-side env, never the request's Host header (a forged Host
 *  must not be able to write its own address into our metadata). */
export function oauthOrigin(): string {
  return docsOrigin();
}

export function resourceUrl(origin: string = oauthOrigin()): string {
  return origin + MCP_RESOURCE_PATH;
}

export interface OAuthEndpoints {
  issuer: string;
  resource: string;
  authorization: string;
  token: string;
  registration: string;
  revocation: string;
  /** The protected-resource metadata URL a 401 points to (RFC 9728 5.1). */
  resourceMetadata: string;
}

export function oauthEndpoints(origin: string = oauthOrigin()): OAuthEndpoints {
  return {
    issuer: origin,
    resource: resourceUrl(origin),
    authorization: `${origin}/oauth/authorize`,
    token: `${origin}/oauth/token`,
    registration: `${origin}/oauth/register`,
    revocation: `${origin}/oauth/revoke`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`,
  };
}

/** The exact well-known names this server answers (and nothing else under /.well-known). */
export const WELL_KNOWN_PATHS = [
  "/.well-known/oauth-protected-resource",
  `/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`,
  "/.well-known/oauth-authorization-server",
  `/.well-known/oauth-authorization-server${MCP_RESOURCE_PATH}`,
  "/.well-known/openid-configuration",
  `/.well-known/openid-configuration${MCP_RESOURCE_PATH}`,
] as const;

/** The unauthenticated OAuth endpoints (the server-to-server ones). The
 *  authorize page and the decision endpoint need a signed-in session and are
 *  NOT here. */
export const OAUTH_PUBLIC_PATHS = ["/oauth/register", "/oauth/token", "/oauth/revoke"] as const;

/** RFC 9728 protected resource metadata for the MCP server. */
export function protectedResourceMetadata(origin: string = oauthOrigin()) {
  const e = oauthEndpoints(origin);
  return {
    resource: e.resource,
    authorization_servers: [e.issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Nightshift MCP server",
    resource_documentation: `${origin}/docs/api#mcp`,
  };
}

/** RFC 8414 authorization server metadata (also served at the OpenID
 *  discovery names, which MCP clients probe too; this is not an OpenID
 *  provider and says so by offering no id_token). */
export function authorizationServerMetadata(origin: string = oauthOrigin()) {
  const e = oauthEndpoints(origin);
  return {
    issuer: e.issuer,
    authorization_endpoint: e.authorization,
    token_endpoint: e.token,
    registration_endpoint: e.registration,
    revocation_endpoint: e.revocation,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
    service_documentation: `${origin}/docs/api#mcp`,
  };
}
