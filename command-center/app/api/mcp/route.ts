import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { apiCaller, isCaller } from "@/lib/server/public-api";
import { buildMcpServer } from "@/lib/api/mcp";
import { getMe } from "@/lib/api/operations";
import { apiError, newRequestId, toResponse } from "@/lib/api/http";
import { MCP_METHODS, needsKeyCheck } from "@/lib/api/mcp-http";

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
  const caller = await apiCaller(request, requestId);
  if (!isCaller(caller)) return toResponse(caller, requestId);

  let parsedBody: unknown = undefined;
  if (request.method === "POST") {
    const text = await request.text();
    if (text.length > 256_000) return toResponse(apiError(413, "invalid_body", "Request too large."), requestId);
    try {
      parsedBody = JSON.parse(text);
    } catch {
      return toResponse(apiError(400, "invalid_body", "Send a JSON-RPC message."), requestId);
    }
    if (needsKeyCheck(parsedBody)) {
      const me = await getMe(caller);
      if (!me.ok) return toResponse(me, requestId);
    }
  }

  try {
    const server = buildMcpServer(caller);
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
