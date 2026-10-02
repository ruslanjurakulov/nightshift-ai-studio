import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { resolveRunBackend } from "@/lib/runBackend";
import {
  clipRefs,
  decodeClips,
  isIdempotencyKey,
  isVideoId,
  mapRepurposeError,
  parseQuote,
} from "@/lib/repurpose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Repurpose into clips" (migration 0080) — the quote and the priced press for
 * up to five clips of one finished video.
 *
 * GET  ?clips=s000-s002,s004-s004 → the quote: computed by the database
 *      (quote_repurpose) from the video's own Video IR and the price list, read
 *      with the signed-in person's own session. Free; reads only what the person
 *      may read. An unset price is "unpriced", never 0. The browser names only
 *      each clip's first and last scene: the database derives the window itself.
 *
 * POST { clips: [{first, last}], max_credits, idempotency_key } → the press.
 *      The body carries the price the person saw and one key per press; the
 *      database (request_repurpose) does the rest in one transaction: who (an
 *      admin of the channel's organization), the re-quote (a higher price now is
 *      price_changed and nothing is held), the hold (= the quote), the request
 *      and its clip rows. The same key again returns the same request and holds
 *      nothing more.
 *
 * Nothing here cuts, spends or publishes by itself: the route calls one
 * database function with the person's own session (anon key — the service key
 * is never here) and the queue worker makes the clips. Clips are cut from the
 * master on the worker's disk, so a press is accepted only on the queue
 * backend; on Actions it is refused before anything is held.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isVideoId(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const clips = decodeClips(new URL(request.url).searchParams.get("clips"));
  if (!clips) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("quote_repurpose", { p_video: id, p_clips: clips });
  if (error) {
    const mapped = mapRepurposeError(error);
    // Not yours and not there read the same.
    return NextResponse.json(mapped.body, { status: mapped.status === 403 ? 404 : mapped.status });
  }
  const quote = parseQuote(data);
  const backend = resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: process.env.NIGHTSHIFT_RUN_BACKEND });
  return NextResponse.json({ quote, queue: backend === "queue" });
}

export async function POST(request: Request, { params }: Ctx) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isVideoId(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const mc = body.max_credits;
  if (mc != null && !(typeof mc === "number" && Number.isFinite(mc) && mc > 0))
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const key = body.idempotency_key;
  if (!isIdempotencyKey(key)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const clips = clipRefs(body.clips);
  if (!clips) return NextResponse.json({ error: "invalid_clips" }, { status: 400 });

  // The worker that holds the master's files is the queue worker. Refused here,
  // before anything is held, rather than queued for nobody to claim.
  const backend = resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: process.env.NIGHTSHIFT_RUN_BACKEND });
  if (backend !== "queue") return NextResponse.json({ error: "queue_required" }, { status: 409 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("request_repurpose", {
    p_video: id,
    p_clips: clips,
    p_max_credits: typeof mc === "number" ? mc : null,
    p_idem: key,
  });
  if (error) {
    const mapped = mapRepurposeError(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
  const res = (data ?? {}) as {
    id?: string;
    status?: string;
    clip_count?: number;
    credits_held?: number | string | null;
    replayed?: boolean;
  };
  const held = res.credits_held == null ? null : Number(res.credits_held);
  if (!res.replayed) {
    // The video's own channel, read with the person's session, so the audit
    // row lands in the organization that was charged.
    const owner = await supabase.from("videos").select("channel_id").eq("video_id", id).maybeSingle();
    const channelId = (owner.data as { channel_id?: string } | null)?.channel_id ?? undefined;
    await logAudit({
      channelId,
      action: "video.repurpose",
      target: id,
      detail: {
        clip_count: clips.length,
        request_id: res.id ?? null,
        ...(held != null && Number.isFinite(held) ? { credits_reserved: held } : {}),
      },
    });
  }
  return NextResponse.json({
    ok: true,
    id: res.id ?? null,
    status: res.status ?? "queued",
    clip_count: res.clip_count ?? clips.length,
    credits_reserved: held != null && Number.isFinite(held) ? held : null,
    replayed: res.replayed === true,
  });
}
