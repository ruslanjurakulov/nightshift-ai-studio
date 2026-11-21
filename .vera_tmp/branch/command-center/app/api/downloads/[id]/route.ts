import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { createClient, getUser } from "@/lib/supabase/server";
import { downloadsDir } from "@/lib/server/downloads";
import { contentDisposition, downloadFilePath, parseDownloadId, type HdQuality } from "@/lib/downloads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stream a prepared 720p / 1080p download (migration 0030).
 *
 * The row is read with the caller's own session (RLS: viewers of the
 * video's organization — they may download what the organization paid for;
 * buying needs editor+). It must be `ready` and not expired. The file is
 * `<NIGHTSHIFT_DOWNLOADS_DIR>/<id>.mp4`, built from the numeric id alone —
 * never from anything the caller or a row supplies — on the worker's volume,
 * mounted read-only here. On a host without that volume (Vercel) this says so.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dir = downloadsDir();
  if (!dir)
    return NextResponse.json(
      {
        error: "downloads_unavailable",
        message: "HD downloads are served from the Nightshift server; this host has no downloads volume.",
      },
      { status: 503 },
    );

  const { id: raw } = await params;
  const id = parseDownloadId(raw);
  const file = downloadFilePath(dir, id);
  if (id === null || !file) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data: row, error } = await supabase
    .from("download_requests")
    .select("id, video_id, quality, status, expires_at")
    .eq("id", id)
    .maybeSingle();
  if (error || !row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = row as { video_id: string; quality: HdQuality; status: string; expires_at: string | null };
  if (r.status !== "ready") return NextResponse.json({ error: "not_ready", status: r.status }, { status: 409 });
  if (!r.expires_at || Date.parse(r.expires_at) <= Date.now())
    return NextResponse.json({ error: "expired" }, { status: 410 });

  let size: number;
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    size = s.size;
  } catch {
    return NextResponse.json({ error: "file_missing" }, { status: 410 });
  }

  const { data: video } = await supabase.from("videos").select("title").eq("video_id", r.video_id).maybeSingle();
  const title = (video as { title?: string | null } | null)?.title ?? null;
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
      "Content-Disposition": contentDisposition(title, r.video_id, r.quality),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
