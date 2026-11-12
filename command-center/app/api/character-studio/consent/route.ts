import { NextResponse } from "next/server";
import { rejectCrossOrigin } from "@/lib/server/same-origin";
import { NO_STORE, characterStudioGate, csFail, readStudioBody, resolveStudioOrg, studioRefusal } from "@/lib/server/character-studio";
import { CONSENT_VERSION, DECLARATIONS, characterStudioEnabled, isModel, parseId } from "@/lib/characterStudio/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The consent step (migration 0135's record_character_swap_consent; NIGHTSHIFT_CHARACTER_STUDIO, default off: 404 first, then the same
 * origin, then the session). POST `{ org_id?, model, input, references: [ids, in order], declarations: {five keys: true} }`.
 * The database records the five declarations for THIS video, THESE pictures and THIS model, append-only, as the consent text version
 * this page shows (CONSENT_VERSION); the request that follows must name the consent it returns.
 */
export async function POST(request: Request) {
  if (!characterStudioEnabled()) return csFail("not_found", 404);
  const cross = rejectCrossOrigin(request);
  if (cross) return cross;
  const gate = await characterStudioGate();
  if (!gate.ok) return gate.response;
  const body = await readStudioBody(request);
  if (!body) return csFail("bad_request", 400);
  const input = parseId(body.input);
  const refs = Array.isArray(body.references) ? body.references.map(parseId) : [];
  const decl = body.declarations;
  if (!isModel(body.model) || !input || refs.length < 1 || refs.length > 30 || refs.some((r) => !r) || !decl || typeof decl !== "object") {
    return csFail("bad_request", 400);
  }
  // Exactly the five, each true: anything else is the database's refusal too, but it is never sent on the person's behalf.
  const d = decl as Record<string, unknown>;
  if (Object.keys(d).length !== DECLARATIONS.length || DECLARATIONS.some((k) => d[k] !== true)) return csFail("declarations_incomplete", 400);
  const { org, bad } = await resolveStudioOrg(body.org_id);
  if (bad) return csFail("bad_request", 400);
  if (!org) return csFail("org_required", 400);
  const { data, error } = await gate.supabase.rpc("record_character_swap_consent", {
    p_org: org,
    p_model: body.model,
    p_input: input,
    p_refs: refs,
    p_declarations: Object.fromEntries(DECLARATIONS.map((k) => [k, true])),
    p_version: CONSENT_VERSION,
  });
  if (error) return studioRefusal(error);
  const id = parseId((data as { id?: unknown } | null)?.id);
  if (!id) return csFail("failed", 502);
  return NextResponse.json({ consent_id: id }, { status: 201, headers: NO_STORE });
}
