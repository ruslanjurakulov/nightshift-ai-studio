"use client";

import Link from "next/link";
import { useId } from "react";
import { ArrowRight } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { EFFECTS, effectSection, resolveEffect, type Effect, type EffectAvailability } from "@/lib/effects/catalog";
import type { StudioModel } from "@/lib/creative/studio";
import { EffectFrame } from "@/components/effects/EffectFrame";
import "@/components/effects/effects.css";

/** The shape an effect's clip comes out in, as the card says it: the picture's, the model's own, or the effect's. */
export function shapeText(t: Dictionary, effect: Pick<Effect, "input" | "aspect">, a: EffectAvailability): string {
  if (effect.input === "picture") return t.effects.desk.pictureShape;
  if (a.state === "ready" && a.fixedShape) return t.effects.desk.ownShape;
  return effect.aspect;
}

/**
 * The Studio's Effects desk: every effect as a card with its sample (or a drawing that says it is one), its name and line, the
 * model it will use HERE and its shape and length, and "Use this effect".
 *
 * The model is the first of the effect's models that this workspace is offered (lib/effects/catalog.ts resolveEffect, over the
 * same `models` the composer gets). When none is, the card says the effect is not open here and its button is disabled: nothing
 * is shown as available that is not, and no other model is put in its place. A card is a link and nothing more: this desk prices,
 * holds and starts nothing (CLAUDE.md #3); the composer it opens shows the price before Generate.
 */
export function EffectsDesk({ models, effects = EFFECTS }: { models: StudioModel[]; effects?: readonly Effect[] }) {
  const { t } = useI18n();
  const fx = t.effects;
  const path = useChannelPath();
  const headId = useId();
  return (
    <section aria-labelledby={headId} className="flex flex-col gap-4">
      <h2 id={headId} className="sr-only">
        {fx.desk.title}
      </h2>
      <ul className="fx-grid" aria-label={fx.desk.listLabel}>
        {effects.map((e) => (
          <EffectCard key={e.id} effect={e} a={resolveEffect(e, models)} href={path(effectSection(e))} />
        ))}
      </ul>
      <p className="m-0 text-xs text-[var(--color-muted)]">{fx.desk.note}</p>
    </section>
  );
}

function EffectCard({ effect, a, href }: { effect: Effect; a: EffectAvailability; href: string }) {
  const { t } = useI18n();
  const fx = t.effects;
  const copy = fx.items[effect.id];
  const noteId = useId();
  const ready = a.state === "ready";
  return (
    <li>
      <article className="fx-card" data-effect={effect.id} data-state={a.state}>
        <EffectFrame effect={effect} label={fx} />
        <div className="fx-body">
          <p className="fx-kind">
            {fx.kinds[effect.capability]} · {fx.needs[effect.input]}
          </p>
          <h3 className="fx-name">{copy.name}</h3>
          <p className="fx-line">{copy.line}</p>
          <ul className="fx-facts">
            {ready ? (
              <li className="fx-chip" data-tone={a.preview ? "preview" : undefined} data-model={a.modelId}>
                <span className="fx-chip-key">{fx.desk.model}</span> {a.modelName}
                {a.preview && <> · {fx.desk.preview}</>}
              </li>
            ) : (
              <li className="fx-chip" data-tone="off">
                {fx.desk.unavailable}
              </li>
            )}
            <li className="fx-chip">
              <span className="fx-chip-key">{fx.desk.shape}</span> {shapeText(t, effect, a)}
            </li>
            <li className="fx-chip">
              <span className="fx-chip-key">{fx.desk.length}</span> {fmt(fx.desk.seconds, { n: effect.duration })}
            </li>
          </ul>
          {ready && a.rank > 0 && <p className="fx-note">{fx.desk.nextChoice}</p>}
          {ready && a.preview && <p className="fx-note">{fx.desk.previewNote}</p>}
          {ready ? (
            <Link href={href} className="fx-use" aria-label={fmt(fx.desk.useAria, { name: copy.name })}>
              {fx.desk.use}
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          ) : (
            <>
              <p id={noteId} className="fx-note">
                {fx.desk.unavailableNote}
              </p>
              {/* A real disabled button, not a link that goes nowhere: nothing can be started from an effect that is not open here. */}
              <button type="button" className="fx-use" disabled aria-describedby={noteId}>
                {fx.desk.use}
              </button>
            </>
          )}
        </div>
      </article>
    </li>
  );
}
