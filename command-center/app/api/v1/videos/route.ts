import { readJson, runApi } from "@/lib/server/public-api";
import { createVideo, listVideos } from "@/lib/api/operations";
import { apiError } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/videos — make a video: the site's "Run now" on the render
 * queue, paid from the API balance (held now, charged when the job
 * succeeds, released if it fails). Supports Idempotency-Key.
 */
export function POST(request: Request) {
  return runApi(request, async (caller) => {
    const body = await readJson(request);
    if (!body.ok) return apiError(400, "invalid_body", "Send a JSON object (at most 64 KB).");
    return createVideo(caller, body.body, request.headers.get("idempotency-key"));
  });
}

/** GET /api/v1/videos?channel_id=&limit=&offset= — the organization's videos, newest first. */
export function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  return runApi(request, (caller) =>
    listVideos(caller, { channel_id: q.get("channel_id"), limit: q.get("limit"), offset: q.get("offset") }),
  );
}
