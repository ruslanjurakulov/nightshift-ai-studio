import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { editorRateLimited } from "@/lib/server/editor-guard";
import { EDITOR_QUOTE_RATE } from "@/lib/server/web-rate";
import { parseMediaId } from "@/lib/media";
import { mapEditorError } from "@/lib/editor";
import { multiRatioExportEnabled } from "@/lib/multiRatioExport/flag";
import { hiresExportEnabled } from "@/lib/hiresExport/flag";
import { isQuotableFrame, parseHiresQuote } from "@/lib/hiresExport/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET ?rev=<n>&frame=<paid frame id>: what a 1440p / 4K export of that SAVED revision would hold and charge (migration
 * 0132, quote_editor_export, under the caller's own session: membership, the closed list, the current revision). The
 * number is the database's, computed from the owner's price row and the document's length; this route adds none and
 * holds nothing. A 404 while NIGHTSHIFT_MULTI_RATIO_EXPORT or NIGHTSHIFT_HIRES_EXPORT is off, as if the route did not
 * exist; "not_available" (503) before 0132 is applied.
 *
 * Migration 0136: a frame up to 1080p (a free format, or "project" for the project's own frame) is quoted too. While its
 * price is NULL the database says paid=false and this answers `{ free: true, frame }`; once the owner sets it, the same
 * quote as a paid size. Before 0136 "project" is not a frame the database knows (invalid_frame, as a made-up word).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!multiRatioExportEnabled() || !hiresExportEnabled())
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  const user = await getUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id: raw } = await params;
  const id = parseMediaId(raw);
  if (!id) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const url = new URL(request.url);
  const revRaw = url.searchParams.get("rev") ?? "";
  const frame = url.searchParams.get("frame");
  const rev = /^[1-9][0-9]{0,8}$/.test(revRaw) ? Number(revRaw) : NaN;
  if (!Number.isInteger(rev) || !isQuotableFrame(frame))
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const limited = await editorRateLimited(user.id, EDITOR_QUOTE_RATE);
  if (limited) return limited;
  const supabase = await createClient();
  if (!supabase)
    return NextResponse.json({ error: "not_available" }, { status: 503 });
  const { data, error } = await supabase.rpc("quote_editor_export", {
    p_project: id,
    p_rev: rev,
    p_frame: frame,
  });
  if (error) {
    const mapped = mapEditorError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  // Free (0136: a frame up to 1080p while its price is NULL): said as such, with no number of any kind.
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { paid?: unknown }).paid === false) {
    const said = (data as { frame?: unknown }).frame;
    if (said !== frame)
      return NextResponse.json({ error: "failed" }, { status: 502 });
    return NextResponse.json({ free: true, frame }, { headers: { "cache-control": "no-store" } });
  }
  const quote = parseHiresQuote(data);
  // A quote that is not for the frame asked, or that cannot be read whole, is never shown as a price.
  if (!quote || quote.frame !== frame)
    return NextResponse.json({ error: "failed" }, { status: 502 });
  return NextResponse.json({ quote }, { headers: { "cache-control": "no-store" } });
}
