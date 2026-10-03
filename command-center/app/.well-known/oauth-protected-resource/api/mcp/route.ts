import { protectedResourceMetadata } from "@/lib/oauth/config";
import { metadataJson, preflight } from "@/lib/oauth/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /.well-known/oauth-protected-resource/api/mcp — MCP authorization discovery (migration 0093; see
 * lib/oauth/config.ts for the spec). Public, static JSON built from this
 * deployment's configured origin, never the request's Host header. Served at
 * exactly the names MCP clients probe (the bare name and the one with the MCP
 * path inserted); nothing else under /.well-known exists.
 */
export const GET = () => metadataJson(protectedResourceMetadata());
export const OPTIONS = preflight;
