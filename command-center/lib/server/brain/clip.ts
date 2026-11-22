import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSellableModels } from "@/lib/creative/registry";
import { FILM, type ClipShape } from "@/lib/brain/logic";

/**
 * What a film's clip model makes (S1_GAPS G4): the shot lengths its spec lists (spec.durations_s), read server-side as the person
 * from the same catalogue the Studio reads (sellable_models, i2v, web). quote_film prices a scene's shots against the same list
 * (0171), so a plan within it is one the quote can price.
 *
 * `durations: null` when it is not known: the film has no clip model (create_film_draft sets none, and 0166/0171/0198 choose no
 * default), the model is not on sale here, its spec lists no lengths, or the catalogue could not be read. Nothing is split on a
 * guess then (rule 5), and the quote's own refusal is what the person reads.
 */
export async function clipShape(supabase: SupabaseClient, model: unknown, maxShots: unknown): Promise<ClipShape> {
  const shots = typeof maxShots === "number" && Number.isInteger(maxShots) && maxShots >= 1 ? maxShots : FILM.maxShots;
  if (typeof model !== "string" || !model) return { durations: null, maxShots: shots };
  const read = await readSellableModels(supabase, "i2v", "web");
  if (read.status !== "ok") return { durations: null, maxShots: shots };
  const found = read.models.find((m) => m.id === model);
  const list = (found?.spec.durationsS ?? []).filter((d) => Number.isInteger(d) && d > 0).sort((a, b) => a - b);
  return { durations: list.length ? list : null, maxShots: shots };
}
