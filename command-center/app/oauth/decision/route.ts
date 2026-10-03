import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { decideAuthorization, oauthDeps } from "@/lib/server/oauth";
import { redirectWith } from "@/lib/oauth/authorize";
import { REQUEST_SECRET_RE, hashSecret, newAuthorizationCode } from "@/lib/oauth/tokens";
import { boundedText } from "@/lib/oauth/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * POST /oauth/decision — the person's Allow or Deny (migration 0093).
 *
 * Forging this from another site fails four independent ways: the request must
 * carry our own Origin (a cross-site page cannot set it), Sec-Fetch-Site must
 * not say otherwise, the body must be JSON (a cross-site form cannot send
 * that), and the single-use 256-bit secret in it exists only in the page the
 * server rendered for THIS signed-in person — the database row it names is
 * deleted when used and belongs to one user. The session cookie alone is not
 * enough, and the secret alone is not enough.
 *
 * Everything the app asked for (client, redirect address, scopes, PKCE
 * challenge, state) is in that row; none of it is read from this request.
 * The answer is the registered redirect URI with the code (or the denial) on
 * it; the page navigates there.
 */
export async function POST(request: Request): Promise<Response> {
  const deps = oauthDeps();
  const origin = request.headers.get("origin");
  const here = new URL(request.url).origin;
  if (!origin || (origin !== deps.origin && origin !== here)) return json({ error: "forbidden" }, 403);
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return json({ error: "forbidden" }, 403);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
    return json({ error: "bad_request" }, 415);

  const user = await getUser();
  if (!user) return json({ error: "signed_out" }, 401);

  const text = await boundedText(request, 2048);
  let body: { request?: unknown; decision?: unknown; limit?: unknown } = {};
  try {
    body = text === null ? {} : JSON.parse(text);
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (typeof body.request !== "string" || !REQUEST_SECRET_RE.test(body.request) || (body.decision !== "allow" && body.decision !== "deny"))
    return json({ error: "expired" }, 400);
  const allow = body.decision === "allow";
  const limit = typeof body.limit === "number" && Number.isFinite(body.limit) ? body.limit : null;

  const code = newAuthorizationCode();
  const result = await decideAuthorization({
    secretHash: await hashSecret(body.request),
    allow,
    limit,
    codeHash: await hashSecret(code),
  });
  if (result === "unavailable") return json({ error: "unavailable" }, 503);
  if (!result.ok) {
    const status = result.error === "expired" || result.error === "invalid_limit" ? 400 : 403;
    return json({ error: result.error }, status);
  }
  const redirect = result.allowed
    ? redirectWith(result.redirectUri, { code, state: result.state }, deps.origin)
    : redirectWith(result.redirectUri, { error: "access_denied", error_description: "The person denied the request.", state: result.state }, deps.origin);
  return json({ redirect }, 200);
}
