import { oauthDeps } from "@/lib/server/oauth";
import { revokeEndpoint } from "@/lib/oauth/endpoints";
import { oauthError, preflight } from "@/lib/oauth/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /oauth/revoke — RFC 7009. Revoking either token ends the whole connection. */
export async function POST(request: Request): Promise<Response> {
  return revokeEndpoint(request, oauthDeps());
}

export const OPTIONS = preflight;
export const GET = () => oauthError("invalid_request", "Use POST.", 405, { allow: "POST, OPTIONS" });
