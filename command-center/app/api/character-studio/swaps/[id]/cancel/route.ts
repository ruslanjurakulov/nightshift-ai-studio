import { NextResponse } from "next/server";
import { rejectCrossOrigin } from "@/lib/server/same-origin";
import { NO_STORE, characterStudioGate, csFail, studioRefusal } from "@/lib/server/character-studio";
import { characterStudioEnabled, parseId } from "@/lib/characterStudio/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cancel a swap no worker has taken yet (migration 0137's cancel_character_swap; NIGHTSHIFT_CHARACTER_STUDIO, default off: 404 first,
 * then the same origin, then the session). The whole hold goes back. A job already at the vendor answers not_cancellable; another
 * organization's job reads as not_found.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!characterStudioEnabled()) return csFail("not_found", 404);
  const cross = rejectCrossOrigin(request);
  if (cross) return cross;
  const gate = await characterStudioGate();
  if (!gate.ok) return gate.response;
  const job = parseId((await ctx.params).id);
  if (!job) return csFail("not_found", 404);
  const { data, error } = await gate.supabase.rpc("cancel_character_swap", { p_job: job });
  if (error) return studioRefusal(error);
  const status = (data as { status?: unknown } | null)?.status;
  return NextResponse.json({ id: job, status: typeof status === "string" ? status : "cancelled" }, { headers: NO_STORE });
}
