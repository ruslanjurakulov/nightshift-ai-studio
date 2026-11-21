import { NextResponse } from "next/server";
import { callResearchWriter, researchBody } from "@/lib/server/research";
import { CHANNEL_ID_RE } from "@/lib/research";
import { requireSameOrigin } from "@/lib/server/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Add a competitor (research_add_competitor, migration 0200). The reference stays "pending" until the worker asks YouTube which
 * channel it names; a name YouTube does not know reads "not found". The database parses the reference and keeps only the part that
 * names a channel: nothing typed here is ever fetched as a link.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  const body = await researchBody(request);
  const channel = body?.channel;
  const ref = body?.ref;
  if (typeof channel !== "string" || !CHANNEL_ID_RE.test(channel)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (typeof ref !== "string" || ref.trim().length < 3 || ref.length > 300) return NextResponse.json({ error: "invalid_ref" }, { status: 400 });
  return callResearchWriter("research_add_competitor", { p_channel: channel, p_ref: ref.trim() });
});
