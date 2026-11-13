"use client";

import { fmt } from "@/lib/i18n";
import type { CharacterStudioDictionary } from "@/lib/i18n/character-studio";
import { MODEL_FACTS, type SwapTemplate } from "@/lib/characterStudio/model";
import { pluralText } from "@/lib/plural";
import { modelsWithSample } from "@/components/character-studio/samples";

/**
 * One gallery card (docs/CHARACTER_STUDIO.md, "Samples"): the example's title, the samples the models made from this card's own
 * words, and "Try", which opens the studio with those words. Only a model with a real sample has a slot: four "Sample coming soon"
 * tiles read as a page that was never finished, and an empty slot never borrows another model's clip. A card with no sample at all is
 * not drawn (CharacterStudio filters it).
 *
 * A sample plays from the public CDN (its web copy; the original stays in the private bucket). It is muted and never autoplays.
 */
export function TemplateCard({
  template,
  locale,
  t,
  onTry,
}: {
  template: SwapTemplate;
  locale: string;
  t: CharacterStudioDictionary;
  onTry: (prompt: string, characters: number) => void;
}) {
  const title = locale === "ru" ? template.title.ru : locale === "uz" ? template.title.uz : template.title.en;
  return (
    <li className="cs-card" data-template={template.slug}>
      <div className="cs-card-head">
        <h3 className="cs-h3">{title}</h3>
        <span className="cs-small">{pluralText(t.gallery.characters, template.characters, locale)}</span>
      </div>
      <ul className="cs-samples">
        {modelsWithSample(template).map(({ model, sample }) => (
          <li key={model} className="cs-sample" data-model={model}>
            <video className="cs-sample-video" src={sample.webUrl} poster={sample.posterUrl ?? undefined} controls muted playsInline preload="none" />
            <p className="cs-small">{fmt(t.gallery.sampleOf, { model: MODEL_FACTS[model].name })}</p>
          </li>
        ))}
      </ul>
      <p className="cs-small">{template.prompt}</p>
      <div className="cs-actions">
        <button type="button" className="btn-primary min-h-11 px-4 text-sm" title={t.gallery.tryHint} onClick={() => onTry(template.prompt, template.characters)}>
          {t.gallery.try}
        </button>
      </div>
    </li>
  );
}
