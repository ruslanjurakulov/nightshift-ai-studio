import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSellableModels } from "@/lib/creative/registry";
import { FILM, type ClipShape } from "@/lib/brain/logic";
import type { OnSaleModel } from "@/lib/brain/film-models";

/**
 * The models on sale for a film's two roles right now, read server-side as the person from the catalogue the Studio reads
 * (sellable_models, web): clips (i2v) and key frames (t2i). The server picks from these (lib/brain/film-models), names them on the
 * plan card, and reads the clip model's shot lengths (spec.durations_s), which quote_film prices a scene's shots against (0171).
 *
 * `keyframeEdit` is the edit catalogue: 0166 film_check_model takes a t2i OR an edit model as a film's keyframe_model, so a film may
 * be drafted with one the server would never pick (Breach BR-S1-07). Its name and prompt limit are read from there; the server's
 * own pick is only ever from `keyframe` (t2i), in its fixed order.
 *
 * A read that fails is not "nothing on sale": it is `ok: false`, and the plan is not begun (a pick from a list that could not be read
 * would be a guess). The database checks again anyway: create_film_draft refuses a model that is not on sale (film_check_model).
 */
export type FilmCatalogue = { ok: true; clip: OnSaleModel[]; keyframe: OnSaleModel[]; keyframeEdit: OnSaleModel[] } | { ok: false };

export async function filmCatalogue(supabase: SupabaseClient): Promise<FilmCatalogue> {
  const [clip, keyframe, edit] = await Promise.all([
    readSellableModels(supabase, "i2v", "web"), readSellableModels(supabase, "t2i", "web"), readSellableModels(supabase, "edit", "web"),
  ]);
  if (clip.status !== "ok" || keyframe.status !== "ok" || edit.status !== "ok") return { ok: false };
  const rows = (models: typeof clip.models): OnSaleModel[] =>
    models.map((m) => ({ id: m.id, name: m.displayName, durations: m.spec.durationsS, maxPromptChars: m.spec.maxPromptChars }));
  return { ok: true, clip: rows(clip.models), keyframe: rows(keyframe.models), keyframeEdit: rows(edit.models) };
}

/**
 * The longest scene prompt the film's two models take, from their registry rows (limits.max_prompt_chars, S9 / 0218): a scene's one
 * prompt makes its key frame and then its clip, so the smaller of the two. A model not in the catalogue (none picked, or no longer on
 * sale) adds nothing; neither known is null, and the film's own 2000 (film_limits.max_prompt_chars, planLimits) is the limit.
 * Never a number typed here: the registry is the only source.
 */
export function promptLimitOf(catalogue: { clip: OnSaleModel[]; keyframe: OnSaleModel[]; keyframeEdit?: OnSaleModel[] }, clipModel: unknown,
                              keyframeModel: unknown): number | null {
  const limit = (list: OnSaleModel[], id: unknown) => {
    const v = typeof id === "string" && id ? list.find((m) => m.id === id)?.maxPromptChars : null;
    return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
  };
  const known = [limit(catalogue.clip, clipModel), limit([...catalogue.keyframe, ...(catalogue.keyframeEdit ?? [])], keyframeModel)]
    .filter((v): v is number => v !== null);
  return known.length ? Math.min(...known) : null;
}

/**
 * What a film's clip model makes (S1_GAPS G4), from the catalogue: its shot lengths, or `durations: null` when it is not known — no
 * clip model, one no longer on sale, or a spec that lists none. Nothing is split on a guess then (rule 5); the quote's own refusal
 * ("model_not_set", "model_not_available", "scene_too_long_for_model") is what the person reads.
 */
export function clipShapeOf(catalogue: OnSaleModel[], model: unknown, maxShots: unknown): ClipShape {
  const shots = typeof maxShots === "number" && Number.isInteger(maxShots) && maxShots >= 1 ? maxShots : FILM.maxShots;
  const found = typeof model === "string" && model ? catalogue.find((m) => m.id === model) : undefined;
  const list = (found?.durations ?? []).filter((d) => Number.isInteger(d) && d > 0).sort((a, b) => a - b);
  return { durations: list.length ? list : null, maxShots: shots };
}
