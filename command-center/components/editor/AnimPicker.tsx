"use client";

import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  ANIM_MAX_S,
  ANIM_MIN_S,
  MAX_TYPEWRITER_TEXTS,
  type EditorModel,
  type PictureOverlay,
  type TextClip,
} from "@/lib/editor";
import {
  animBlocked,
  animChoices,
  animOf,
  animRoom,
  canTypewriter,
  setOverlayAnim,
  setOverlayAnimSeconds,
  setTextAnim,
  setTextAnimSeconds,
  shownFor,
  type AnimSide,
} from "@/lib/editorFx";
import { POP_FROM, SLIDE_SHARE } from "@/lib/editorFxPreview";
import { Disclosure, RadioChips, SliderRow } from "./FxControls";

/**
 * Entrance and exit animations of a text or an overlay: two radio groups (one
 * per side) and, once a side has one, a length slider. Everything the document
 * refuses is made impossible here and the reason said: a side with no time left
 * is disabled, the typewriter is disabled past its per-project limit, and a
 * text's plain fade gives way to the animation on that side.
 */

type Item = TextClip | PictureOverlay;

export function AnimPicker({
  item,
  text,
  typewriterOk,
  onAnim,
  onSeconds,
}: {
  item: Item;
  text: boolean;
  /** False when the project already has the most typewriter texts and this one is not among them. */
  typewriterOk: boolean;
  onAnim: (side: AnimSide, anim: string | null) => void;
  onSeconds: (side: AnimSide, seconds: number, group: string) => void;
}) {
  const { t } = useI18n();
  const fx = t.editor.fx;
  const a = fx.anim;
  const fades =
    text &&
    (("fade_in_s" in item && (item as TextClip & { fade_in_s?: number }).fade_in_s) ||
      ("fade_out_s" in item && (item as TextClip & { fade_out_s?: number }).fade_out_s));
  const used = animOf(item, "in").anim || animOf(item, "out").anim;
  const blocked = (["in", "out"] as const).some((s) => animBlocked(item, s));
  const side = (s: AnimSide) => {
    const now = animOf(item, s);
    const blockedHere = animBlocked(item, s);
    const options = [
      { value: "none", label: a.none },
      ...animChoices(text, s).map((name) => ({
        value: name,
        label: a.names[name as keyof typeof a.names],
        disabled:
          name === now.anim
            ? false
            : blockedHere || (name === "typewriter" && !typewriterOk),
      })),
    ];
    return (
      <div className="flex min-w-0 flex-col gap-1.5" key={s}>
        <RadioChips
          legend={s === "in" ? a.inLegend : a.outLegend}
          options={options}
          value={now.anim ?? "none"}
          onChange={(v) => onAnim(s, v === "none" ? null : v)}
          columns="7rem"
          testId={`anim-${s}`}
        />
        {now.anim ? (
          <SliderRow
            label={s === "in" ? a.inLength : a.outLength}
            value={now.seconds}
            min={ANIM_MIN_S}
            max={Math.max(ANIM_MIN_S, Math.min(ANIM_MAX_S, animRoom(item, s)))}
            step={0.1}
            text={fmt(fx.secondsValue, { v: now.seconds })}
            onChange={(v, group) => onSeconds(s, v, group)}
          />
        ) : null}
      </div>
    );
  };
  return (
    <Disclosure title={a.title} active={Boolean(used)} testId="anim-picker">
      {side("in")}
      {side("out")}
      {blocked ? (
        <p className="m-0 text-xs text-[var(--color-warn)]">
          {fmt(a.noRoom, { shown: shownFor(item) })}
        </p>
      ) : null}
      {text && !typewriterOk ? (
        <p className="m-0 text-xs text-[var(--color-muted)]">
          {fmt(a.typewriterFull, { max: MAX_TYPEWRITER_TEXTS })}
        </p>
      ) : null}
      {fades ? (
        <p className="m-0 text-xs text-[var(--color-muted)]">{a.replacesFade}</p>
      ) : null}
      <p className="m-0 text-xs text-[var(--color-muted)]">
        {fmt(a.hint, {
          slide: Math.round(SLIDE_SHARE * 100),
          pop: Math.round(POP_FROM * 100),
        })}
        {used ? ` ${a.shortened}` : ""}
      </p>
    </Disclosure>
  );
}

/** The text inspector's animation section: reads the text from the model and
 *  reports each change as a new model (one undo step; a length drag is one). */
export function TextAnimSection({
  model,
  text,
  apply,
}: {
  model: EditorModel;
  text: TextClip;
  apply: (next: EditorModel, group?: string) => void;
}) {
  return (
    <AnimPicker
      item={text}
      text
      typewriterOk={canTypewriter(model, text.id)}
      onAnim={(side, anim) => apply(setTextAnim(model, text.id, side, anim))}
      onSeconds={(side, s, group) =>
        apply(setTextAnimSeconds(model, text.id, side, s), group)
      }
    />
  );
}

export function OverlayAnimSection({
  model,
  overlay,
  apply,
}: {
  model: EditorModel;
  overlay: PictureOverlay;
  apply: (next: EditorModel, group?: string) => void;
}) {
  return (
    <AnimPicker
      item={overlay}
      text={false}
      typewriterOk
      onAnim={(side, anim) => apply(setOverlayAnim(model, overlay.id, side, anim))}
      onSeconds={(side, s, group) =>
        apply(setOverlayAnimSeconds(model, overlay.id, side, s), group)
      }
    />
  );
}
