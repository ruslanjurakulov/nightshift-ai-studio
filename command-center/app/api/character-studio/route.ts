import { NextResponse } from "next/server";
import { NO_STORE, characterStudioGate, csFail, loadStudio, resolveStudioOrg, studioPolicyRefusal } from "@/lib/server/character-studio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Character Studio's state (migration 0137; NIGHTSHIFT_CHARACTER_STUDIO, default off: 404 before anything is read).
 *
 * GET `?org=<id>`: the gallery's cards with each model's sample (or none yet), the organization's latest swaps, and the library's videos
 * and pictures the studio can pick, read under the member's own session (RLS). Nothing is priced here: the quote is its own call.
 */
export async function GET(request: Request) {
  const policy = studioPolicyRefusal();
  if (policy) return policy;
  const gate = await characterStudioGate();
  if (!gate.ok) return gate.response;
  const { org, bad } = await resolveStudioOrg(new URL(request.url).searchParams.get("org"));
  if (bad) return csFail("bad_request", 400);
  if (!org) return csFail("org_required", 400);
  const state = await loadStudio(gate.supabase, org, { urls: true });
  if (!state.available) return csFail("not_available", 503);
  if (state.error) return csFail("read_failed", 502);
  return NextResponse.json({ org, ...state }, { headers: NO_STORE });
}
