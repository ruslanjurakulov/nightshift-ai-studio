import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { createClient, getUser } from "@/lib/supabase/server";
import { assetFilePath, mediaDir, mediaUrlSecret, parseRange, signedMediaPath } from "@/lib/server/media";
import { MEDIA_ASSET_COLUMNS, coerceAssets, mapMediaError, parseMediaId, variantContentType } from "@/lib/media";
import {
  attachmentDisposition,
  downloadFileName,
  exportCues,
  parseDownloadVariant,
  previewVariantFor,
} from "@/lib/libraryDownload";
import { buildSrt } from "@/lib/captions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = "private, no-store";

function refuse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": NO_STORE } });
}

/**
 * GET /api/library/{asset}/download?variant=original|preview|captions
 *
 * The stable address of one file of a library asset (docs/EXPORT_DOWNLOADS.md).
 * The asset row is read under the caller's own session first. RLS returns it
 * only to a member of its organization and only while it is not deleted, so
 * another tenant's id gets the same 404 as a made-up one.
 *
 * - original: the master itself, streamed from the media volume as an
 *   attachment. This is not a signed bearer link: a forwarded URL is worth
 *   nothing without the session.
 * - preview: a 303 to a freshly signed link of the preview copy (the 480p
 *   proxy), so a <video> keeps its range requests. When there is no preview
 *   the answer says so. The original is never substituted, or "Preview" and
 *   "Download original" would quietly be the same file.
 * - captions: the SRT of the captions the export was rendered with
 *   (editor_exports.doc, the revision as asked for). The burned-in picture is
 *   unchanged.
 *
 * Read-only: nothing here renders, queues, charges or writes a row.
 */
export async function GET(request: Request, { params }: { params: Promise<{ asset: string }> }) {
  const user = await getUser();
  if (!user) return refuse("unauthorized", 401);
  const { asset: raw } = await params;
  const id = parseMediaId(raw);
  const variant = parseDownloadVariant(new URL(request.url).searchParams.get("variant"));
  if (!id || !variant) return refuse("bad_request", 400);

  const supabase = await createClient();
  if (!supabase) return refuse("not_configured", 503);
  const { data, error } = await supabase.from("media_assets").select(MEDIA_ASSET_COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    const mapped = mapMediaError(error);
    return refuse(mapped.error, mapped.status);
  }
  const asset = coerceAssets(data ? [data] : [])[0];
  if (!asset) return refuse("not_found", 404);

  if (variant === "captions") {
    const { data: exp, error: expError } = await supabase
      .from("editor_exports")
      .select("captions:doc->captions")
      .eq("asset_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // A failed read is not "no captions": say it could not be read.
    if (expError) return refuse("read_failed", 502);
    const cues = exportCues((exp as { captions?: unknown } | null)?.captions);
    if (cues.length === 0) return refuse("no_captions", 404);
    const srt = buildSrt(cues);
    if (!srt) return refuse("no_captions", 404);
    return new Response(srt, {
      status: 200,
      headers: {
        "Content-Type": "application/x-subrip; charset=utf-8",
        "Content-Disposition": attachmentDisposition(downloadFileName({ ...asset, width: null, height: null }, "srt")),
        "Cache-Control": NO_STORE,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const dir = mediaDir();
  if (!dir) return refuse("media_unavailable", 503);

  if (variant === "preview") {
    const secret = mediaUrlSecret();
    if (!secret) return refuse("media_unavailable", 503);
    const pv = previewVariantFor(asset);
    if (!pv) return refuse("no_preview", 404);
    const location = signedMediaPath(secret, asset.id, pv, asset.mime);
    return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": NO_STORE } });
  }

  const file = assetFilePath(dir, asset.id, "original");
  const type = variantContentType("original", asset.mime);
  if (!file || !type) return refuse("bad_request", 400);
  let size: number;
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    size = s.size;
  } catch {
    // The row is live but the file was purged, or never written.
    return refuse("gone", 410);
  }

  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Content-Disposition": attachmentDisposition(downloadFileName(asset)),
    "Cache-Control": NO_STORE,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
  };
  const range = parseRange(request.headers.get("range"), size);
  if (range === "invalid")
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  headers["Content-Length"] = String(size === 0 ? 0 : end - start + 1);
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  if (size === 0) return new Response(null, { status: 200, headers });
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status: range ? 206 : 200, headers });
}
