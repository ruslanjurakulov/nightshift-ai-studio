"use client";

import { Clock } from "lucide-react";
import { fmt } from "@/lib/i18n";
import type { CharacterStudioDictionary } from "@/lib/i18n/character-studio";
import { MODEL_FACTS, MODEL_IDS, type SwapTemplate } from "@/lib/characterStudio/model";

/**
 * One gallery card (docs/CHARACTER_STUDIO.md, "Samples"): the example's title, one slot per model with the sample that model made from
 * this card's own words, and "Try", which opens the studio with those words. A slot with no sample yet says so ("Namuna tez orada"):
 * making one is a paid call the owner has not approved, and an empty slot never borrows another model's clip.
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
        <span className="cs-small">{fmt(t.gallery.characters, { n: template.characters })}</span>
      </div>
      <ul className="cs-samples">
        {MODEL_IDS.map((model) => {
          const sample = template.samples[model];
          const name = MODEL_FACTS[model].name;
          return (
            <li key={model} className="cs-sample" data-model={model} data-empty={sample ? undefined : "true"}>
              {sample ? (
                <video className="cs-sample-video" src={sample.webUrl} poster={sample.posterUrl ?? undefined} controls muted playsInline preload="none" />
              ) : (
                <div className="cs-sample-empty" role="img" aria-label={t.gallery.sampleSoon}>
                  <Clock aria-hidden="true" size={20} />
                  <span>{t.gallery.sampleSoon}</span>
                </div>
              )}
              <p className="cs-small">{fmt(t.gallery.sampleOf, { model: name })}</p>
            </li>
          );
        })}
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
