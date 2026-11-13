import { MODEL_IDS, type ModelId, type SwapTemplate } from "@/lib/characterStudio/model";

type Sample = NonNullable<SwapTemplate["samples"][ModelId]>;

/** The models that really made a sample from this card's words, in the picker's order: an empty slot is never drawn. */
export function modelsWithSample(template: Pick<SwapTemplate, "samples">): { model: ModelId; sample: Sample }[] {
  return MODEL_IDS.flatMap((model) => {
    const sample = template.samples[model];
    return sample ? [{ model, sample }] : [];
  });
}

/** The gallery's cards: only those with at least one real sample. None: the gallery is not drawn at all (no "coming soon" wall). */
export function galleryTemplates<T extends Pick<SwapTemplate, "samples">>(templates: readonly T[]): T[] {
  return templates.filter((tpl) => modelsWithSample(tpl).length > 0);
}

/**
 * The models the picker lists: the ones this clip's quote prices, plus the checked one once it is settled (pressed by the person, or
 * placed by the first priced quote), so the checked model is never swapped out from under anyone; its cost line then says it is not
 * on sale and the button stays off. Before a quote: none, the picker asks for a video first.
 */
export function listedModels(
  quote: { models: readonly { model: ModelId; onSale: boolean }[] } | null,
  chosen: ModelId,
  keepChosen: boolean,
): ModelId[] {
  if (!quote) return [];
  return MODEL_IDS.filter((m) => quote.models.some((q) => q.model === m && q.onSale) || (keepChosen && m === chosen));
}
