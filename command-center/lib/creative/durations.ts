/**
 * How long a model's jobs have taken in one organization: the history the Studio's placeholder estimates a running
 * job's progress from (lib/creative/progress.ts). Read as the signed-in member (RLS: the org's members), never with
 * the service key; it reads times only — no prompt, no result, no price. For a model with too little history here it
 * also reads the platform's test run of the model (0151 model_probe_seconds, the member's own session again).
 */
import { isCreativeMissing, isUuid, type CreativeDb, type CreativeResult } from "@/lib/creative/operations";
import { MODEL_ID_RE } from "@/lib/models-admin";
import { DURATION_SAMPLES, MIN_SAMPLES, durationsFrom, seedsFrom } from "@/lib/creative/progress";

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
 * `{ durations: { [model]: seconds[] }, seeds?: { [model]: ProbeSeed } }`, durations newest first, at most
 * DURATION_SAMPLES each. A model whose read failed is left out (the placeholder then shows seconds, never a guessed
 * percentage); a missing 0036 is creative_unavailable.
 *
 * `seeds` is asked for only the models whose history was READ and is shorter than MIN_SAMPLES (an unread history is
 * not "too little", and a model with enough history never uses one), in one call. It is present only when that call
 * answered: without 0151 (the function is missing) or on any other error it is left out, and the pill counts seconds
 * as it did before 0151 — never a seed guessed from anything else.
 */
export async function listDurations(db: CreativeDb, orgId: unknown, models: readonly string[]): Promise<CreativeResult> {
  if (!isUuid(orgId)) return { status: 400, body: { error: "org_required" } };
  if (!db.jobDurations) return { status: 200, body: { durations: {} } };
  const read = db.jobDurations.bind(db);
  const answers = await Promise.all(models.map(async (m) => [m, await read(orgId, m, DURATION_SAMPLES)] as const));
  if (answers.some(([, a]) => isCreativeMissing(a.error))) return { status: 503, body: { error: "creative_unavailable" } };
  const durations: Record<string, number[]> = {};
  for (const [m, a] of answers) if (!a.error) durations[m] = durationsFrom(a.data);
  const short = models.filter((m) => durations[m] !== undefined && durations[m]!.length < MIN_SAMPLES);
  if (short.length === 0) return { status: 200, body: { durations } };
  const seeded = await db.rpc("model_probe_seconds", { p_models: short });
  if (seeded.error) return { status: 200, body: { durations } };
  return { status: 200, body: { durations, seeds: seedsFrom(seeded.data, short) } };
}
