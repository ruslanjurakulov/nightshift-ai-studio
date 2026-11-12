import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { editorRateLimited, readSmallBody } from "@/lib/server/editor-guard";
import { EDITOR_EXPORT_RATE } from "@/lib/server/web-rate";
import { parseMediaId } from "@/lib/media";
import { mapEditorError, type EditorError } from "@/lib/editor";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { multiRatioExportEnabled } from "@/lib/multiRatioExport/flag";
import { hiresExportEnabled } from "@/lib/hiresExport/flag";
import { isHiresPresetId } from "@/lib/hiresExport/limits";
import {
  PROJECT_FRAME,
  framePresetById,
  parseExportFrames,
  type ExportFrameChoice,
} from "@/lib/multiRatioExport/frames";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Export: POST `{ rev }` queues a render of that SAVED revision. This route
 * only writes the request (request_editor_export, under the caller's session:
 * membership, the current revision, files still live, the length and the
 * free-export limits); the media worker renders it with the ffmpeg engine and
 * puts the video in the library. It holds and charges no credits, calls no
 * provider, and publishes nothing — publishing stays behind the publish gate.
 *
 * Several frame sizes (migration 0129, NIGHTSHIFT_MULTI_RATIO_EXPORT, default off). While the switch is OFF the body's
 * `frames` field is not read at all and this route is exactly what it was. While it is ON, POST `{ rev, frames }` asks
 * for ONE export per entry of `frames`: "project" (the project's own frame, the two-argument function, as always) or
 * the id of a format of the closed list (lib/editorExportPresets.ts). Only the ID travels: no width, height or ratio
 * is accepted from the client, and the database reads the size from its own list. An entry outside the list refuses
 * the whole request before the database is asked. Each entry is its own request_editor_export() call, so each one
 * passes every gate of 0054 by itself and counts as one export against the organization's limits; the answer says,
 * frame by frame, which were queued and which were refused and why. Before 0129 is applied the three-argument function
 * does not exist: that frame is answered "not_available" and NOTHING is rendered in its place (an export in the wrong
 * frame would be a quiet substitute); the project's own frame still goes through.
 *
 * 1440p and 4K (migration 0132, NIGHTSHIFT_HIRES_EXPORT on top of the switch above, default off). Off, a paid frame id
 * is an unknown word and refuses the request like one. On, a paid frame needs `maxCredits[frame]`: the number of
 * credits the person confirmed after the server quoted it (GET .../exports/quote). It goes to the four-argument
 * request_editor_export, which computes the price again, refuses a higher one (price_changed), holds it and queues the
 * export, all in the database; this route sends no price of its own and touches no credit. A paid frame without a
 * confirmed number refuses the whole request (quote_required) before the database is asked.
 */
export const POST = requireSameOrigin(async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id: raw } = await params;
  const id = parseMediaId(raw);
  if (!id) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const limited = await editorRateLimited(user.id, EDITOR_EXPORT_RATE);
  if (limited) return limited;
  const read = await readSmallBody(request);
  if ("refusal" in read) return read.refusal;
  const body = read.body;
  const rev =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { rev?: unknown }).rev
      : undefined;
  if (!Number.isInteger(rev) || (rev as number) < 1)
    return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase)
    return NextResponse.json({ error: "not_available" }, { status: 503 });

  // Only while the switch is on is the field looked at; off, a request that carries it is the plain export.
  const asked =
    multiRatioExportEnabled() && body && typeof body === "object" && !Array.isArray(body)
      ? (body as { frames?: unknown }).frames
      : undefined;
  if (asked !== undefined) {
    const frames = parseExportFrames(asked, { hires: hiresExportEnabled() });
    if (!frames)
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    // The confirmed number of every paid frame (0132), read only for paid frames and only while their switch is on.
    const confirmed = new Map<ExportFrameChoice, number>();
    const paid = frames.filter((f) => isHiresPresetId(f));
    if (paid.length) {
      const raw = (body as { maxCredits?: unknown }).maxCredits;
      for (const f of paid) {
        const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>)[f] : undefined;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000_000)
          return NextResponse.json({ error: "quote_required" }, { status: 400 });
        confirmed.set(f, v);
      }
    }
    // "This project's size" and a format of that same size are the same picture twice: one export of the day for nothing.
    // Refused whole, like any request that is not understood. The project's size is read under the caller's own session
    // (RLS); if it cannot be read the request goes on and the database refuses the second one itself (0129: a format of
    // the size of an export in flight is export_in_progress).
    if (frames.includes(PROJECT_FRAME) && frames.length > 1) {
      const { data: own } = await supabase
        .from("editor_projects")
        .select("doc->width, doc->height")
        .eq("id", id)
        .maybeSingle();
      const size = own as { width?: unknown; height?: unknown } | null;
      if (
        size &&
        frames.some((f) => {
          const p = f === PROJECT_FRAME ? null : framePresetById(f);
          return p !== null && p.width === size.width && p.height === size.height;
        })
      )
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const results: (
      | { frame: ExportFrameChoice; id: string; status: "queued" }
      | { frame: ExportFrameChoice; error: EditorError }
    )[] = [];
    let firstRefusal: { error: EditorError; status: number } | null = null;
    for (const frame of frames) {
      // Three calls on purpose: the project's own frame is the two-argument function, untouched by 0129; a free frame the
      // three-argument one, untouched by 0132; a paid frame the four-argument one with the number the person confirmed.
      const max = confirmed.get(frame);
      const { data, error } =
        frame === PROJECT_FRAME
          ? await supabase.rpc("request_editor_export", {
              p_project: id,
              p_rev: rev,
            })
          : max === undefined
            ? await supabase.rpc("request_editor_export", {
                p_project: id,
                p_rev: rev,
                p_frame: frame,
              })
            : await supabase.rpc("request_editor_export", {
                p_project: id,
                p_rev: rev,
                p_frame: frame,
                p_max_credits: max,
              });
      const exportId = error ? null : parseMediaId(data);
      if (error || !exportId) {
        const mapped = error
          ? mapEditorError(error)
          : { error: "failed" as const, status: 502 };
        firstRefusal ??= mapped;
        results.push({ frame, error: mapped.error });
        continue;
      }
      await logAudit({
        action: "editor.export_request",
        target: exportId,
        detail:
          frame === PROJECT_FRAME
            ? { project: id, rev }
            : max === undefined
              ? { project: id, rev, frame }
              : { project: id, rev, frame, maxCredits: max },
      });
      results.push({ frame, id: exportId, status: "queued" });
    }
    const queued = results.some((r) => "id" in r);
    // 201 when at least one export was queued; otherwise the first refusal decides the status, and its word is the
    // answer's `error` too, so a caller that reads only that still gets a sentence.
    return queued || !firstRefusal
      ? NextResponse.json({ exports: results }, { status: 201 })
      : NextResponse.json(
          { error: firstRefusal.error, exports: results },
          { status: firstRefusal.status },
        );
  }

  const { data, error } = await supabase.rpc("request_editor_export", {
    p_project: id,
    p_rev: rev,
  });
  if (error) {
    const mapped = mapEditorError(error);
    return NextResponse.json(
      { error: mapped.error },
      { status: mapped.status },
    );
  }
  const exportId = parseMediaId(data);
  if (!exportId) return NextResponse.json({ error: "failed" }, { status: 502 });
  await logAudit({
    action: "editor.export_request",
    target: exportId,
    detail: { project: id, rev },
  });
  return NextResponse.json({ id: exportId, status: "queued" }, { status: 201 });
});
