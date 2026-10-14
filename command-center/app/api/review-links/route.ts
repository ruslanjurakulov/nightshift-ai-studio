import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { isSameOriginPost } from "@/lib/auth-confirm";
import { publicOrigin } from "@/lib/server/public-origin";
import { REVIEW_LINK_CREATE_RATE, rateRefusal, takeWebRate } from "@/lib/server/web-rate";
import {
  REVIEW_LINK_DEFAULT_DAYS,
  coerceReviewLinks,
  isReviewToken,
  localeForLink,
  mapReviewLinkError,
  parseReviewLinkDays,
  reviewLinkPath,
  type ReviewLinkErrorCode,
} from "@/lib/review-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function fail(error: ReviewLinkErrorCode | "not_configured", status: number, headers: Record<string, string> = {}) {
  return NextResponse.json({ error }, { status, headers: { ...NO_STORE, ...headers } });
}

function statusFor(code: ReviewLinkErrorCode): number {
  switch (code) {
    case "unauthorized": return 401;
    case "not_found": return 404;
    case "no_preview": return 409;
    case "limit_reached": return 409;
    case "bad_request": return 400;
    case "not_available": return 503;
    default: return 502;
  }
}

/** A video id as the pipeline writes it: one short token, no slash. */
const VIDEO_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * The links of one video (GET ?video_id=) and a new one (POST {video_id, days}).
 *
 * Both run as the signed-in person (anon key + their session): the database
 * (migration 0101) decides who may share which video, and a video the person
 * cannot administer reads as "not found", exactly like a made-up one. The
 * token is returned ONCE, in the POST answer, together with the full address;
 * the database keeps only its hash, so no later call can show it again. Nothing
 * here can approve, publish, re-render or spend: a link is view-only.
 */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return fail("unauthorized", 401);
  const videoId = new URL(request.url).searchParams.get("video_id") ?? "";
  if (!VIDEO_ID.test(videoId)) return fail("bad_request", 400);
  const supabase = await createClient();
  if (!supabase) return fail("not_configured", 503);
  const { data, error } = await supabase.rpc("list_review_links", { p_video_id: videoId });
  if (error) {
    const code = mapReviewLinkError(error);
    return fail(code === "not_available" ? "not_available" : "failed", statusFor(code));
  }
  return NextResponse.json({ links: coerceReviewLinks(data) }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return fail("unauthorized", 401);
  const ours = [publicOrigin(request), new URL(request.url).origin];
  if (!isSameOriginPost(request.headers, ours)) return fail("forbidden", 403);

  let body: { video_id?: unknown; days?: unknown; locale?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail("bad_request", 400);
  }
  const videoId = typeof body.video_id === "string" ? body.video_id : "";
  const days = body.days === undefined ? REVIEW_LINK_DEFAULT_DAYS : parseReviewLinkDays(body.days);
  if (!VIDEO_ID.test(videoId) || days === null) return fail("bad_request", 400);

  const rate = await takeWebRate(user.id, REVIEW_LINK_CREATE_RATE);
  if (rate !== "ok") {
    const r = rateRefusal(rate, REVIEW_LINK_CREATE_RATE);
    return fail(rate === "limited" ? "rate_limited" : "failed", r.status, r.headers);
  }

  const supabase = await createClient();
  if (!supabase) return fail("not_configured", 503);
  const { data, error } = await supabase.rpc("create_review_link", { p_video_id: videoId, p_days: days, p_locale: localeForLink(body.locale) });
  if (error) {
    const code = mapReviewLinkError(error);
    return fail(code, statusFor(code));
  }
  const made = data as { id?: unknown; token?: unknown; expires_at?: unknown } | null;
  if (!made || !isReviewToken(made.token) || typeof made.id !== "string" || typeof made.expires_at !== "string") {
    return fail("failed", 502);
  }
  return NextResponse.json(
    { id: made.id, expires_at: made.expires_at, url: `${publicOrigin(request)}${reviewLinkPath(made.token)}` },
    { status: 201, headers: NO_STORE },
  );
}
