"use client";

import { useId, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { XFADE_STYLES, type XfadeStyle } from "@/lib/editor";

/**
 * The cross-fade's blend style: one radio per ffmpeg `xfade` transition the
 * export knows (lib/editor.ts XFADE_STYLES), in a two-column grid of keys at
 * least 44px tall. Each key carries a tiny drawing of the MIDDLE of the blend
 * (the outgoing picture on one tone, the incoming one on another); it is a
 * hint of the shape, not a preview: the editor's preview shows one clip at a
 * time and the hint below says the blend is in the exported video. Arrow keys
 * move through the group (native radios); choosing one is one undo step.
 */

const OLD = "color-mix(in srgb, var(--color-fg) 22%, transparent)";
const NEW = "var(--color-primary)";
const EDGE = "var(--color-fg)";

/** The middle of each blend as a CSS background (measured on the real export:
 *  tests/test_editor_transitions.py `test_the_blend_is_the_styles_own_picture`). */
export function glyphStyle(style: XfadeStyle): CSSProperties {
  const half = (dir: string, first: string, second: string, line = false) =>
    line
      ? `linear-gradient(${dir}, ${first} 0 46%, ${EDGE} 46% 54%, ${second} 54%)`
      : `linear-gradient(${dir}, ${first} 50%, ${second} 50%)`;
  switch (style) {
    case "fade":
      return { background: `color-mix(in srgb, ${OLD} 50%, ${NEW} 50%)` };
    case "dissolve":
      return {
        backgroundColor: OLD,
        backgroundImage: `radial-gradient(circle, ${NEW} 0 1.2px, transparent 1.6px)`,
        backgroundSize: "5px 5px",
      };
    case "fadeblack":
      return { background: "#16181d" };
    case "fadewhite":
      return { background: "#f2f2f2" };
    case "wipeleft":
      return { background: half("90deg", OLD, NEW) };
    case "wiperight":
      return { background: half("90deg", NEW, OLD) };
    case "slideleft":
      return { background: half("90deg", OLD, NEW, true) };
    case "slideright":
      return { background: half("90deg", NEW, OLD, true) };
    case "slideup":
      return { background: half("180deg", OLD, NEW, true) };
    case "slidedown":
      return { background: half("180deg", NEW, OLD, true) };
    case "circleopen":
      return {
        background: `radial-gradient(circle, ${NEW} 0 38%, ${OLD} 40%)`,
      };
    case "circleclose":
      return {
        background: `radial-gradient(circle, ${OLD} 0 38%, ${NEW} 40%)`,
      };
    case "radial":
      return { background: `conic-gradient(${NEW} 0 50%, ${OLD} 50% 100%)` };
    case "zoomin":
      return {
        background: `linear-gradient(${OLD}, ${OLD}) center / 62% 62% no-repeat, ${NEW}`,
      };
    case "wipeup":
      return { background: half("180deg", OLD, NEW) };
    case "wipedown":
      return { background: half("180deg", NEW, OLD) };
    case "smoothleft":
      return { background: `linear-gradient(90deg, ${OLD} 30%, ${NEW} 70%)` };
    case "smoothright":
      return { background: `linear-gradient(90deg, ${NEW} 30%, ${OLD} 70%)` };
    case "smoothup":
      return { background: `linear-gradient(180deg, ${OLD} 30%, ${NEW} 70%)` };
    case "smoothdown":
      return { background: `linear-gradient(180deg, ${NEW} 30%, ${OLD} 70%)` };
    case "vertopen":
      return { background: `linear-gradient(90deg, ${OLD} 0 30%, ${NEW} 30% 70%, ${OLD} 70%)` };
    case "vertclose":
      return { background: `linear-gradient(90deg, ${NEW} 0 30%, ${OLD} 30% 70%, ${NEW} 70%)` };
    case "horzopen":
      return { background: `linear-gradient(180deg, ${OLD} 0 30%, ${NEW} 30% 70%, ${OLD} 70%)` };
    case "horzclose":
      return { background: `linear-gradient(180deg, ${NEW} 0 30%, ${OLD} 30% 70%, ${NEW} 70%)` };
    case "diagtl":
      return { background: `linear-gradient(135deg, ${OLD} 50%, ${NEW} 50%)` };
    case "diagtr":
      return { background: `linear-gradient(225deg, ${OLD} 50%, ${NEW} 50%)` };
    case "diagbl":
      return { background: `linear-gradient(45deg, ${OLD} 50%, ${NEW} 50%)` };
    case "diagbr":
      return { background: `linear-gradient(315deg, ${OLD} 50%, ${NEW} 50%)` };
    case "wipetl":
      return { background: `linear-gradient(${NEW}, ${NEW}) right bottom / 55% 55% no-repeat, ${OLD}` };
    case "wipetr":
      return { background: `linear-gradient(${NEW}, ${NEW}) left bottom / 55% 55% no-repeat, ${OLD}` };
    case "wipebl":
      return { background: `linear-gradient(${NEW}, ${NEW}) right top / 55% 55% no-repeat, ${OLD}` };
    case "wipebr":
      return { background: `linear-gradient(${NEW}, ${NEW}) left top / 55% 55% no-repeat, ${OLD}` };
    case "squeezeh":
      return { background: `linear-gradient(${OLD}, ${OLD}) center / 100% 40% no-repeat, ${NEW}` };
    case "squeezev":
      return { background: `linear-gradient(${OLD}, ${OLD}) center / 40% 100% no-repeat, ${NEW}` };
    case "pixelize":
      return {
        backgroundColor: OLD,
        backgroundImage: `linear-gradient(${NEW} 0 0), linear-gradient(${NEW} 0 0)`,
        backgroundSize: "6px 6px, 6px 6px",
        backgroundPosition: "0 0, 6px 6px",
        backgroundRepeat: "repeat",
      };
    case "hblur":
      return { background: `linear-gradient(90deg, ${OLD}, ${NEW} 25%, ${OLD} 50%, ${NEW} 75%, ${OLD})` };
    case "distance":
      return {
        background: `radial-gradient(circle at 30% 50%, ${NEW} 0 22%, ${OLD} 60%)`,
      };
  }
}

export function TransitionStylePicker({
  value,
  onChange,
}: {
  value: XfadeStyle;
  onChange: (style: XfadeStyle) => void;
}) {
  const { t } = useI18n();
  const lk = t.editor.looks;
  const id = useId();
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
      aria-describedby={`${id}-hint`}
      data-testid="transition-style"
    >
      <legend className="mb-1 p-0 text-xs text-[var(--color-muted)]">
        {lk.styleLegend}
      </legend>
      <div
        className="grid gap-1.5"
        // as many 10rem columns as fit: one on a 320px phone (a label never breaks mid-word), two beside it
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(10rem, 1fr))" }}
      >
        {XFADE_STYLES.map((s) => {
          const on = value === s;
          const name = lk.styles[s];
          return (
            <label
              key={s}
              className="ns-chip min-w-0"
              // a 44px key at every width (the chip class is 40px on a mouse)
              style={{ minHeight: "2.75rem" }}
              data-radio=""
              data-on={on ? "true" : undefined}
              data-style={s}
            >
              <input
                type="radio"
                name={`${id}-style`}
                value={s}
                checked={on}
                onChange={() => onChange(s)}
                aria-label={name}
                className="sr-only"
              />
              <span
                aria-hidden
                className="h-[18px] w-7 shrink-0 rounded-[3px] border border-[var(--color-border)]"
                style={glyphStyle(s)}
              />
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
        {fmt(lk.styleChosen, { name: lk.styles[value] })} {lk.styleHint}
      </p>
    </fieldset>
  );
}
