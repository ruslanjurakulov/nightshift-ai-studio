/**
 * The media library (migration 0038) — the pure, client-safe half.
 *
 * The database decides who may upload, how much, and of what type
 * (request_upload); the worker decides what a file really is
 * (modules/media_library.py sniffs the content and ffprobes it). This file
 * only shapes rows for the page, maps the database's refusals to words, and
 * validates ids before they get anywhere near a path.
 * Unit-tested in tests/media.test.ts.
 */

export type MediaKind = "image" | "video" | "audio" | "caption";
export type MediaVariant = "original" | "thumb" | "proxy" | "display";
export const MEDIA_VARIANTS: readonly MediaVariant[] = ["original", "thumb", "proxy", "display"];

/** 0044's media_mime_kind (0038's plus HEIC / HEIF), verbatim (tests pin them equal to the latest SQL). */
export const ALLOWED_MIME: Readonly<Record<string, MediaKind>> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/gif": "image",
  "image/heic": "image",
  "image/heif": "image",
  "video/mp4": "video",
  "video/quicktime": "video",
  "video/webm": "video",
  "video/x-matroska": "video",
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/wav": "audio",
  "audio/ogg": "audio",
  "audio/flac": "audio",
  "audio/aac": "audio",
  "audio/webm": "audio",
  "text/vtt": "caption",
  "application/x-subrip": "caption",
};

/**
 * What the file picker offers (the database and the worker still check). HEIC /
 * HEIF are listed by extension AND by type on purpose: iOS Safari converts a
 * HEIC to a JPEG in the picker unless the accept list names HEIC itself, and
 * the original is what the library should keep.
 */
export const UPLOAD_ACCEPT =
  ".jpg,.jpeg,.png,.webp,.gif,.heic,.heif,image/heic,image/heif,.mp4,.m4v,.mov,.webm,.mkv,.mp3,.m4a,.wav,.ogg,.oga,.flac,.aac,.vtt,.srt";

/** iPhone photos: kept untouched; the worker makes JPEG `thumb` and `display` copies
 *  because most browsers cannot show the original. */
export function isHeifMime(mime: unknown): boolean {
  return mime === "image/heic" || mime === "image/heif";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A canonical lower-case uuid, or null. Nothing else ever reaches a path. */
export function parseMediaId(raw: unknown): string | null {
  return typeof raw === "string" && UUID_RE.test(raw) ? raw : null;
}

export function isVariant(raw: unknown): raw is MediaVariant {
  return raw === "original" || raw === "thumb" || raw === "proxy" || raw === "display";
}

/** The Content-Type a variant is served with; null when the type is not allowed. */
export function variantContentType(variant: MediaVariant, mime: string): string | null {
  if (variant === "thumb" || variant === "display") return "image/jpeg";
  if (variant === "proxy") return "video/mp4";
  if (!(mime in ALLOWED_MIME)) return null;
  // <track> needs text/vtt; an .srt is offered as plain text, never rendered.
  if (mime === "application/x-subrip") return "text/plain; charset=utf-8";
  if (mime === "text/vtt") return "text/vtt; charset=utf-8";
  return mime;
}

/** A display name for the browser, with NUL and control characters dropped
 *  (PostgREST refuses NUL in text, and the database keeps only a label). */
export function cleanUploadName(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const last = s.split(/[\\/]/).pop() ?? "";
  const clean = last.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^[.\s]+/, "").trim().slice(0, 200);
  return clean || "upload";
}

// ── rows ────────────────────────────────────────────────────────────────────

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationS: number | null;
  source: "generated" | "upload" | "render" | "pipeline";
  name: string | null;
  variants: MediaVariant[];
  version: number;
  createdAt: string | null;
}

export const MEDIA_ASSET_COLUMNS =
  "id, kind, mime, bytes, width, height, duration_s, source, original_name, variants, version, created_at";

export type UploadStatus = "requested" | "receiving" | "uploaded" | "ingesting" | "ingested" | "rejected" | "expired";
const UPLOAD_STATUSES: UploadStatus[] = [
  "requested",
  "receiving",
  "uploaded",
  "ingesting",
  "ingested",
  "rejected",
  "expired",
];

export interface MediaUpload {
  id: string;
  name: string;
  status: UploadStatus;
  reason: string | null;
  bytes: number;
  assetId: string | null;
  createdAt: string | null;
}

export const MEDIA_UPLOAD_COLUMNS = "id, original_name, status, reason, declared_bytes, received_bytes, asset_id, created_at";

