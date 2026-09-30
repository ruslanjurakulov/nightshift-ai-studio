import { readJson, runApi } from "@/lib/server/public-api";
import { requestDownload } from "@/lib/api/operations";
import { apiError } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/videos/{id}/downloads {quality: "720p" | "1080p"} — the site's
 * paid HD download (migration 0030), paid from the API balance: the site's
 * credit price x 1.5 cents, held now, charged when the file is ready.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runApi(request, async (caller) => {
    const body = await readJson(request);
    if (!body.ok) return apiError(400, "invalid_body", "Send a JSON object (at most 64 KB).");
    return requestDownload(caller, id, body.body, request.headers.get("idempotency-key"));
  });
}
