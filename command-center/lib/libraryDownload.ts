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
import { buildSrt, type Cue } from "@/lib/captions";
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
 * Which stored file a preview is: a video's 480p proxy, an image's display
 * JPEG. Null means there is no separate preview (audio, captions, a picture
 * without a display copy): the original is never handed out under the
 * preview's name, or the two buttons would quietly be the same file.
 */
export function previewVariantFor(asset: Pick<MediaAsset, "kind" | "variants">): MediaVariant | null {
  if (asset.kind === "video") return asset.variants.includes("proxy") ? "proxy" : null;
  if (asset.kind === "image") return asset.variants.includes("display") ? "display" : null;
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
    // Bidi overrides and other format characters too: "invoice\u202efdp.exe" would show a colleague a spoofed name.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff"\\/:*?<>|]+/g, " ")
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
export type DownloadRefusal =
  | "unauthorized"
  | "not_found"
  | "gone"
  | "media_unavailable"
  | "no_captions"
  | "no_preview"
  | "server"
  | "failed";

export function downloadRefusal(status: number, error: unknown): DownloadRefusal {
  if (status === 401) return "unauthorized";
  const known: readonly DownloadRefusal[] = ["not_found", "gone", "media_unavailable", "no_captions", "no_preview"];
  if (typeof error === "string" && (known as readonly string[]).includes(error)) return error as DownloadRefusal;
  if (status === 404) return "not_found";
  if (status === 410) return "gone";
  // The server answered and could not: not the reader's connection, so the sentence must not blame it (rule 6).
  if (status >= 500) return "server";
  return "failed";
}

/** Only a refusal that asking again could fix offers "Try again". */
export function canRetryDownload(r: DownloadRefusal): boolean {
  return r === "failed" || r === "server";
}

// ── a film master's captions file (S4 G3) ──────────────────────────────────

/** The most a captions file may be (modules/media_library.py CAPTION_MAX_BYTES); a bigger one is not read. */
export const CAPTIONS_FILE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The id of the captions file a film master names in its provenance, or null.
 *
 * A film master has no editor export: film_assembly stores its captions as a
 * library file of their own and writes that file's id into the master's
 * provenance (`captions_asset_id`). Only a canonical uuid comes out of here, so
 * nothing else ever reaches a path ("../../etc/passwd" is simply no captions).
 */
export function filmCaptionsPointer(provenance: unknown): string | null {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return null;
  return parseMediaId((provenance as Record<string, unknown>).captions_asset_id);
}

/**
 * Whether a captions row really is this master's captions file. The pointer is
 * data, so it is trusted only as far as the row it names agrees with it: a
 * caption in WebVTT, the master's own workspace, the same film segment and the
 * same cut, written as the film's captions. Otherwise a master's provenance
 * could hand out another film's (or, were RLS ever wrong, another workspace's)
 * subtitles under this film's name.
 */
export function isFilmCaptionsOf(
  master: { org_id: unknown; provenance: unknown },
  captions: { org_id: unknown; kind: unknown; mime: unknown; provenance: unknown },
): boolean {
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const mp = obj(master.provenance);
  const cp = obj(captions.provenance);
  if (!mp || !cp) return false;
  const seg = parseMediaId(mp.film_segment_id);
  const sha = typeof mp.cut_sha256 === "string" && /^[0-9a-f]{64}$/.test(mp.cut_sha256) ? mp.cut_sha256 : null;
  return (
    captions.kind === "caption" &&
    captions.mime === "text/vtt" &&
    typeof master.org_id === "string" &&
    master.org_id !== "" &&
    captions.org_id === master.org_id &&
    seg !== null &&
    cp.film_segment_id === seg &&
    sha !== null &&
    cp.cut_sha256 === sha &&
    cp.role === "captions"
  );
}

const VTT_TIME = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;

function vttSeconds(raw: string): number | null {
  const m = VTT_TIME.exec(raw);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** Cue markup SubRip has no use for (voice, class, language, ruby, inline timestamps); <b>, <i>, <u> are kept. */
const VTT_TAG = /<\/?(?:c|v|lang|ruby|rt)(?:\.[\w-]+)*(?:[ \t][^<>\n]*)?>|<(?:\d{2,}:)?[0-5]\d:[0-5]\d\.\d{3}>/g;

function vttText(lines: string[]): string {
  return lines
    .join("\n")
    .replace(VTT_TAG, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&lrm;|&rlm;/g, "")
    .replace(/&amp;/g, "&");
}

/**
 * WebVTT bytes as cues, or null when the file is not WebVTT this route can
 * stand behind. Null is the whole answer, never a prefix: one timing line that
 * does not parse refuses the file, because half a subtitle file saved as a
 * whole one is found out by the audience, not by us.
 */
export function vttCues(bytes: Uint8Array): Cue[] | null {
  if (bytes.byteLength === 0 || bytes.byteLength > CAPTIONS_FILE_MAX_BYTES) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (text.includes("\u0000")) return null;
  const blocks = text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/);
  // The signature: "WEBVTT" alone or followed by a space or tab (W3C WebVTT, file structure).
  const header = blocks.shift() ?? "";
  if (!/^WEBVTT(?:[ \t][^\n]*)?(?:\n|$)/.test(header)) return null;
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    while (lines.length && lines[0].trim() === "") lines.shift();
    if (lines.length === 0) continue;
    if (/^(?:NOTE|STYLE|REGION)(?:[ \t]|$)/.test(lines[0])) continue;
    // An optional identifier line, then the timing line.
    const at = lines[0].includes("-->") ? 0 : 1;
    const timing = lines[at];
    if (timing === undefined || !timing.includes("-->")) return null;
    const m = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t].*)?$/.exec(timing.trim());
    if (!m) return null;
    const start = vttSeconds(m[1]);
    const end = vttSeconds(m[2]);
    if (start === null || end === null || !(end > start)) return null;
    cues.push({ id: String(cues.length + 1), start_s: start, end_s: end, text: vttText(lines.slice(at + 1)) });
  }
  return cues.length > 0 ? cues : null;
}

/** The captions file as SubRip (numbered from 1, decimal comma), or null when it is not one this route serves. */
export function vttToSrt(bytes: Uint8Array): string | null {
  const cues = vttCues(bytes);
  if (!cues) return null;
  const srt = buildSrt(cues);
  return srt === "" ? null : srt;
}