function num(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

const KINDS: MediaKind[] = ["image", "video", "audio", "caption"];
const SOURCES: MediaAsset["source"][] = ["generated", "upload", "render", "pipeline"];

export function coerceAssets(data: unknown): MediaAsset[] {
  if (!Array.isArray(data)) return [];
  const out: MediaAsset[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = parseMediaId(r.id);
    const bytes = num(r.bytes);
    if (!id || !KINDS.includes(r.kind as MediaKind) || typeof r.mime !== "string" || bytes === null) continue;
    out.push({
      id,
      kind: r.kind as MediaKind,
      mime: r.mime,
      bytes,
      width: num(r.width),
      height: num(r.height),
      durationS: num(r.duration_s),
      source: SOURCES.includes(r.source as MediaAsset["source"]) ? (r.source as MediaAsset["source"]) : "upload",
      name: str(r.original_name),
      variants: Array.isArray(r.variants) ? (r.variants.filter(isVariant) as MediaVariant[]) : [],
      version: num(r.version) ?? 1,
      createdAt: str(r.created_at),
    });
  }
  return out;
}

export function coerceUploads(data: unknown): MediaUpload[] {
  if (!Array.isArray(data)) return [];
  const out: MediaUpload[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = parseMediaId(r.id);
    if (!id) continue;
    out.push({
      id,
      name: str(r.original_name) ?? "upload",
      status: UPLOAD_STATUSES.includes(r.status as UploadStatus) ? (r.status as UploadStatus) : "rejected",
      reason: str(r.reason),
      bytes: num(r.received_bytes) ?? num(r.declared_bytes) ?? 0,
      assetId: parseMediaId(r.asset_id),
      createdAt: str(r.created_at),
    });
  }
  return out;
}

/** Still on its way: the page keeps polling while any upload is here. */
export function isUploadInFlight(u: MediaUpload): boolean {
  return u.status === "requested" || u.status === "receiving" || u.status === "uploaded" || u.status === "ingesting";
}

export interface StorageQuota {
  usedBytes: number;
  /** null = unknown (0038 not readable), never shown as a number. */
  limitBytes: number | null;
  maxUploadBytes: number | null;
}

export interface LibraryAsset extends MediaAsset {
  /** Signed, short-lived; null when this host cannot serve it. */
  thumbUrl: string | null;
  viewUrl: string | null;
}

/** What GET /api/media and the Library page start from. */
export interface MediaLibraryData {
  /** 0038 applied and readable. */
  available: boolean;
  /** This host has the media volumes and a signing key. */
  host: { media: boolean; staging: boolean; signing: boolean };
  assets: LibraryAsset[];
  uploads: MediaUpload[];
  quota: StorageQuota;
  error?: "read_failed";
}

// ── errors ──────────────────────────────────────────────────────────────────

export type MediaError =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "unsupported_type"
  | "extension_mismatch"
  | "too_large"
  | "too_many_uploads"
  | "quota_exceeded"
  | "server_full"
  | "bad_request"
  | "not_available"
  | "failed";

/** A refusal from 0038's functions -> a word and an HTTP status. */
export function mapMediaError(error: { code?: string; message?: string; details?: string } | null | undefined): {
  error: MediaError;
  status: number;
} {
  switch (error?.code) {
    case "NS415":
      return {
        error: /extension_mismatch/.test(error.details ?? "") ? "extension_mismatch" : "unsupported_type",
        status: 415,
      };
    case "NS413":
      return { error: "too_large", status: 413 };
    case "NS429":
      return { error: "too_many_uploads", status: 429 };
    case "NS507":
      return { error: /server_full/.test(error.details ?? "") ? "server_full" : "quota_exceeded", status: 507 };
    case "42501":
      return { error: "forbidden", status: 403 };
    case "P0002":
      return { error: "not_found", status: 404 };
    case "22023":
      return { error: "bad_request", status: 400 };
    case "PGRST202":
    case "42883":
    case "42P01":
      return { error: "not_available", status: 503 };
  }
  if (/could not find the function|does not exist/i.test(error?.message ?? "")) return { error: "not_available", status: 503 };
  return { error: "failed", status: 502 };
}

/** "used=… pending=… limit=… requested=…" (NS507's detail) -> numbers. */
export function parseQuotaDetail(detail: unknown): { used: number; pending: number; limit: number; requested: number } | null {
  if (typeof detail !== "string") return null;
  const get = (k: string) => {
    const m = new RegExp(`${k}=(\\d+)`).exec(detail);
    return m ? Number(m[1]) : null;
  };
  const used = get("used");
  const pending = get("pending");
  const limit = get("limit");
  const requested = get("requested");
  if (used === null || pending === null || limit === null || requested === null) return null;
  return { used, pending, limit, requested };
}

/** "max=…" (NS413's detail). */
export function parseMaxDetail(detail: unknown): number | null {
  if (typeof detail !== "string") return null;
  const m = /max=(\d+)/.exec(detail);
  return m ? Number(m[1]) : null;
}

/** Reason words the database, the route and the worker write. Anything else
 *  reads as a plain failure. */
export const UPLOAD_REASONS = [
  "unsupported_type",
  "type_mismatch",
  "extension_mismatch",
  "not_media",
  "no_video_stream",
  "no_audio_stream",
  "too_large",
  "too_large_dimensions",
  "too_long",
  "empty",
  "decode_failed",
  "heic_unavailable",
  "probe_failed",
  "file_missing",
  "timeout",
  "client_aborted",
  "write_failed",
  "staging_unavailable",
  "upload_window_passed",
  "upload_interrupted",
  "not_picked_up",
  "interrupted",
  "worker_error",
] as const;
export type UploadReason = (typeof UPLOAD_REASONS)[number];

export function knownUploadReason(raw: string | null): UploadReason | null {
  return raw && (UPLOAD_REASONS as readonly string[]).includes(raw) ? (raw as UploadReason) : null;
}

/** "1.2 GB", "340 MB", "12 KB" — sizes in the library. */
export function formatMediaBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 0) return "";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 10 * 1024 ** 2 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** "1:05" / "1:02:03" */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !(seconds > 0)) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}
