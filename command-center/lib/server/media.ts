import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { createClient } from "@/lib/supabase/server";
import {
  MEDIA_ASSET_COLUMNS,
  MEDIA_UPLOAD_COLUMNS,
  coerceAssets,
  coerceUploads,
  isVariant,
  parseMediaId,
  variantContentType,
  type LibraryAsset,
  type MediaAsset,
  type MediaLibraryData,
  type MediaVariant,
} from "@/lib/media";

export type { LibraryAsset, MediaLibraryData };

/**
 * The media library's server half (migration 0038): where the volumes are on
 * this host, the signed URLs, and the streamed upload writer.
 *
 * Masters live on the Hetzner server (deploy/docker-compose.yml): the worker
 * writes the `media` volume, mounted read-only here at NIGHTSHIFT_MEDIA_DIR;
 * uploads land in the `media_staging` volume at NIGHTSHIFT_MEDIA_STAGING_DIR,
 * the one directory this container may write. On a host without them (Vercel)
 * both are null and the library says so instead of pretending.
 *
 * Every path is built from a canonical uuid and a fixed file name — never
 * from a filename, a row value or anything else a caller sent.
 */

function absDir(raw: string | undefined): string | null {
  const dir = (raw ?? "").trim();
  if (!dir.startsWith("/") || dir.includes("\0") || /(^|\/)\.\.(\/|$)/.test(dir)) return null;
  try {
    return existsSync(dir) ? dir.replace(/\/+$/, "") || "/" : null;
  } catch {
    return null;
  }
}

export function mediaDir(): string | null {
  return absDir(process.env.NIGHTSHIFT_MEDIA_DIR);
}

export function mediaStagingDir(): string | null {
  return absDir(process.env.NIGHTSHIFT_MEDIA_STAGING_DIR);
}

const FILE_NAMES: Record<MediaVariant, string> = { original: "original", thumb: "thumb.jpg", proxy: "proxy.mp4" };

/** `<dir>/<aa>/<uuid>/<fixed name>` — the worker's layout (media_library.asset_file). */
export function assetFilePath(dir: string | null | undefined, id: unknown, variant: unknown): string | null {
  if (!dir || !dir.startsWith("/") || dir.includes("\0") || /(^|\/)\.\.(\/|$)/.test(dir)) return null;
  const aid = parseMediaId(id);
  if (!aid || !isVariant(variant)) return null;
  return `${dir.replace(/\/+$/, "")}/${aid.slice(0, 2)}/${aid}/${FILE_NAMES[variant]}`;
}

/** `<staging>/<ticket uuid>.upload` — what the worker looks for (media_library.staged_path). */
export function stagedUploadPath(dir: string | null | undefined, ticket: unknown): string | null {
  if (!dir || !dir.startsWith("/") || dir.includes("\0") || /(^|\/)\.\.(\/|$)/.test(dir)) return null;
  const tid = parseMediaId(ticket);
  return tid ? `${dir.replace(/\/+$/, "")}/${tid}.upload` : null;
}

// ── signed URLs ─────────────────────────────────────────────────────────────

/** How long a link handed to a page or an API client works. */
export const MEDIA_URL_TTL_S = 600;
/** No link is honoured further out than this, whoever signed it. */
export const MEDIA_URL_MAX_TTL_S = 3600;
const MIN_SECRET_CHARS = 32;

/**
 * The signing key, or null when MEDIA_URL_SECRET is unset or too short to be
 * a key (a short value would make every link forgeable; better no links).
 * Its value is never logged, returned or compared anywhere but in the HMAC.
 */
export function mediaUrlSecret(raw: string | undefined = process.env.MEDIA_URL_SECRET): Buffer | null {
  const key = raw ?? "";
  return key.length >= MIN_SECRET_CHARS ? Buffer.from(key, "utf8") : null;
}

function payload(id: string, variant: MediaVariant, mime: string, exp: number): string {
  return `nightshift-media-v1\n${id}\n${variant}\n${mime}\n${exp}`;
}

export function signMedia(secret: Buffer, id: string, variant: MediaVariant, mime: string, exp: number): string {
  return createHmac("sha256", secret).update(payload(id, variant, mime, exp)).digest("base64url");
}

/** A same-origin path that serves one variant of one asset until `exp`. */
export function signedMediaPath(
  secret: Buffer,
  id: string,
  variant: MediaVariant,
  mime: string,
  nowS: number = Math.floor(Date.now() / 1000),
  ttlS: number = MEDIA_URL_TTL_S,
): string {
  const exp = nowS + Math.max(1, Math.min(ttlS, MEDIA_URL_MAX_TTL_S));
  const sig = signMedia(secret, id, variant, mime, exp);
  const q = new URLSearchParams({ t: mime, exp: String(exp), sig });
  return `/api/media/file/${id}/${variant}?${q.toString()}`;
}

export type VerifyResult = "ok" | "bad_request" | "expired" | "bad_signature";

/** Check a signed link: bound to this asset id, variant, type and expiry. */
export function verifyMedia(
  secret: Buffer,
  q: { id: unknown; variant: unknown; mime: unknown; exp: unknown; sig: unknown },
  nowS: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  const id = parseMediaId(q.id);
  if (!id || !isVariant(q.variant) || typeof q.mime !== "string" || typeof q.sig !== "string") return "bad_request";
  if (typeof q.exp !== "string" || !/^[1-9][0-9]{0,11}$/.test(q.exp)) return "bad_request";
  if (!variantContentType(q.variant, q.mime)) return "bad_request";
  const exp = Number(q.exp);
  const want = Buffer.from(signMedia(secret, id, q.variant, q.mime, exp));
  const got = Buffer.from(q.sig);
  // Signature first: an expired link and a forged one must not be told apart
  // by anyone who could not have made the link.
  if (got.length !== want.length || !timingSafeEqual(got, want)) return "bad_signature";
  if (exp <= nowS) return "expired";
  if (exp - nowS > MEDIA_URL_MAX_TTL_S + 60) return "bad_request";
  return "ok";
}

