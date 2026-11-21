import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { assetFilePath, mediaDir, mediaUrlSecret, parseRange, verifyMedia } from "@/lib/server/media";
import { variantContentType, type MediaVariant } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serve one file of one asset through a short-lived signed link (migration
 * 0038). The link is the authorization: the Command Center signs it only after
 * reading the asset row under a member's session (RLS), and the HMAC binds it
 * to that asset id, that variant, the type it is served as and an expiry of at
 * most an hour. A changed character anywhere — another id, another variant,
 * a later expiry — fails the signature. No session is read here, so <img>,
 * <video> range requests and API clients all work without a database round
 * trip per range.
 *
 * The file is `<media>/<aa>/<uuid>/<fixed name>` from the verified id alone, on
 * the worker's volume mounted read-only.
 */
async function serve(request: Request, params: Promise<{ id: string; variant: string }>, head: boolean) {
  const secret = mediaUrlSecret();
  const dir = mediaDir();
  if (!secret || !dir) return NextResponse.json({ error: "media_unavailable" }, { status: 503 });

  const { id, variant } = await params;
  const url = new URL(request.url);
  const mime = url.searchParams.get("t");
  const verdict = verifyMedia(secret, {
    id,
    variant,
    mime,
    exp: url.searchParams.get("exp"),
    sig: url.searchParams.get("sig"),
  });
  if (verdict === "bad_request") return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (verdict === "bad_signature") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (verdict === "expired") return NextResponse.json({ error: "expired" }, { status: 410 });

  const file = assetFilePath(dir, id, variant);
  const type = variantContentType(variant as MediaVariant, mime as string);
  if (!file || !type) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  let size: number;
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    size = s.size;
  } catch {
    // Deleted and purged, or never there.
    return NextResponse.json({ error: "gone" }, { status: 410 });
  }

  const exp = Number(url.searchParams.get("exp"));
  const maxAge = Math.max(0, Math.min(600, exp - Math.floor(Date.now() / 1000)));
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": `private, max-age=${maxAge}`,
    "X-Content-Type-Options": "nosniff",
    // Opened directly, nothing in it may run or load anything.
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Content-Disposition": "inline",
  };

  const range = parseRange(request.headers.get("range"), size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  headers["Content-Length"] = String(size === 0 ? 0 : end - start + 1);
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  const status = range ? 206 : 200;
  if (head || size === 0) return new Response(null, { status, headers });
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string; variant: string }> }) {
  return serve(request, params, false);
}

export async function HEAD(request: Request, { params }: { params: Promise<{ id: string; variant: string }> }) {
  return serve(request, params, true);
}
