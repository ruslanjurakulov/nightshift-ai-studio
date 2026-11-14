import { isCreativeMissing, isUuid, type CreativeDb, type CreativeResult } from "@/lib/creative/operations";
import { RIGHTS_KINDS, parseStatus } from "@/lib/rights-acknowledgement";

/**
 * The two calls of the rights acknowledgement step (migration 0174), under the signed-in member's own session. The database
 * decides everything: who (auth.uid()), which organization (the file's), whether the version is the current one. These only
 * check the shape, call, and answer in the routes' words. Nothing here starts, prices or holds anything.
 */

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^[a-z_]{3,40}\.v[0-9]{1,4}$/;
const MAX_SUBJECTS = 4;

type DbError = { code?: string; message?: string; details?: string | null };

function answer(status: number, body: Record<string, unknown>): CreativeResult {
  return { status, body };
}

function refusal(error: DbError): CreativeResult {
  // Before 0174 is applied there is nothing to call, and nothing in the database asks either: said as it is.
  if (isCreativeMissing(error)) return answer(503, { error: "acknowledgement_unavailable" });
  const word = (error.message ?? "").trim();
  if (error.code === "42501") return answer(403, { error: "forbidden" });
  if (error.code === "NS409" && word === "acknowledgement_version_changed") {
    const m = /current=(\S+)/.exec(error.details ?? "");
    return answer(409, { error: "acknowledgement_version_changed", current: m ? m[1] : null });
  }
  if (error.code === "NS400" && word === "source_unavailable") return answer(422, { error: "source_unavailable" });
  if (error.code === "NS400") return answer(400, { error: "invalid_params" });
  return answer(502, { error: "failed" });
}

/** GET: which inputs of this model this person still has to acknowledge (rights_acknowledgement_status). */
export async function acknowledgementStatus(
  db: CreativeDb,
  input: { orgId: string | null; model: string | null; subjects: string[] },
): Promise<CreativeResult> {
  if (!isUuid(input.orgId)) return answer(400, { error: "org_required" });
  if (!input.model || !MODEL_RE.test(input.model)) return answer(400, { error: "invalid_params" });
  if (input.subjects.length > MAX_SUBJECTS || !input.subjects.every((s) => isUuid(s))) return answer(400, { error: "invalid_params" });
  const { data, error } = await db.rpc("rights_acknowledgement_status", {
    p_org: input.orgId,
    p_model: input.model,
    p_subjects: input.subjects,
  });
  if (error) return refusal(error);
  const parsed = parseStatus(data);
  // A malformed answer is never read as "nothing to acknowledge".
  if (!parsed) return answer(502, { error: "failed" });
  return answer(200, {
    required: parsed.required.map((r) => ({ kind: r.kind, text_version: r.textVersion })),
    missing: parsed.missing.map((m) => ({ kind: m.kind, text_version: m.textVersion, subject: m.subject })),
  });
}

/** POST body → the one acknowledgement to record, or why not. */
export function parseAcknowledgeInput(
  body: unknown,
): { ok: true; kind: string; textVersion: string; subject: string } | { ok: false; result: CreativeResult } {
  const o = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!o) return { ok: false, result: answer(400, { error: "invalid_body" }) };
  const { kind, text_version: textVersion, subject } = o;
  if (typeof kind !== "string" || !(RIGHTS_KINDS as readonly string[]).includes(kind)) return { ok: false, result: answer(400, { error: "invalid_params" }) };
  if (typeof textVersion !== "string" || !VERSION_RE.test(textVersion)) return { ok: false, result: answer(400, { error: "invalid_params" }) };
  if (!isUuid(subject)) return { ok: false, result: answer(400, { error: "invalid_params" }) };
  return { ok: true, kind, textVersion, subject: subject as string };
}

/** POST: record that THIS person takes responsibility for THIS input under THESE words (acknowledge_rights). */
export async function acknowledgeRights(
  db: CreativeDb,
  input: { kind: string; textVersion: string; subject: string },
): Promise<CreativeResult> {
  const { data, error } = await db.rpc("acknowledge_rights", {
    p_kind: input.kind,
    p_text_version: input.textVersion,
    p_subject: input.subject,
  });
  if (error) return refusal(error);
  const out = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
  const ack = out && typeof out.acknowledgement === "object" && out.acknowledgement !== null ? (out.acknowledgement as Record<string, unknown>) : null;
  if (!ack || ack.subject !== input.subject || ack.kind !== input.kind || ack.text_version !== input.textVersion) {
    return answer(502, { error: "failed" });
  }
  return answer(out!.replay === true ? 200 : 201, {
    acknowledgement: { kind: ack.kind, text_version: ack.text_version, subject: ack.subject, created_at: ack.created_at ?? null },
    replay: out!.replay === true,
  });
}
