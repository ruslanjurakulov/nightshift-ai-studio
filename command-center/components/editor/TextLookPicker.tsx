"use client";

import { useId } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { TEXT_COLOR, type TextClip } from "@/lib/editor";
import { TEXT_LOOKS, textLookOf } from "@/lib/editorTextLook";
import { previewBoxStyle, previewTextStyle } from "@/lib/editorTextLookPreview";

/**
 * The text's look: one radio per ready look (lib/editorTextLook.ts), each a
 * key at least 44px tall in a two-column grid with a small sample of the look
 * drawn with the same CSS the editor's preview uses. A look is only values for
 * fields the text already has; choosing one is one undo step. No look is lit
 * for a text that has been changed by hand ("Custom").
 */

/** The sample swatch is a 44px-wide "frame" (w-11) and its letters 17px tall in it:
 *  every size of a look is scaled by the same ratio. */
const SWATCH_PX = 44;
const SAMPLE_FONT_PX = 17;

export function TextLookPicker({
  text,
  onPick,
}: {
  text: TextClip;
  onPick: (lookId: string) => void;
}) {
  const { t } = useI18n();
  const lk = t.editor.looks;
  const id = useId();
  const current = textLookOf(text);
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
      aria-describedby={`${id}-hint`}
      data-testid="text-look"
    >
      <legend className="mb-1 p-0 text-xs text-[var(--color-muted)]">
        {lk.lookLegend}
      </legend>
      <div
        className="grid gap-1.5"
        // as many 10rem columns as fit: one on a 320px phone (a label never breaks mid-word), two beside it
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(10rem, 1fr))" }}
      >
        {TEXT_LOOKS.map((look) => {
          const f = look.fields;
          const on = current === look.id;
          const name = lk.looks[look.id as keyof typeof lk.looks];
          const scale = SAMPLE_FONT_PX / f.size;
          const sample = {
            size: SAMPLE_FONT_PX,
            font: f.font,
            outline_color: f.outline_color,
            outline_width: f.outline_width * scale,
            ...(f.shadow ? { shadow: Math.max(0.8, f.shadow * scale) } : {}),
            ...(f.box_color
              ? { box_color: f.box_color, box_opacity: f.box_opacity }
              : {}),
          };
          return (
            <label
              key={look.id}
              className="ns-chip min-w-0"
              // a 44px key at every width (the chip class is 40px on a mouse)
              style={{ minHeight: "2.75rem" }}
              data-radio=""
              data-on={on ? "true" : undefined}
              data-look={look.id}
            >
              <input
                type="radio"
                name={`${id}-look`}
                value={look.id}
                checked={on}
                onChange={() => onPick(look.id)}
                aria-label={name}
                className="sr-only"
              />
              <span
                aria-hidden
                className="flex h-8 w-11 shrink-0 items-center justify-center overflow-hidden rounded-[3px] bg-[var(--ns-film)]"
                style={{ containerType: "inline-size" }}
              >
                <span
                  style={{
                    fontSize: `${(SAMPLE_FONT_PX / SWATCH_PX) * 100}cqw`,
                    fontWeight: f.bold ? 700 : 400,
                    lineHeight: 1,
                    color: f.color ?? TEXT_COLOR,
                    ...previewTextStyle(sample, SWATCH_PX, ""),
                  }}
                >
                  <span style={previewBoxStyle(sample, SWATCH_PX)}>
                    {lk.lookSample}
                  </span>
                </span>
              </span>
              <span className="min-w-0 break-words leading-tight" aria-hidden>
                {name}
              </span>
            </label>
          );
        })}
      </div>
      <p
        id={`${id}-hint`}
        className="m-0 text-xs text-[var(--color-muted)]"
      >
        {fmt(lk.lookCurrent, {
          name: current ? lk.looks[current as keyof typeof lk.looks] : lk.lookNone,
        })}{" "}
        {lk.lookHint}
      </p>
    </fieldset>
  );
}
