import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { parseMediaId } from "@/lib/media";
import { TRACK_SUMMARY_COLUMNS, coerceTrackSummary } from "@/lib/captions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "This table does not exist": migration 0072 is not applied here. */
function isMissing(e: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|could not find the table/i.test(e.message ?? "")));
}

/**
 * The transcripts already made from one recording (migration 0072), newest
 * first — GET `?asset_id=`. Read under the member's own session: RLS shows
 * only the tracks of COMPLETED jobs of their organization, so another
 * organization's recording id answers an empty list, exactly like a made-up
 * one. Reading is free: nothing is made, held or spent.
 */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const asset = parseMediaId(new URL(request.url).searchParams.get("asset_id"));
  if (!asset) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase
    .from("caption_tracks")
    .select(TRACK_SUMMARY_COLUMNS)
    .eq("asset_id", asset)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    return isMissing(error)
      ? NextResponse.json({ error: "not_available" }, { status: 503 })
      : NextResponse.json({ error: "failed" }, { status: 502 });
  }
  const tracks = (Array.isArray(data) ? data : []).flatMap((r) => {
    const t = coerceTrackSummary(r);
    return t ? [t] : [];
  });
  return NextResponse.json({ tracks });
}
