/**
 * Which models a film the Brain drafts is made with: the SERVER's choice, never the model's (the LLM writes no model id; logic.ts
 * readSceneParts sets none). A new film has no default (create_film_draft sets none and no migration chooses one), so without this
 * every Brain draft was refused at the quote as "model_not_set".
 *
 * One fixed order per role, the first one on sale for that role right now (sellable_models, web) wins. Nothing outside the list is
 * ever taken: a model further down the catalogue is a quality decision a person makes in the film editor, not a fallback the server
 * makes (CLAUDE.md rule 4). None on sale: nothing is set, and quote_film's own "model_not_set" says what to do.
 *
 *   - Clips (i2v): MiniMax H3, then Kling v3 — the primary models in docs/FILM_STUDIO.md ("Models"). Both take a first and a last
 *     frame, and their longest shot (15 s and 10 s, registry durations_s) times max_shots covers the film's 30 s scene.
 *   - Key frames (t2i): the models that take the most reference pictures (docs/FILM_STUDIO.md: references reach a clip through its
 *     key frame, "the key-frame models take 10-16 of them"): GPT Image 2.6 Sunburst and Flare (16, no 18+ condition), then Gemini 3
 *     Pro Image and Nano Banana 2.1 (14, 18+ by their maker's terms, which the quote and start already enforce, 0192).
 * No Seedance model is in either list (docs/FILM_STUDIO.md: never accepted; film_check_model refuses it).
 */
export const FILM_MODEL_PREFERENCE = {
  clip: ["minimax-h3", "kling-v3"],
  keyframe: ["openai-gpt-image-2.6-sunburst", "openai-gpt-image-2.6-flare", "gemini-3-pro-image", "gemini-nano-banana-2.1"],
} as const;

export type FilmModelRole = keyof typeof FILM_MODEL_PREFERENCE;

/** `maxPromptChars`: the registry row's limits.max_prompt_chars (S9, 0218 counts it in UTF-16 units); absent or null = not known. */
export interface OnSaleModel { id: string; name: string; durations: number[]; maxPromptChars?: number | null; provider?: string | null }
export interface PickedModel { id: string; name: string; durations: number[] | null }

/** The first model of the role's order that is on sale now; null when none is (nothing else is tried). */
export function pickFilmModel(role: FilmModelRole, onSale: readonly OnSaleModel[]): PickedModel | null {
  for (const id of FILM_MODEL_PREFERENCE[role]) {
    const m = onSale.find((x) => x.id === id);
    if (m) {
      const d = m.durations.filter((x) => Number.isInteger(x) && x > 0).sort((a, b) => a - b);
      return { id: m.id, name: m.name || m.id, durations: d.length ? d : null };
    }
  }
  return null;
}

/** A model id as the BRIEF and the film store it; anything else is no model. */
export const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
