import { NextResponse } from "next/server";
import { callResearchWriter } from "@/lib/server/research";
import { CHANNEL_ID_RE, UUID_RE } from "@/lib/research";
import { requireSameOrigin } from "@/lib/server/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Remove a competitor (research_remove_competitor, migration 0200). Another channel's id removes nothing. */
export const DELETE = requireSameOrigin(async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const channel = new URL(request.url).searchParams.get("channel") ?? "";
  if (!UUID_RE.test(id) || !CHANNEL_ID_RE.test(channel)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return callResearchWriter("research_remove_competitor", { p_channel: channel, p_id: id });
});
