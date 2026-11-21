import { NextResponse } from "next/server";
import { callResearchWriter, researchBody } from "@/lib/server/research";
import { CHANNEL_ID_RE, RESEARCH_KINDS } from "@/lib/research";
import { requireSameOrigin } from "@/lib/server/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ask for fresh research numbers (research_request_refresh, migration 0199): one queued row, or the open one a second press finds.
 * Nothing here calls YouTube or spends: the worker does, after counting the day's budget.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  const body = await researchBody(request);
  const channel = body?.channel;
  const kind = body?.kind;
  const topic = body?.topic;
  if (typeof channel !== "string" || !CHANNEL_ID_RE.test(channel)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (typeof kind !== "string" || !(RESEARCH_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
  }
  if (kind === "topic" && (typeof topic !== "string" || topic.trim().length < 2 || topic.length > 200)) {
    return NextResponse.json({ error: "invalid_topic" }, { status: 400 });
  }
  return callResearchWriter("research_request_refresh", {
    p_channel: channel,
    p_kind: kind,
    p_topic: kind === "topic" ? String(topic).trim() : null,
  });
});
