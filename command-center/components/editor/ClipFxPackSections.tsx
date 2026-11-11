"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  ANIM_MIN_S,
  FX_MAX,
  FX_NAMES,
  V_ANIMS,
  type EditorAsset,
  type EditorModel,
  type SoundClip,
  type VideoAnim,
  type VideoClip,
} from "@/lib/editor";
import {
  animMaxS,
  animProblem,
  fxSlotsLeft,
  fxValue,
  hasFx,
  setClipAnim,
  setClipAnimLength,
  setClipFx,
} from "@/lib/editorFxPack";
import { lookCheck } from "@/lib/editorLook";
import { beatsFor, type BeatsResult } from "@/lib/editorBeats";
import { countForm } from "@/lib/editorSilence";
import { Disclosure, RadioChips, SliderRow } from "./FxControls";

/**
 * The effects pack and the entrance / exit animation of the selected video clip, and the beats of the selected
 * sound. Every change is a new model through `apply` (one undo step, one per slider gesture); a change that adds
 * render time is checked against the export's allowance first and is not made when it would not fit.
 */

type Apply = (next: EditorModel, group?: string) => void;

const quiet =
  "btn-quiet inline-flex min-h-11 items-center gap-1.5 self-start px-3 py-1.5 text-xs aria-disabled:cursor-default aria-disabled:opacity-50";

function useBudgeted(apply: Apply, showClip: (id: string) => void, id: string) {
  const { t } = useI18n();
  const [refused, setRefused] = useState<string | null>(null);
  const edit = (next: EditorModel, group?: string) => {
    const check = lookCheck(next);
    if (!check.ok) {
      setRefused(
        fmt(t.editor.parity2b.budget, {
          work: Math.round(check.render.work),
          length: Math.round(check.render.length),
          allowed: Math.round(check.render.allowed),
        }),
      );
      return;
    }
    setRefused(null);
    apply(next, group);
    showClip(id);
  };
  return { edit, refused };
}

function Note({ text, warn = false, testId }: { text: string | null; warn?: boolean; testId?: string }) {
  return text ? (
    <p role={warn ? "status" : undefined} data-testid={testId} className={`m-0 text-xs ${warn ? "text-[var(--color-warn)]" : "text-[var(--color-muted)]"}`}>
      {text}
    </p>
  ) : null;
}

export function ClipFxPackSection({
  model,
  clip,
  apply,
  showClip,
}: {
  model: EditorModel;
  clip: VideoClip;
  apply: Apply;
  showClip: (id: string) => void;
}) {
  const { t } = useI18n();
  const s = t.editor.parity2b.fx;
  const { edit, refused } = useBudgeted(apply, showClip, clip.id);
  const slots = fxSlotsLeft(model, clip);
  return (
    <Disclosure title={s.title} active={hasFx(clip)} testId="clip-fx-pack" lazy>
      {FX_NAMES.map((k) => {
        const v = fxValue(clip, k);
        return (
          <SliderRow
            key={k}
            label={s.names[k]}
            value={v}
            min={0}
            max={FX_MAX}
            step={1}
            disabled={v === 0 && slots === 0}
            text={fmt(s.value, { v })}
            onChange={(n, group) => edit(setClipFx(model, clip.id, k, n), group)}
          />
        );
      })}
      {slots < FX_NAMES.length ? <Note text={s.largeXfade} testId="fx-large" /> : null}
      <Note text={refused} warn testId="fx-budget" />
      <Note text={s.hint} />
      {hasFx(clip) ? <Note text={s.previewNote} /> : null}
    </Disclosure>
  );
}

export function ClipAnimSection({
  model,
  clip,
  apply,
  showClip,
}: {
  model: EditorModel;
  clip: VideoClip;
  apply: Apply;
  showClip: (id: string) => void;
}) {
  const { t } = useI18n();
  const s = t.editor.parity2b.anim;
  const { edit, refused } = useBudgeted(apply, showClip, clip.id);
  const max = animMaxS(clip);
  const side = (k: "in" | "out") => {
    const name = clip[`anim_${k}`];
    const problem = name ? null : animProblem(clip, k);
    return (
      <div key={k} className="flex min-w-0 flex-col gap-1.5">
        <RadioChips
          legend={k === "in" ? s.inLegend : s.outLegend}
          options={[
            { value: "none", label: s.none },
            ...V_ANIMS.map((a) => ({ value: a as string, label: s.names[a], disabled: Boolean(problem) })),
          ]}
          value={name ?? "none"}
          onChange={(v) => edit(setClipAnim(model, clip.id, k, v === "none" ? null : (v as VideoAnim)))}
          columns="7.5rem"
          testId={`clip-anim-${k}`}
        />
        {name ? (
          <SliderRow
            label={s.length}
            value={clip[`anim_${k}_s`] ?? ANIM_MIN_S}
            min={ANIM_MIN_S}
            max={Math.max(ANIM_MIN_S, max)}
            step={0.1}
            text={fmt(s.value, { v: (clip[`anim_${k}_s`] ?? ANIM_MIN_S).toFixed(1) })}
            onChange={(n, group) => edit(setClipAnimLength(model, clip.id, k, n), group)}
          />
        ) : null}
        {problem ? <Note text={problem === "fade" ? s.fadeSide : s.tooShort} testId={`anim-${k}-problem`} /> : null}
      </div>
    );
  };
  return (
    <Disclosure title={s.title} active={Boolean(clip.anim_in || clip.anim_out)} testId="clip-anim" lazy>
      {side("in")}
      {side("out")}
      <Note text={refused} warn testId="anim-budget" />
      <Note text={s.hint} />
      {clip.anim_in || clip.anim_out ? <Note text={s.previewNote} /> : null}
    </Disclosure>
  );
}

/** "Find beats" for the selected sound: the markers live in the editor (not in the document). */
export function SoundBeatsSection({
  sound,
  asset,
  shown,
  onBeats,
}: {
  sound: Pick<SoundClip, "id" | "asset_id">;
  asset: Pick<EditorAsset, "viewUrl" | "durationS"> | undefined;
  /** The beats this sound shows now (file seconds), or null. */
  shown: readonly number[] | null;
  onBeats: (soundId: string, beats: number[] | null) => void;
}) {
  const { t, locale } = useI18n();
  const s = t.editor.parity2b.beats;
  const [result, setResult] = useState<BeatsResult | "working" | null>(null);
  useEffect(() => setResult(null), [sound.id]);
  const find = () => {
    if (!asset?.viewUrl) {
      setResult({ status: "unavailable" });
      return;
    }
    setResult("working");
    void beatsFor(sound.asset_id, asset.viewUrl, asset.durationS ?? null).then((r) => {
      setResult(r);
      if (r.status === "ready") onBeats(sound.id, r.beats);
    });
  };
  const status =
    result === "working"
      ? s.working
      : result && result.status !== "ready"
        ? s[result.status]
        : result
          ? result.beats.length
            ? fmt(s.found[countForm(result.beats.length, locale)], { n: result.beats.length })
            : s.none
          : null;
  return (
    <Disclosure title={s.title} active={Boolean(shown)} testId="sound-beats" lazy>
      {shown ? (
        <button type="button" className={quiet} onClick={() => onBeats(sound.id, null)}>
          {s.hide}
        </button>
      ) : (
        <button type="button" className={quiet} onClick={find} aria-disabled={result === "working" || undefined}>
          {s.find}
        </button>
      )}
      {status ? (
        <p role="status" className="m-0 text-xs" data-testid="beats-status">
          {status}
        </p>
      ) : null}
      <Note text={s.hint} />
    </Disclosure>
  );
}
