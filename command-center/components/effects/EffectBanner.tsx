"use client";

import Link from "next/link";
import { useId } from "react";
import { ArrowLeft } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { EFFECTS_DESK_SECTION, SUBJECT_MAX, type Effect, type EffectAvailability } from "@/lib/effects/catalog";
import { EffectFrame } from "@/components/effects/EffectFrame";
import { shapeText } from "@/components/effects/EffectsDesk";
import "@/components/effects/effects.css";

/**
 * Over the composer an effect opened (/create?tool=…&effect=…): which effect, the model it put in the form and why that one, and
 * what is still the person's to add — the subject (a short GET form that puts it into the description, a link and nothing more)
 * or the picture (picked in the composer below). The composer under it is the ordinary one: its price and its Generate.
 *
 * With no model of the effect open here it says so and the page shows no composer filled for it (app/(app)/[channel]/create):
 * the effect is never quietly run on some other model (CLAUDE.md #4, #5).
 */
export function EffectBanner({ effect, availability, subject }: { effect: Effect; availability: EffectAvailability; subject: string }) {
  const { t } = useI18n();
  const fx = t.effects;
  const copy = fx.items[effect.id];
  const path = useChannelPath();
  const titleId = useId();
  const fieldId = useId();
  const hintId = useId();

  if (availability.state === "unavailable") {
    return (
      <section aria-labelledby={titleId} className="fx-banner" data-effect={effect.id} data-state="unavailable">
        <EffectFrame effect={effect} label={fx} className="fx-frame fx-banner-art" />
        <div className="fx-banner-body">
          <p className="fx-kind">{fx.banner.label}</p>
          <h2 id={titleId} className="fx-name">
            {copy.name}: {fx.banner.unavailableTitle}
          </h2>
          <p className="fx-line">{fx.banner.unavailableBody}</p>
          <div className="fx-banner-links">
            <Link href={path(EFFECTS_DESK_SECTION)} className="fx-use">
              <ArrowLeft aria-hidden className="size-4" />
              {fx.banner.all}
            </Link>
            <Link href={path(`/create?tool=${effect.capability}`)} className="tap-link self-center text-sm">
              {fx.banner.plainTool}
            </Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby={titleId} className="fx-banner" data-effect={effect.id} data-state="ready">
      <EffectFrame effect={effect} label={fx} className="fx-frame fx-banner-art" />
      <div className="fx-banner-body">
        <p className="fx-kind">
          {fx.banner.label} · {fx.kinds[effect.capability]}
        </p>
        <h2 id={titleId} className="fx-name">
          {copy.name}
        </h2>
        <p className="fx-line">{copy.line}</p>
        <ul className="fx-facts">
          <li className="fx-chip" data-tone={availability.preview ? "preview" : undefined} data-model={availability.modelId}>
            {fmt(fx.banner.model, { model: availability.modelName })}
            {availability.preview && <> · {fx.desk.preview}</>}
          </li>
          <li className="fx-chip">
            <span className="fx-chip-key">{fx.desk.shape}</span> {shapeText(t, effect, availability)}
          </li>
          <li className="fx-chip">
            <span className="fx-chip-key">{fx.desk.length}</span> {fmt(fx.desk.seconds, { n: effect.duration })}
          </li>
        </ul>
        {availability.rank > 0 && <p className="fx-note">{fx.desk.nextChoice}</p>}
        {effect.input === "none" ? (
          // A GET form: it only reopens this page with the words in the address, which fills the description. Nothing is sent anywhere else.
          <form method="get" action={path("/create")} className="fx-banner-form">
            <input type="hidden" name="tool" value={effect.capability} />
            <input type="hidden" name="effect" value={effect.id} />
            <label htmlFor={fieldId}>
              {copy.subject}
              <input
                id={fieldId}
                name="subject"
                type="text"
                className="ns-field"
                defaultValue={subject}
                placeholder={copy.example}
                maxLength={SUBJECT_MAX}
                autoComplete="off"
                aria-describedby={hintId}
              />
            </label>
            <button type="submit" className="fx-use">
              {fx.banner.apply}
            </button>
            <p id={hintId} className="fx-note basis-full">
              {fx.banner.subjectHint}
            </p>
          </form>
        ) : (
          <p className="fx-note">
            {fx.banner.pictureHint} {copy.picture}
          </p>
        )}
        <p className="fx-note">{fx.banner.promptNote}</p>
        <p className="fx-note">{fx.banner.priceNote}</p>
        <div className="fx-banner-links">
          <Link href={path(EFFECTS_DESK_SECTION)} className="tap-link inline-flex items-center gap-1 text-sm">
            <ArrowLeft aria-hidden className="size-4" />
            {fx.banner.all}
          </Link>
        </div>
      </div>
    </section>
  );
}
