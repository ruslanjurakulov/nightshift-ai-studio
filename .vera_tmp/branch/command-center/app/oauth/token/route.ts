import { oauthDeps } from "@/lib/server/oauth";
import { tokenEndpoint } from "@/lib/oauth/endpoints";
import { oauthError, preflight } from "@/lib/oauth/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /oauth/token — authorization_code (PKCE S256) and refresh_token
 * (rotating, with reuse detection) for public clients (migration 0093).
 * No session, no cookie: the code or refresh token in the body is the
 * credential, checked by the database, which stores only hashes. Never cached.
 */
export async function POST(request: Request): Promise<Response> {
  return tokenEndpoint(request, oauthDeps());
}

export const OPTIONS = preflight;
export const GET = () => oauthError("invalid_request", "Use POST.", 405, { allow: "POST, OPTIONS" });
