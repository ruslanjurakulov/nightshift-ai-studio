import { readJson, runApi } from "@/lib/server/public-api";
import { publishVideo } from "@/lib/api/operations";
import { apiError } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/videos/{id}/publish — "Publish to platforms" → Send: one
 * request per target, through the same database checks as the site (publish
 * gate, approvals, same organization, connected account). A YouTube target is
 * always uploaded private. Free. Supports Idempotency-Key.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runApi(request, async (caller) => {
    const body = await readJson(request);
    if (!body.ok) return apiError(400, "invalid_body", "Send a JSON object (at most 64 KB).");
    return publishVideo(caller, id, body.body, request.headers.get("idempotency-key"));
  });
}
