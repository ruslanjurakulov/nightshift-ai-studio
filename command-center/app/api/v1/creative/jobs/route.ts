import { readJson, runApi } from "@/lib/server/public-api";
import { createCreative } from "@/lib/api/operations";
import { apiError } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/creative/jobs — start a generation: the Studio's own start, on
 * the organization's credits. Needs the creative:create scope, an
 * Idempotency-Key header and max_credits in the body (both required).
 */
export function POST(request: Request) {
  return runApi(request, async (caller) => {
    const body = await readJson(request);
    if (!body.ok) return apiError(400, "invalid_body", "Send a JSON object (at most 64 KB).");
    return createCreative(caller, body.body, request.headers.get("idempotency-key"));
  });
}