// ── ranges ──────────────────────────────────────────────────────────────────

/** One `bytes=` range (what a <video> element sends), or null for none, or
 *  "invalid" (416). Multi-range requests are answered with the whole file. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return "invalid";
  let start: number;
  let end: number;
  if (a === "") {
    const n = Number(b);
    if (!(n > 0)) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return "invalid";
  return { start, end };
}

// ── receiving an upload ─────────────────────────────────────────────────────

export type ReceiveResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: "too_large" | "empty" | "client_aborted" | "write_failed"; bytes: number };

/**
 * Stream a request body into `dest`, created exclusively (a second writer for
 * the same ticket fails instead of interleaving), refusing past `maxBytes` the
 * moment the count passes it — the body is never buffered whole. On any
 * failure the partial file is removed.
 */
export async function receiveUpload(
  body: ReadableStream<Uint8Array> | null,
  dest: string,
  maxBytes: number,
): Promise<ReceiveResult> {
  if (!body) return { ok: false, reason: "empty", bytes: 0 };
  let fh;
  try {
    fh = await open(dest, "wx", 0o644);
  } catch {
    return { ok: false, reason: "write_failed", bytes: 0 };
  }
  const reader = body.getReader();
  let n = 0;
  let failure: "too_large" | "client_aborted" | "write_failed" | null = null;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        failure = "client_aborted";
        break;
      }
      if (chunk.done) break;
      n += chunk.value.byteLength;
      if (n > maxBytes) {
        failure = "too_large";
        await reader.cancel().catch(() => {});
        break;
      }
      try {
        await fh.write(chunk.value);
      } catch {
        failure = "write_failed";
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    await fh.close().catch(() => {});
  }
  if (failure || n === 0) {
    await unlink(dest).catch(() => {});
    return { ok: false, reason: failure ?? "empty", bytes: n };
  }
  return { ok: true, bytes: n };
}

// ── the library, for the page and GET /api/media ───────────────────────────

/** The URL a browser should load for an asset: the proxy for video, the
 *  original otherwise (captions are shown by name only). */
export function withUrls(asset: MediaAsset, secret: Buffer | null, served: boolean, nowS?: number): LibraryAsset {
  if (!secret || !served) return { ...asset, thumbUrl: null, viewUrl: null };
  const thumbUrl = asset.variants.includes("thumb") ? signedMediaPath(secret, asset.id, "thumb", asset.mime, nowS) : null;
  const viewVariant: MediaVariant = asset.kind === "video" && asset.variants.includes("proxy") ? "proxy" : "original";
  const viewUrl = signedMediaPath(secret, asset.id, viewVariant, asset.mime, nowS);
  return { ...asset, thumbUrl, viewUrl };
}

export async function loadMediaLibrary(orgId: string): Promise<MediaLibraryData> {
  const secret = mediaUrlSecret();
  const host = { media: mediaDir() !== null, staging: mediaStagingDir() !== null, signing: secret !== null };
  const empty: MediaLibraryData = {
    available: false,
    host,
    assets: [],
    uploads: [],
    quota: { usedBytes: 0, limitBytes: null, maxUploadBytes: null },
  };
  const supabase = await createClient();
  if (!supabase || !parseMediaId(orgId)) return empty;
  try {
    const [assets, uploads, quota, settings] = await Promise.all([
      supabase.from("media_assets").select(MEDIA_ASSET_COLUMNS).eq("org_id", orgId).order("created_at", { ascending: false }).limit(200),
      supabase
        .from("media_uploads")
        .select(MEDIA_UPLOAD_COLUMNS)
        .eq("org_id", orgId)
        .neq("status", "ingested")
        .order("created_at", { ascending: false })
        .limit(20),
      supabase.from("org_storage_quota").select("limit_bytes, used_bytes").eq("org_id", orgId).maybeSingle(),
      supabase.from("media_storage_settings").select("default_quota_bytes, max_upload_bytes").maybeSingle(),
    ]);
    if (assets.error || uploads.error) {
      const missing = [assets.error, uploads.error].some((e) => e && /does not exist|42P01|PGRST205/i.test(`${e.code} ${e.message}`));
      return missing ? empty : { ...empty, available: true, error: "read_failed" };
    }
    const q = quota.data as { limit_bytes?: number | string | null; used_bytes?: number | string } | null;
    const s = settings.data as { default_quota_bytes?: number | string; max_upload_bytes?: number | string } | null;
    const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    const served = host.media;
    return {
      available: true,
      host,
      assets: coerceAssets(assets.data).map((a) => withUrls(a, secret, served)),
      uploads: coerceUploads(uploads.data),
      quota: {
        usedBytes: n(q?.used_bytes) ?? 0,
        // An unreadable limit stays unknown, never a number.
        limitBytes: quota.error || settings.error ? null : (n(q?.limit_bytes) ?? n(s?.default_quota_bytes)),
        maxUploadBytes: settings.error ? null : n(s?.max_upload_bytes),
      },
    };
  } catch {
    return { ...empty, available: true, error: "read_failed" };
  }
}
