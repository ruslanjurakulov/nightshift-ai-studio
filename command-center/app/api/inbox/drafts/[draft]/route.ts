import { NextResponse } from "next/server";
import { auditInbox, callInbox, jsonBody } from "@/lib/server/comment-inbox";
import { cleanReply, isUuid } from "@/lib/comment-inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ draft: string }> };

/**
 * PATCH { body } -> change the words of a draft that is ready (edit_reply_draft,
 * migration 0081). Free. The text is cleaned and bounded here and again by the
 * database; it is still only a draft until it is approved.
 */
export async function PATCH(request: Request, { params }: Ctx) {
  const { draft } = await params;
  if (!isUuid(draft)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await jsonBody(request);
  if (!body || typeof body.body !== "string") return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const text = cleanReply(body.body);
  if (!text) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const out = await callInbox("edit_reply_draft", { p_draft: draft, p_body: text });
  if (!out.ok) return out.response;
  await auditInbox("inbox.draft.edit", "reply_drafts", draft, { chars: text.length });
  return NextResponse.json({ ok: true });
}

/** DELETE -> throw a ready draft away (discard_reply_draft). Nothing is refunded (it was made); a new draft is a new, priced press. */
export async function DELETE(_request: Request, { params }: Ctx) {
  const { draft } = await params;
  if (!isUuid(draft)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const out = await callInbox("discard_reply_draft", { p_draft: draft });
  if (!out.ok) return out.response;
  const res = (out.data ?? {}) as { already?: boolean };
  if (!res.already) await auditInbox("inbox.draft.discard", "reply_drafts", draft);
  return NextResponse.json({ ok: true });
}
