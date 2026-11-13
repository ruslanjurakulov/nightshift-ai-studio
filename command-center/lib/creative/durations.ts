/**
 * How long a model's jobs have taken in one organization: the history the Studio's placeholder estimates a running
 * job's progress from (lib/creative/progress.ts). Read as the signed-in member (RLS: the org's members), never with
 * the service key; it reads times only — no prompt, no result, no price.
 */
import { isCreativeMissing, isUuid, type CreativeDb, type CreativeResult } from "@/lib/creative/operations";
import { MODEL_ID_RE } from "@/lib/models-admin";
import { DURATION_SAMPLES, durationsFrom } from "@/lib/creative/progress";

/** The most models one request may ask about: the feed asks only for the models of jobs still running. */
export const DURATION_MODELS_MAX = 4;

/** `?models=a,b` → the well-formed, distinct model ids (null when any is malformed or there are too many). */
export function parseModelList(raw: string | null): string[] | null {
  if (!raw) return null;
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > DURATION_MODELS_MAX) return null;
  return ids.every((id) => MODEL_ID_RE.test(id)) ? ids : null;
}

/**
 * `{ durations: { [model]: seconds[] } }`, newest first, at most DURATION_SAMPLES each. A model whose read failed is
 * left out (the placeholder then shows seconds, never a guessed percentage); a missing 0036 is creative_unavailable.
 */
export async function listDurations(db: CreativeDb, orgId: unknown, models: readonly string[]): Promise<CreativeResult> {
  if (!isUuid(orgId)) return { status: 400, body: { error: "org_required" } };
  if (!db.jobDurations) return { status: 200, body: { durations: {} } };
  const read = db.jobDurations.bind(db);
  const answers = await Promise.all(models.map(async (m) => [m, await read(orgId, m, DURATION_SAMPLES)] as const));
  if (answers.some(([, a]) => isCreativeMissing(a.error))) return { status: 503, body: { error: "creative_unavailable" } };
  const durations: Record<string, number[]> = {};
  for (const [m, a] of answers) if (!a.error) durations[m] = durationsFrom(a.data);
  return { status: 200, body: { durations } };
}
