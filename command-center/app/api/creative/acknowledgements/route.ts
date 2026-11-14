import { NextResponse } from "next/server";
import { creativeSession } from "@/lib/server/creative";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";
import { isUuid } from "@/lib/creative/operations";
import { acknowledgeRights, acknowledgementStatus, parseAcknowledgeInput } from "@/lib/creative/acknowledgements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The rights acknowledgement step (migration 0174, docs/RIGHTS_ACKNOWLEDGEMENT.md).
 *
 * GET `?org_id=&model=&subjects=<uuid>,<uuid>`: the kinds the model requires, at which text version, and which inputs THIS
 * person has not acknowledged yet (rights_acknowledgement_status). Reads only the caller's own rows.
 *
 * POST `{ kind, text_version, subject }`: records that the signed-in person takes responsibility for the input `subject` (a
 * media asset of an organization they belong to) under the words of `text_version` (acknowledge_rights). The database records
 * who from the session, refuses a version that is not the current one (409 acknowledgement_version_changed) and another
 * organization's file exactly like a missing one (422 source_unavailable). A replay answers the first row (200).
 *
 * Neither starts, prices or holds anything. create_creative_job is what refuses a job without the acknowledgement.
 */
export async function GET(request: Request) {
  const session = await creativeSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  const q = new URL(request.url).searchParams;
  const org = q.get("org_id");
  const raw = q.get("subjects") ?? "";
  const subjects = raw.trim() === "" ? [] : raw.split(",").map((s) => s.trim());
  const out = await acknowledgementStatus(session.db, {
    orgId: isUuid(org) ? org : session.defaultOrg,
    model: q.get("model"),
    subjects,
  });
  return NextResponse.json(out.body, { status: out.status, headers: { "cache-control": "no-store" } });
}

export const POST = requireSameOrigin(async function POST(request: Request) {
  const session = await creativeSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  let body: unknown;
  try {
    body = await parseJsonCapped(request);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = parseAcknowledgeInput(body);
  if (!parsed.ok) return NextResponse.json(parsed.result.body, { status: parsed.result.status });
  // No app_audit_log row: rights_acknowledgements IS the record (append-only, who from the session), and 0087's audit list
  // would refuse an action name it does not have.
  const out = await acknowledgeRights(session.db, parsed);
  return NextResponse.json(out.body, { status: out.status });
});
