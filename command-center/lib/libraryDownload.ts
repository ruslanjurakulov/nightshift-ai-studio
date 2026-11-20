/**
 * One stable address per file of a library asset (stream S2), the pure half:
 * client-safe and unit-tested (tests/library-download.test.ts).
 *
 *   GET /api/library/{asset}/download?variant=original|preview|captions
 *
 * The original and the preview are two different addresses on purpose: a
 * saved export once showed only its 480p proxy and nothing else, and someone
 * who pressed "Download" got the review copy and took it for the master. The
 * address holds no secret and never expires. Each press re-reads the asset
 * under the caller's session, so a page left open for an hour still works.
 */
import { parseMediaId, type MediaAsset, type MediaVariant } from "@/lib/media";

export type LibraryDownloadVariant = "original" | "preview" | "captions";
export const LIBRARY_DOWNLOAD_VARIANTS: readonly LibraryDownloadVariant[] = ["original", "preview", "captions"];

export function parseDownloadVariant(raw: unknown): LibraryDownloadVariant | null {
  return typeof raw === "string" && (LIBRARY_DOWNLOAD_VARIANTS as readonly string[]).includes(raw)
    ? (raw as LibraryDownloadVariant)
    : null;
}

/** The address of one file of an asset; null for anything that is not a canonical asset id. */
export function libraryDownloadUrl(assetId: string, variant: LibraryDownloadVariant): string | null {
  const id = parseMediaId(assetId);
  return id ? `/api/library/${id}/download?variant=${variant}` : null;
}

/**
 * Which stored file a preview is. A video's preview is its 480p proxy and an
 * image's is its display JPEG. An audio file is its own preview (it has no
 * proxy, and playing the original is what the library already does). Null
 * means there is no preview: the original is never handed out under the
 * preview's name, or the two buttons would quietly be the same file.
 */
export function previewVariantFor(asset: Pick<MediaAsset, "kind" | "variants">): MediaVariant | null {
  if (asset.kind === "video") return asset.variants.includes("proxy") ? "proxy" : null;
  if (asset.kind === "image") return asset.variants.includes("display") ? "display" : null;
  if (asset.kind === "audio") return "original";
  return null;
}

const EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/webm": "weba",
  "text/vtt": "vtt",
  "application/x-subrip": "srt",
};

/**
 * The saved file's name: the asset's name without its extension, the frame
 * size when it is known (so "1920x1080" on disk says which file this is), and
 * the extension of the type it really is.
 */
export function downloadFileName(
  asset: Pick<MediaAsset, "name" | "mime" | "width" | "height" | "id">,
  ext?: string,
): string {
  const stem = (asset.name ?? "")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const size = asset.width && asset.height ? ` ${asset.width}x${asset.height}` : "";
  const e = ext ?? EXT[asset.mime] ?? "bin";
  return `${stem || asset.id.slice(0, 8)}${size}.${e}`;
}

/** Content-Disposition attachment: an ASCII fallback plus the UTF-8 name (RFC 6266 / 5987). */
export function attachmentDisposition(name: string): string {
  const ascii =
    name
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/["\\%;]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "download";
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** The cues of an export's captions as it was asked for (editor_exports.doc.captions); [] when there are none. */
export function exportCues(captions: unknown): { id: string; start_s: number; end_s: number; text: string }[] {
  if (!captions || typeof captions !== "object") return [];
  const cues = (captions as { cues?: unknown }).cues;
  if (!Array.isArray(cues)) return [];
  const out: { id: string; start_s: number; end_s: number; text: string }[] = [];
  for (const c of cues) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    if (typeof r.text !== "string" || typeof r.start_s !== "number" || typeof r.end_s !== "number") continue;
    if (!Number.isFinite(r.start_s) || !Number.isFinite(r.end_s) || r.end_s <= r.start_s) continue;
    out.push({ id: String(r.id ?? out.length), start_s: r.start_s, end_s: r.end_s, text: r.text });
  }
  return out;
}

/** The words the panel can say about a refused download; anything else is "failed" (and can be tried again). */
export type DownloadRefusal = "unauthorized" | "not_found" | "gone" | "media_unavailable" | "no_captions" | "no_preview" | "failed";

export function downloadRefusal(status: number, error: unknown): DownloadRefusal {
  if (status === 401) return "unauthorized";
  const known: readonly DownloadRefusal[] = ["not_found", "gone", "media_unavailable", "no_captions", "no_preview"];
  if (typeof error === "string" && (known as readonly string[]).includes(error)) return error as DownloadRefusal;
  if (status === 404) return "not_found";
  if (status === 410) return "gone";
  return "failed";
}

/** Only a refusal that asking again could fix offers "Try again". */
export function canRetryDownload(r: DownloadRefusal): boolean {
  return r === "failed";
}
