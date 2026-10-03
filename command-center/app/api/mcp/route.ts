import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { apiCaller, isCaller, oauthApiCaller, oauthCheck } from "@/lib/server/public-api";
import { buildMcpServer } from "@/lib/api/mcp";
import { getMe, type ApiCaller } from "@/lib/api/operations";
import { hashApiKey } from "@/lib/api/keys";
import { apiError, fromRpcResult, newRequestId, toResponse, type ApiResult } from "@/lib/api/http";
import { MCP_METHODS, needsKeyCheck, wwwAuthenticate } from "@/lib/api/mcp-http";
import { OAUTH_SCOPES, oauthEndpoints, oauthOrigin } from "@/lib/oauth/config";
import { classifyBearer } from "@/lib/oauth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The MCP endpoint: Streamable HTTP, stateless (a fresh server and transport
 * per request, JSON responses, no session). Authenticated with the same
 * `Authorization: Bearer nsk_live_…` key as /api/v1.
 *
 * Every tool call is one API request (the tool calls the REST operation,
 * which the database counts and limits). Any other POST — initialize,
 * tools/list, a notification, a client response — is checked and counted once
 * through api_auth, so a revoked key, an unactivated organization or a spent
 * rate limit is refused before the transport answers anything. GET and DELETE
 * (standalone stream, session end) do not exist on a stateless server and are
 * refused with 405 (lib/api/mcp-http.ts).
 */
async function handle(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const bearer = classifyBearer(request.headers.get("authorization"));
  if (bearer.kind === "oauth") return handleOauth(request, requestId, bearer.token);
  const caller = await apiCaller(request, requestId);
  if (!isCaller(caller)) {
    const res = toResponse(caller, requestId);
    // No credential, or one that is not a Nightshift key or token: tell the
    // client where to get one (the MCP authorization spec). A malformed or
    // revoked API key keeps exactly the answer it always had.
    if (bearer.kind !== "api_key") res.headers.set("www-authenticate", challenge());
    return res;
  }
  return serve(request, requestId, caller);
}

/** The 401 challenge: where this server's authorization lives and what to ask for. */
function challenge(invalidToken = false): string {
  return wwwAuthenticate(oauthEndpoints(oauthOrigin()).resourceMetadata, OAUTH_SCOPES, invalidToken);
}

/**
 * An AI app's access token (migration 0093). oauth_check answers whether it is
 * a live token of a live connection, for which resource and with which
 * permissions; a token for any other resource is refused here (RFC 8707), a
 * dead one is a 401 that points at the refresh token. A paused plan is not an
 * invalid token: the handshake works and every tool call says the plan is
 * needed (the database decides that on each call). Nothing is read from the
 * token but its hash.
 */
async function handleOauth(request: Request, requestId: string, token: string): Promise<Response> {
  const unauthorized = (): Response => {
    const res = toResponse(apiError(401, "invalid_token", "The access token is missing, expired, revoked or not for this server."), requestId);
    res.headers.set("www-authenticate", challenge(true));
    return res;
  };
  if (request.method !== "POST") return methodNotAllowed();
  const hash = await hashApiKey(token);
  const { data, error } = await oauthCheck(hash, requestId);
  if (error) return toResponse(apiError(503, "api_unavailable", "The authorization service is not available right now."), requestId);
  const check = fromRpcResult(data);
  if (!check.ok) return check.status === 429 ? toResponse(check, requestId) : unauthorized();
  const info = (check.data ?? {}) as { resource?: unknown; scopes?: unknown };
  const origin = oauthOrigin();
  if (info.resource !== oauthEndpoints(origin).resource) return unauthorized();
  const scopes = Array.isArray(info.scopes) ? info.scopes.filter((s): s is string => typeof s === "string") : [];
  return serve(request, requestId, oauthApiCaller(hash, requestId), { scopes, origin });
}

async function serve(request: Request, requestId: string, caller: ApiCaller, oauth?: { scopes: string[]; origin: string }): Promise<Response> {
  let parsedBody: unknown = undefined;
  if (request.method === "POST") {
    const text = await request.text();
    if (text.length > 256_000) return toResponse(apiError(413, "invalid_body", "Request too large."), requestId);
    try {
      parsedBody = JSON.parse(text);
    } catch {
      return toResponse(apiError(400, "invalid_body", "Send a JSON-RPC message."), requestId);
    }
    // An OAuth caller was checked (and counted) by oauth_check above.
    if (!oauth && needsKeyCheck(parsedBody)) {
      const me: ApiResult = await getMe(caller);
      if (!me.ok) return toResponse(me, requestId);
    }
  }

  try {
    const server = buildMcpServer(caller, oauth);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(request, parsedBody === undefined ? undefined : { parsedBody });
    const headers = new Headers(res.headers);
    headers.set("x-request-id", requestId);
    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    console.error(`[mcp] ${requestId} 500 ${e instanceof Error ? e.name : "error"}`);
    return toResponse(apiError(500, "internal_error", "The MCP endpoint could not complete this request."), requestId);
  }
}

/** 405 in the API's envelope, with the method that does work here. */
function methodNotAllowed(): Response {
  const requestId = newRequestId();
  const res = toResponse(
    apiError(405, "method_not_allowed", "The MCP endpoint is stateless: send JSON-RPC messages with POST."),
    requestId,
  );
  res.headers.set("allow", MCP_METHODS.join(", "));
  return res;
}

export const POST = handle;
export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
