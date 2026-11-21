import { oauthDeps } from "@/lib/server/oauth";
import { registerEndpoint } from "@/lib/oauth/endpoints";
import { oauthError, preflight } from "@/lib/oauth/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /oauth/register — RFC 7591 dynamic client registration, public clients
 * only (migration 0093). Unauthenticated by design and therefore treated as
 * hostile: bounded body, redirect URIs validated twice (here and in the
 * database), per-address and global rate limits and row caps in the database,
 * and registrations nobody ever authorizes are deleted after a day.
 */
export async function POST(request: Request): Promise<Response> {
  return registerEndpoint(request, oauthDeps());
}

export const OPTIONS = preflight;
export const GET = () => oauthError("invalid_request", "Register with POST.", 405, { allow: "POST, OPTIONS" });
