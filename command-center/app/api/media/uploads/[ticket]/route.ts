import { NextResponse } from "next/server";
import { unlink } from "node:fs/promises";
import { createClient, getUser } from "@/lib/supabase/server";
import { mediaStagingDir, receiveUpload, stagedUploadPath } from "@/lib/server/media";
import { mapMediaError, parseMediaId } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Receive the body of an upload ticket (migration 0038) into the staging volume.
 *
 * PUT with the raw file as the body. This path is left out of middleware.ts's
 * matcher on purpose: Next buffers a request body in memory for middleware and
 * silently cuts it at 10 MB (experimental.middlewareClientMaxBodySize), which
 * would both hold a whole upload in RAM and truncate it. The session is
 * checked here instead.
 *
 * 1. begin_upload_receive(ticket) under the caller's session: only the person
 *    who asked for the ticket, only while it is 'requested' and unexpired,
 *    and only once — a retry or a parallel PUT is refused before a byte is
 *    written.
 * 2. The body is streamed to <staging>/<ticket>.upload (a name from the uuid
 *    alone, created exclusively), counted as it arrives and cut off the moment
 *    it passes the size the ticket declared.
 * 3. finish_upload_receive(ticket, bytes, ok) — then the worker takes over;
 *    nothing is served until it has checked the content.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ ticket: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dir = mediaStagingDir();
  if (!dir) return NextResponse.json({ error: "media_unavailable" }, { status: 503 });

  const { ticket: raw } = await params;
  const ticket = parseMediaId(raw);
  const dest = stagedUploadPath(dir, ticket);
  if (!ticket || !dest) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const lengthHeader = request.headers.get("content-length");
  const declaredLength = lengthHeader === null ? null : /^\d{1,15}$/.test(lengthHeader) ? Number(lengthHeader) : NaN;
  if (Number.isNaN(declaredLength)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const begin = await supabase.rpc("begin_upload_receive", { p_ticket: ticket });
  if (begin.error) {
    const mapped = mapMediaError(begin.error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  const started = (begin.data ?? {}) as { ok?: boolean; status?: string; max_bytes?: number };
  if (!started.ok) {
    return NextResponse.json(
      { error: started.status === "expired" ? "ticket_expired" : "ticket_used", status: started.status ?? null },
      { status: started.status === "expired" ? 410 : 409 },
    );
  }
  const maxBytes = Number(started.max_bytes);

  const finish = async (bytes: number, ok: boolean, reason: string | null) =>
    supabase.rpc("finish_upload_receive", { p_ticket: ticket, p_bytes: bytes, p_ok: ok, p_reason: reason });

  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    await finish(0, false, "write_failed");
    return NextResponse.json({ error: "failed" }, { status: 502 });
  }
  // Said too much up front: refuse without reading a byte.
  if (declaredLength !== null && declaredLength > maxBytes) {
    await request.body?.cancel().catch(() => {});
    await finish(0, false, "too_large");
    return NextResponse.json({ error: "too_large", max_bytes: maxBytes }, { status: 413 });
  }

  const got = await receiveUpload(request.body, dest, maxBytes);
  if (!got.ok) {
    await finish(got.bytes, false, got.reason);
    const status = got.reason === "too_large" ? 413 : got.reason === "empty" ? 400 : got.reason === "client_aborted" ? 400 : 500;
    return NextResponse.json({ error: got.reason, ...(got.reason === "too_large" ? { max_bytes: maxBytes } : {}) }, { status });
  }
  const done = await finish(got.bytes, true, null);
  if (done.error || done.data !== "uploaded") {
    // The ticket did not move to 'uploaded' (it expired meanwhile, or the
    // call failed): the file would never be ingested, so it is not kept.
    await unlink(dest).catch(() => {});
    return NextResponse.json({ error: "failed", status: typeof done.data === "string" ? done.data : null }, { status: 502 });
  }
  return NextResponse.json({ ok: true, ticket, status: "uploaded", bytes: got.bytes });
}
