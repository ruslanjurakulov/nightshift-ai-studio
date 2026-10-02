import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { parseMediaId } from "@/lib/media";
import { TRACK_COLUMNS, coerceTrack } from "@/lib/captions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function missing(e: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(
    e && (e.code === "42P01" || e.code === "42883" || e.code === "PGRST202" || e.code === "PGRST205" || /does not exist|could not find the (table|function)/i.test(e.message ?? "")),
  );
}

/**
 * One transcript with its words (migration 0072). RLS: a member of the
 * organization reads it once the job that paid for it has completed; another
 * organization's track, an unfinished job's and a made-up id are the same 404.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = parseMediaId((await params).id);
  if (!id) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.from("caption_tracks").select(TRACK_COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    return missing(error)
      ? NextResponse.json({ error: "not_available" }, { status: 503 })
      : NextResponse.json({ error: "failed" }, { status: 502 });
  }
  const track = coerceTrack(data);
  if (!track) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ track });
}

/**
 * Hide a transcript from the organization (editors and above; the database
 * checks). Captions already put into a project stay: they are the project's
 * own cues. Another organization's track reads exactly like a missing one.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = parseMediaId((await params).id);
  if (!id) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { error } = await supabase.rpc("delete_caption_track", { p_track: id });
  if (error) {
    if (error.code === "P0002") return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (error.code === "42501") return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return missing(error)
      ? NextResponse.json({ error: "not_available" }, { status: 503 })
      : NextResponse.json({ error: "failed" }, { status: 502 });
  }
  await logAudit({ action: "captions.delete", target: id });
  return NextResponse.json({ ok: true });
}
