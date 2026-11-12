/**
 * Answers of the OAuth endpoints: JSON that is never cached, the error shape of
 * RFC 6749 5.2, and CORS for the server-to-server endpoints a browser-based
 * MCP client may call. No cookie is ever read or set here, so the wildcard
 * origin exposes nothing a caller could not already fetch with curl.
 */

import { clientAddressKey } from "@/lib/geo/client-ip";

export const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
  "access-control-max-age": "600",
} as const;

export function oauthJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...CORS, ...extra } });
}

export function oauthError(error: string, description: string, status = 400, extra: Record<string, string> = {}): Response {
  return oauthJson({ error, error_description: description }, status, extra);
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS } });
}

/** Metadata documents may be cached briefly; they carry nothing private. */
export function metadataJson(body: unknown): Response {
  return Response.json(body, {
    headers: { ...CORS, "cache-control": "public, max-age=300" },
  });
}

/** The client's address for a per-address limit: the one header our own proxy writes on every request
 *  (lib/geo/client-ip.ts, ledger BR-L-192). cf-connecting-ip and x-forwarded-for are not read: a client can
 *  send either. No address ("unknown") shares one bucket; the global caps in the database are the backstop. */
export function clientIp(request: Request): string {
  return clientAddressKey(request.headers).slice(0, 64);
}

/** A request body of at most `max` bytes, or null. */
export async function boundedText(request: Request, max = 8192): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return null;
  const text = await request.text();
  return text.length > max ? null : text;
}
