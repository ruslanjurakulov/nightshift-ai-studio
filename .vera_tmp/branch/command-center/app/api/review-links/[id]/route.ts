import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { isSameOriginPost } from "@/lib/auth-confirm";
import { publicOrigin } from "@/lib/server/public-origin";
import { isReviewLinkId, mapReviewLinkError } from "@/lib/review-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/**
 * Turn a review link off (DELETE). The database (migration 0101) lets only a
 * person who may share that video do it and says "not found" for everything
 * else (another workspace's link, a made-up id, a link already off): one answer.
 * It takes effect at once for everyone holding the link. The row stays, so the
 * list can show it as turned off.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const ours = [publicOrigin(request), new URL(request.url).origin];
  if (!isSameOriginPost(request.headers, ours)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  const { id } = await params;
  if (!isReviewLinkId(id)) return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503, headers: NO_STORE });
  const { data, error } = await supabase.rpc("revoke_review_link", { p_id: id });
  if (error) {
    const code = mapReviewLinkError(error);
    return NextResponse.json({ error: code === "not_available" ? "not_available" : "failed" }, { status: code === "not_available" ? 503 : 502, headers: NO_STORE });
  }
  if (data !== true) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
