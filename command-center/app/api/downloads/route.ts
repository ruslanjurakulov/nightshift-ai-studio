import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { downloadsDir } from "@/lib/server/downloads";
import { parseInsufficient } from "@/lib/credits";
import { mapDownloadError, type HdQuality } from "@/lib/downloads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Buy a 720p / 1080p download (migration 0030).
 *
 * POST `{ video_id, quality, max_credits }`. Calls request_download() as the
 * signed-in user (anon key + session; no service key): the database checks
 * editor+ in the video's organization, prices it from the worker-probed
 * master, debits the credits through the ledger and queues the row — or
 * returns the existing row / makes it free (re-download within 7 days, exempt
 * organization). `max_credits` is the price the person confirmed: a higher
 * price is refused (price_changed), never charged.
 *
 * On a host without the shared downloads volume (Vercel) nothing is sold:
 * the file could never be served here.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!downloadsDir()) return NextResponse.json({ error: "downloads_unavailable" }, { status: 503 });

  let body: { video_id?: unknown; quality?: unknown; max_credits?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const videoId = typeof body.video_id === "string" ? body.video_id.trim() : "";
  if (!videoId || videoId.length > 128) return NextResponse.json({ error: "video_required" }, { status: 400 });
  const quality = body.quality === "720p" || body.quality === "1080p" ? (body.quality as HdQuality) : null;
  if (!quality) return NextResponse.json({ error: "bad_quality" }, { status: 400 });
  const maxCredits =
    typeof body.max_credits === "number" && Number.isFinite(body.max_credits) && body.max_credits >= 0
      ? body.max_credits
      : null;
  if (maxCredits === null) return NextResponse.json({ error: "confirm_price" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data, error } = await supabase.rpc("request_download", {
    p_video_id: videoId,
    p_quality: quality,
    p_max_credits: maxCredits,
  });
  if (error) {
    const mapped = mapDownloadError(error);
    const short = mapped.error === "insufficient_credits" ? parseInsufficient(error) : null;
    const off = short?.extraOff ? { extra_off: true, extra: short.extra ?? null } : {};
    return NextResponse.json(
      { error: mapped.error, ...(short ? { available: short.available, needed: short.needed } : {}), ...off },
      { status: mapped.status },
    );
  }
  const out = (data ?? {}) as { id?: number; charged?: number; reused?: boolean; free_reason?: string | null };
  const { data: video } = await supabase.from("videos").select("channel_id").eq("video_id", videoId).maybeSingle();
  await logAudit({
    action: "video.download_request",
    channelId: (video as { channel_id?: string } | null)?.channel_id ?? undefined,
    target: videoId,
    detail: { id: out.id ?? null, quality, charged: out.charged ?? 0, reused: Boolean(out.reused), free: out.free_reason ?? null },
  });
  return NextResponse.json({ ok: true, ...out });
}
