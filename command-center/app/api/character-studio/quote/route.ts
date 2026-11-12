import { NextResponse } from "next/server";
import { NO_STORE, characterStudioGate, csFail, resolveStudioOrg, studioRefusal } from "@/lib/server/character-studio";
import { coerceQuote, isResolution, parseId } from "@/lib/characterStudio/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What a swap of one library video would cost, per model (migration 0135's quote_character_swap; NIGHTSHIFT_CHARACTER_STUDIO, default off:
 * 404). GET `?org=<id>&input=<video id>&resolution=720p|1080p`. The database computes each model's charge from that vendor's own price
 * for the clip's length and the resolution; the browser shows it and never computes one. A model with no price reads `on_sale: false`.
 */
export async function GET(request: Request) {
  const gate = await characterStudioGate();
  if (!gate.ok) return gate.response;
  const q = new URL(request.url).searchParams;
  const input = parseId(q.get("input"));
  const resolution = q.get("resolution");
  if (!input || !isResolution(resolution)) return csFail("bad_request", 400);
  const { org, bad } = await resolveStudioOrg(q.get("org"));
  if (bad) return csFail("bad_request", 400);
  if (!org) return csFail("org_required", 400);
  const { data, error } = await gate.supabase.rpc("quote_character_swap", { p_org: org, p_input: input, p_resolution: resolution });
  if (error) return studioRefusal(error);
  const quote = coerceQuote(data);
  if (!quote) return csFail("failed", 502);
  return NextResponse.json({ quote }, { headers: NO_STORE });
}
