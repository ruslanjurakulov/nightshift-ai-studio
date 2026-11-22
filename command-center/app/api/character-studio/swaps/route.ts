import { NextResponse } from "next/server";
import { rejectCrossOrigin } from "@/lib/server/same-origin";
import { NO_STORE, characterStudioGate, csFail, readStudioBody, resolveStudioOrg, studioPolicyRefusal, studioRefusal } from "@/lib/server/character-studio";
import { IDEM_RE, PROMPT_MAX, characterStudioEnabled, isModel, isResolution, parseId } from "@/lib/characterStudio/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ask for one swap (migration 0137's request_character_swap; NIGHTSHIFT_CHARACTER_STUDIO, default off: 404 first, then the same origin,
 * then the session). POST `{ org_id?, project_id?, input, references, prompt, model, resolution, consent_id, max_credits, idem }`.
 * The database checks the editor role, the consent, the prompt's screen, the vendor's input limits, the price (`not_on_sale` while it is
 * NULL; `price_changed` above max_credits, which is compared with the charge), the caps, and holds the credits. This route calls no vendor
 * and starts nothing: the worker does, after it claims the job.
 */
export async function POST(request: Request) {
  const policy = studioPolicyRefusal();
  if (policy) return policy;
  if (!characterStudioEnabled()) return csFail("not_found", 404);
  const cross = rejectCrossOrigin(request);
  if (cross) return cross;
  const gate = await characterStudioGate();
  if (!gate.ok) return gate.response;
  const body = await readStudioBody(request);
  if (!body) return csFail("bad_request", 400);
  const input = parseId(body.input);
  const consent = parseId(body.consent_id);
  const refs = Array.isArray(body.references) ? body.references.map(parseId) : [];
  const project = body.project_id === undefined || body.project_id === null ? null : parseId(body.project_id);
  const max = typeof body.max_credits === "number" && Number.isFinite(body.max_credits) && body.max_credits >= 0 && body.max_credits <= 100000 ? body.max_credits : null;
  if (
    !input ||
    !consent ||
    refs.length < 1 ||
    refs.length > 30 ||
    refs.some((r) => !r) ||
    (body.project_id != null && !project) ||
    typeof body.prompt !== "string" ||
    body.prompt.length > PROMPT_MAX ||
    !isModel(body.model) ||
    !isResolution(body.resolution) ||
    max === null ||
    typeof body.idem !== "string" ||
    !IDEM_RE.test(body.idem)
  ) {
    return csFail("bad_request", 400);
  }
  const { org, bad } = await resolveStudioOrg(body.org_id);
  if (bad) return csFail("bad_request", 400);
  if (!org) return csFail("org_required", 400);
  const { data, error } = await gate.supabase.rpc("request_character_swap", {
    p_org: org,
    p_project: project,
    p_input: input,
    p_refs: refs,
    p_prompt: body.prompt,
    p_model: body.model,
    p_resolution: body.resolution,
    p_consent: consent,
    p_max_credits: max,
    p_idem: body.idem,
  });
  if (error) return studioRefusal(error);
  const out = data as { id?: unknown; status?: unknown; credits?: unknown; hold?: unknown; replayed?: unknown } | null;
  const id = parseId(out?.id);
  if (!id) return csFail("failed", 502);
  return NextResponse.json(
    {
      id,
      status: typeof out?.status === "string" ? out.status : "requested",
      credits: typeof out?.credits === "number" ? out.credits : null,
      hold: typeof out?.hold === "number" ? out.hold : null,
      replayed: out?.replayed === true,
    },
    { status: out?.replayed === true ? 200 : 201, headers: NO_STORE },
  );
}
