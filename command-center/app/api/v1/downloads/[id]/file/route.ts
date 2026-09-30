import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { apiCaller, isCaller } from "@/lib/server/public-api";
import { downloadsDir } from "@/lib/server/downloads";
import { getDownload } from "@/lib/api/operations";
import { apiError, newRequestId, toResponse } from "@/lib/api/http";
import { contentDisposition, downloadFilePath, parseDownloadId, type HdQuality } from "@/lib/downloads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/downloads/{id}/file — stream a ready HD download, exactly as
 * /api/downloads/{id} does for the site: the file is found by the numeric id
 * alone on the worker's volume; the row (read through the key, 0031) must be
 * in the key's organization, ready and not expired.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  const caller = await apiCaller(request, requestId);
  if (!isCaller(caller)) return toResponse(caller, requestId);
  const { id: raw } = await params;
  const dir = downloadsDir();
  if (!dir)
    return toResponse(apiError(503, "downloads_unavailable", "This host has no downloads volume."), requestId);
  const id = parseDownloadId(raw);
  const file = downloadFilePath(dir, id);
  if (id === null || !file) return toResponse(apiError(404, "download_not_found", "No such download."), requestId);

  const result = await getDownload(caller, String(id));
  if (!result.ok) return toResponse(result, requestId);
  const d = result.data as { status?: string; video_id?: string; quality?: HdQuality };
  if (d.status === "expired") return toResponse(apiError(410, "download_expired", "This download has expired; request it again (free for 7 days)."), requestId);
  if (d.status !== "ready" || !d.video_id || !d.quality)
    return toResponse(apiError(409, "download_not_ready", `The download is ${d.status ?? "not ready"}.`), requestId);

  let size: number;
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    size = s.size;
  } catch {
    return toResponse(apiError(410, "download_file_missing", "The file is gone; request the download again."), requestId);
  }
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
      "Content-Disposition": contentDisposition(null, d.video_id, d.quality),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "x-request-id": requestId,
    },
  });
}
