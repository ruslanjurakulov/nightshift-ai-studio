"use client";

import { useId, useRef } from "react";
import { useI18n } from "@/lib/i18n/context";
import { captionsOf, type CaptionStyle } from "@/lib/captions";
import {
  CAPTION_SIZE_MAX,
  CAPTION_SIZE_MIN,
  CAPTION_STYLES,
  CAPTION_Y_MAX,
  CAPTION_Y_MIN,
  isCaptionStyleId,
  styleDef,
  type CaptionStyleId,
  type CaptionTweak,
} from "@/lib/captionStyleTable";
import {
  activeCaptionStyle,
  applyCaptionStyle,
  clearCaptionStyle,
  setCaptionTweak,
} from "@/lib/captionStyles";
import type { EditorModel } from "@/lib/editor";

const quietBtn =
  "btn-sky is-quiet pill inline-flex min-h-11 items-center gap-1.5 px-3 py-1.5 text-xs";

/**
 * Ready-made animated caption styles: one press puts one on every caption,
 * then colour, highlight colour, size and position can be changed. Free, local,
 * and nothing is saved until the project is. The export draws the style
 * exactly; the preview approximates it, and the note under the choices says so.
 */
export function CaptionStylesPicker({
  model,
  onChange,
}: {
  model: EditorModel;
  onChange: (next: EditorModel, group?: string) => void;
}) {
  const { t, fmt } = useI18n();
  const ta = t.captions.animated;
  const id = useId();
  const gesture = useRef(0);
  const current = captionsOf(model);
  const hasCues = (current?.cues.length ?? 0) > 0;
  const active = activeCaptionStyle(model);
  const style: CaptionStyle | null = current?.style ?? null;
  const uses = active ? styleDef(active).uses : [];

  const startGesture = () => {
    gesture.current += 1;
  };
  const tweak = (k: CaptionTweak, value: string | number) =>
    onChange(setCaptionTweak(model, k, value), `caption-${k}-${gesture.current}`);

  const choose = (next: CaptionStyleId | null) => {
    if (!hasCues) return;
    onChange(next ? applyCaptionStyle(model, next) : clearCaptionStyle(model));
  };

  return (
    <div className="flex flex-col gap-2" data-testid="caption-styles">
      <h3 id={`${id}-h`} className="m-0 text-sm font-semibold">
        {ta.heading}
      </h3>
      <p className="m-0 text-xs text-[var(--color-muted)]">{ta.hint}</p>
      {hasCues ? null : (
        <p className="m-0 text-xs text-[var(--color-muted)]">{ta.needCues}</p>
      )}
      <div
        role="radiogroup"
        aria-labelledby={`${id}-h`}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      >
        <button
          type="button"
          role="radio"
          aria-checked={hasCues && active === null}
          disabled={!hasCues}
          onClick={() => choose(null)}
          className={`flex min-h-11 flex-col gap-0.5 rounded-xl border p-2 text-left text-xs disabled:opacity-50 ${
            hasCues && active === null
              ? "border-[var(--color-primary)]"
              : "border-[var(--color-border)]"
          }`}
        >
          <span className="font-semibold">{ta.plain}</span>
          <span className="text-xs text-[var(--color-muted)]">{ta.plainNote}</span>
        </button>
        {CAPTION_STYLES.map((s) => {
          const on = active === s.id;
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!hasCues}
              onClick={() => choose(s.id)}
              className={`flex min-h-11 flex-col gap-0.5 rounded-xl border p-2 text-left text-xs disabled:opacity-50 ${
                on ? "border-[var(--color-primary)]" : "border-[var(--color-border)]"
              }`}
            >
              <span
                aria-hidden
                className="font-semibold"
                style={{
                  color: s.color,
                  textShadow: "0 0 2px #000, 0 0 3px #000",
                  borderBottom: `3px solid ${s.highlight_color}`,
                  alignSelf: "flex-start",
                }}
              >
                {ta.sample}
              </span>
              <span className="font-semibold">{ta.styles[s.id]}</span>
              <span className="text-xs text-[var(--color-muted)]">{ta.notes[s.id]}</span>
            </button>
          );
        })}
      </div>

      {active && style ? (
        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-testid="caption-tweaks">
          <legend className="mb-1 p-0 text-xs text-[var(--color-muted)]">
            {fmt(ta.current, { name: ta.styles[active] })}
          </legend>
          <div className="flex flex-wrap gap-3">
            {uses.includes("color") ? (
              <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
                {ta.tweaks.color}
                <input
                  type="color"
                  value={(style.color ?? "#FFFFFF").toLowerCase()}
                  onFocus={startGesture}
                  onChange={(e) => tweak("color", e.target.value)}
                  className="h-11 w-16 cursor-pointer rounded-lg border border-[var(--color-border)] bg-transparent p-1"
                />
              </label>
            ) : null}
            {uses.includes("highlight_color") ? (
              <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
                {ta.tweaks.highlight_color}
                <input
                  type="color"
                  value={(style.highlight_color ?? styleDef(active).highlight_color).toLowerCase()}
                  onFocus={startGesture}
                  onChange={(e) => tweak("highlight_color", e.target.value)}
                  className="h-11 w-16 cursor-pointer rounded-lg border border-[var(--color-border)] bg-transparent p-1"
                />
              </label>
            ) : null}
          </div>
          {uses.includes("size") ? (
            <label className="flex min-w-0 flex-col text-xs text-[var(--color-muted)]">
              <span className="flex items-baseline justify-between gap-2">
                <span>{ta.tweaks.size}</span>
                <span className="tabular-nums text-[var(--color-fg)]" aria-hidden>
                  {style.size}
                </span>
              </span>
              <input
                type="range"
                aria-label={ta.tweaks.size}
                min={CAPTION_SIZE_MIN}
                max={CAPTION_SIZE_MAX}
                step={1}
                value={Math.min(CAPTION_SIZE_MAX, Math.max(CAPTION_SIZE_MIN, style.size))}
                aria-valuetext={String(style.size)}
                onPointerDown={startGesture}
                onKeyDown={(e) => {
                  if (!e.repeat) startGesture();
                }}
                onChange={(e) => tweak("size", Number(e.target.value))}
                className="h-11 w-full min-w-0 accent-[var(--color-primary)]"
              />
            </label>
          ) : null}
          {uses.includes("y") ? (
            <label className="flex min-w-0 flex-col text-xs text-[var(--color-muted)]">
              <span className="flex items-baseline justify-between gap-2">
                <span>{ta.tweaks.y}</span>
                <span className="tabular-nums text-[var(--color-fg)]" aria-hidden>
                  {Math.round(style.y * 100)}%
                </span>
              </span>
              <input
                type="range"
                aria-label={ta.tweaks.y}
                min={CAPTION_Y_MIN}
                max={CAPTION_Y_MAX}
                step={0.01}
                value={Math.min(CAPTION_Y_MAX, Math.max(CAPTION_Y_MIN, style.y))}
                aria-valuetext={fmt(ta.tweaks.yValue, { n: Math.round(style.y * 100) })}
                onPointerDown={startGesture}
                onKeyDown={(e) => {
                  if (!e.repeat) startGesture();
                }}
                onChange={(e) => tweak("y", Number(e.target.value))}
                className="h-11 w-full min-w-0 accent-[var(--color-primary)]"
              />
            </label>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => isCaptionStyleId(active) && choose(active)}
              className={quietBtn}
            >
              {ta.reset}
            </button>
          </div>
        </fieldset>
      ) : null}
      <p className="m-0 text-xs text-[var(--color-muted)]">{ta.previewNote}</p>
    </div>
  );
}
