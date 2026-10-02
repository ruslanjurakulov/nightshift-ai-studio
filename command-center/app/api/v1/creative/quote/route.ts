import { readJson, runApi } from "@/lib/server/public-api";
import { quoteCreative } from "@/lib/api/operations";
import { apiError } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/creative/quote — what one generation costs, in credits.
 * Needs the creative:quote scope. Nothing is held or charged.
 */
export function POST(request: Request) {
  return runApi(request, async (caller) => {
    const body = await readJson(request);
    if (!body.ok) return apiError(400, "invalid_body", "Send a JSON object (at most 64 KB).");
    return quoteCreative(caller, body.body);
  });
}
