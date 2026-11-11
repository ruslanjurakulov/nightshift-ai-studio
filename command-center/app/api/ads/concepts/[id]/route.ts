import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { NO_STORE, adsFail, adsGate, adsRefusal, readAdsBody } from "@/lib/server/ads-factory";
import { parseAdsId, parseConceptEdit, parseStatus } from "@/lib/adsFactory/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Change one concept. PATCH with `{ status }` alone moves it between draft, approved and archived; PATCH with
 * `{ headline, body?, cta?, visual_brief?, storyboard? }` replaces the words of a DRAFT. One or the other, never both in one request,
 * so "approved" is always an approval of words that were already saved.
 *
 * Approving records who and when, and STARTS NOTHING: no picture, no video, no job, no credit, no publish (CLAUDE.md rule 3). The
 * database refuses an edit of a concept that is not a draft (`concept_not_draft`) and an archived concept approved without going back
 * to draft (`invalid_transition`).
 */
export const PATCH = requireSameOrigin(async function PATCH(request: Request, { params }: Ctx) {
  const gate = await adsGate();
  if (!gate.ok) return gate.response;
  const id = parseAdsId((await params).id);
  if (!id) return adsFail("bad_request", 400);
  const body = await readAdsBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) return adsFail("bad_request", 400);
  const b = body as Record<string, unknown>;

  if ("status" in b) {
    if (Object.keys(b).length !== 1) return adsFail("bad_request", 400);
    const status = parseStatus(b.status);
    if (!status) return adsFail("invalid_status", 400);
    const { data, error } = await gate.supabase.rpc("set_ad_concept_status", { p_concept: id, p_status: status });
    if (error) return adsRefusal(error);
    if (data !== status) return adsFail("failed", 502);
    return NextResponse.json({ id, status }, { headers: NO_STORE });
  }

  const input = parseConceptEdit(b);
  if (!input.ok) return adsFail(input.error, 400);
  const { data, error } = await gate.supabase.rpc("update_ad_concept", {
    p_concept: id,
    p_headline: input.value.headline,
    p_body: input.value.body,
    p_cta: input.value.cta,
    p_visual_brief: input.value.visualBrief,
    p_storyboard: input.value.storyboard,
  });
  if (error) return adsRefusal(error);
  if (data !== true) return adsFail("failed", 502);
  return NextResponse.json({ id }, { headers: NO_STORE });
});

/** Delete one concept. It frees one place under the campaign's cap. */
export const DELETE = requireSameOrigin(async function DELETE(_request: Request, { params }: Ctx) {
  const gate = await adsGate();
  if (!gate.ok) return gate.response;
  const id = parseAdsId((await params).id);
  if (!id) return adsFail("bad_request", 400);
  const { data, error } = await gate.supabase.rpc("delete_ad_concept", { p_concept: id });
  if (error) return adsRefusal(error);
  if (data !== true) return adsFail("failed", 502);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
});
