import { NextResponse } from "next/server";
import { auditInbox, callInbox, jsonBody } from "@/lib/server/comment-inbox";
import { isIdempotencyKey, isUuid, parseQuote } from "@/lib/comment-inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A drafted reply for one comment (migration 0081).
 *
 * GET  -> the quote: what drafting would cost and whether this comment can be
 *         drafted for (spam, flagged and never-checked comments cannot),
 *         computed by the database from the price list. Free. An unset price
 *         is "unpriced", never 0, and the margin is never in the answer.
 *
 * POST { max_credits, idempotency_key } -> the priced press. The body carries
 *         the price the person saw and one key per press; the database
 *         (request_reply_draft) does the rest in one transaction: who may (an
 *         editor of the channel's organization), the state of the comment, the
 *         re-quote (a higher price now is price_changed and nothing is held),
 *         the hold (= the quote) and the draft row. The same key again returns
 *         the same draft and holds nothing more. The worker writes the draft
 *         later; if it cannot, the hold is released in full.
 *
 * A draft is only a draft: nothing here can post anything.
 */

type Ctx = { params: Promise<{ comment: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  const { comment } = await params;
  if (!isUuid(comment)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const out = await callInbox("quote_reply_draft", { p_comment: comment });
  if (!out.ok) return out.response;
  return NextResponse.json({ quote: parseQuote(out.data) });
}

export async function POST(request: Request, { params }: Ctx) {
  const { comment } = await params;
  if (!isUuid(comment)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await jsonBody(request);
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const mc = body.max_credits;
  if (mc != null && !(typeof mc === "number" && Number.isFinite(mc) && mc >= 0))
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!isIdempotencyKey(body.idempotency_key)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const out = await callInbox("request_reply_draft", {
    p_comment: comment,
    p_max_credits: typeof mc === "number" ? mc : null,
    p_idem: body.idempotency_key,
  });
  if (!out.ok) return out.response;
  const res = (out.data ?? {}) as { draft?: { id?: string; status?: string }; replay?: boolean; credits_held?: number | string | null };
  const held = res.credits_held == null ? null : Number(res.credits_held);
  if (!res.replay && res.draft?.id) {
    await auditInbox("inbox.draft.request", "inbox_comments", comment, {
      draft_id: res.draft.id,
      ...(held != null && Number.isFinite(held) ? { credits_reserved: held } : {}),
    });
  }
  return NextResponse.json({
    ok: true,
    id: res.draft?.id ?? null,
    status: res.draft?.status ?? "pending",
    credits_reserved: held != null && Number.isFinite(held) ? held : null,
    replayed: res.replay === true,
  });
}
