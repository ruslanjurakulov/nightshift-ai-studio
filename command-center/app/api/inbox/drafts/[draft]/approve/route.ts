import { NextResponse } from "next/server";
import { auditInbox, callInbox, jsonBody } from "@/lib/server/comment-inbox";
import { cleanReply, isUuid } from "@/lib/comment-inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Approve one reply: POST { body } (approve_reply, migration 0081).
 *
 * THE gate. The body is the exact text the person is looking at; the
 * database files it as an append-only intent recording who approved which
 * text, and the worker posts those characters — nothing else, once — through
 * the channel's own connection. There is no other way a reply goes out: no
 * draft, model answer or comment can create an intent, and a second approval
 * of the same draft returns the first. Another organization's draft reads as
 * not found; someone without permission to edit the channel is refused.
 *
 * This route posts nothing itself: it files the approval and the queue
 * worker (which holds the channel's token) posts it a moment later.
 */
export async function POST(request: Request, { params }: { params: Promise<{ draft: string }> }) {
  const { draft } = await params;
  if (!isUuid(draft)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await jsonBody(request);
  if (!body || typeof body.body !== "string") return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const text = cleanReply(body.body);
  if (!text) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const out = await callInbox("approve_reply", { p_draft: draft, p_body: text });
  if (!out.ok) return out.response;
  const res = (out.data ?? {}) as { intent_id?: string; post_id?: string; status?: string; replay?: boolean };
  if (!res.replay) {
    await auditInbox("inbox.reply.approve", "reply_drafts", draft, {
      intent_id: res.intent_id ?? null,
      post_id: res.post_id ?? null,
      chars: text.length,
    });
  }
  return NextResponse.json({ ok: true, post_id: res.post_id ?? null, status: res.status ?? "queued", replayed: res.replay === true });
}
