"use client";

import { useEffect, useId, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  CHROMA_BLEND_MAX,
  CHROMA_SIMILARITY_MAX,
  CHROMA_SIMILARITY_MIN,
  STABILIZE_MAX_DOC_S,
  STABILIZE_MAX_S,
  type EditorModel,
  type PictureOverlay,
  type SoundClip,
  type VideoClip,
} from "@/lib/editor";
import {
  CHROMA_COLORS,
  chromaOf,
  setChromaAmount,
  setChromaColor,
  setClipClean,
  setClipStabilize,
  setOverlayChroma,
  setSoundClean,
  stabilizeCheck,
  startChroma,
  type CleanKey,
} from "@/lib/editorClean";
import { Disclosure, RadioChips, SliderRow, ToggleRow } from "./FxControls";

/**
 * Chroma key (an overlay's), sound clean-up (a video clip's own sound and a
 * music / sound clip) and stabilise. Each reads from the model and reports a
 * new model through `apply`: one undo step per change, one per slider drag.
 * Whatever the document refuses is made impossible here, with the number that
 * decides it on the screen.
 */

type Apply = (next: EditorModel, group?: string) => void;
const pct = (v: number) => Math.round(v * 100);
const tenth = (v: number) => Math.round(v * 10) / 10;
const note = "m-0 text-xs text-[var(--color-muted)]";

// ── chroma key ──────────────────────────────────────────────────────────────

/** The browser's screen colour picker, where it has one (not in every browser). */
interface EyeDropperLike {
  open: () => Promise<{ sRGBHex: string }>;
}
function eyeDropper(): EyeDropperLike | null {
  if (typeof window === "undefined") return null;
  const C = (window as unknown as { EyeDropper?: new () => EyeDropperLike }).EyeDropper;
  return C ? new C() : null;
}

export function OverlayChromaSection({
  model,
  overlay,
  apply,
}: {
  model: EditorModel;
  overlay: PictureOverlay;
  apply: Apply;
}) {
  const { t } = useI18n();
  const fx = t.editor.fx;
  const c = fx.chroma;
  const uid = useId();
  const id = overlay.id;
  const key = chromaOf(overlay);
  const [draft, setDraft] = useState(key?.color ?? "");
  useEffect(() => setDraft(key?.color ?? ""), [key?.color]);
  const [picking, setPicking] = useState(false);
  const canPick = typeof window !== "undefined" && Boolean((window as unknown as { EyeDropper?: unknown }).EyeDropper);
  const badHex = draft.trim() !== "" && !/^#[0-9a-fA-F]{6}$/.test(draft.trim());
  const commitHex = () => {
    const v = draft.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) apply(setChromaColor(model, id, v));
    else if (!badHex) setDraft(key?.color ?? "");
  };
  async function pick() {
    const d = eyeDropper();
    if (!d) return;
    setPicking(true);
    try {
      const r = await d.open();
      apply(setChromaColor(model, id, r.sRGBHex));
    } catch {
      /* cancelled: nothing changes */
    } finally {
      setPicking(false);
    }
  }
  return (
    <Disclosure title={c.title} active={Boolean(key)} testId="overlay-chroma">
      <ToggleRow
        label={c.toggle}
        checked={Boolean(key)}
        onChange={(on) =>
          apply(on ? startChroma(model, id) : setOverlayChroma(model, id, null))
        }
      />
      {key ? (
        <>
          <RadioChips
            legend={c.color}
            options={[
              { value: CHROMA_COLORS.green, label: c.green },
              { value: CHROMA_COLORS.blue, label: c.blue },
            ]}
            value={
              key.color === CHROMA_COLORS.green || key.color === CHROMA_COLORS.blue
                ? key.color
                : null
            }
            onChange={(v) => apply(setChromaColor(model, id, v))}
            testId="chroma-colors"
          />
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-muted)]">
              {c.color}
              <input
                type="color"
                value={key.color.toLowerCase()}
                aria-label={c.color}
                onChange={(e) => apply(setChromaColor(model, id, e.target.value))}
                className="h-11 w-16 cursor-pointer rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-transparent p-1"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-muted)]">
              {c.hex}
              <input
                type="text"
                value={draft}
                maxLength={7}
                spellCheck={false}
                aria-invalid={badHex || undefined}
                aria-describedby={badHex ? `${uid}-bad` : undefined}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitHex}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitHex();
                }}
                className="min-h-11 w-28 rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-base text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]"
              />
            </label>
            {canPick ? (
              <button
                type="button"
                className="btn-quiet inline-flex min-h-11 items-center px-3 py-1.5 text-xs"
                onClick={() => void pick()}
                aria-busy={picking || undefined}
              >
                {c.pick}
              </button>
            ) : null}
          </div>
          {badHex ? (
            <p id={`${uid}-bad`} className="m-0 text-xs text-[var(--color-warn)]">
              {c.badHex}
            </p>
          ) : null}
          <p className={note}>{canPick ? c.pickHint : c.pickUnsupported}</p>
          <SliderRow
            label={c.similarity}
            value={key.similarity}
            min={CHROMA_SIMILARITY_MIN}
            max={CHROMA_SIMILARITY_MAX}
            step={0.01}
            text={fmt(fx.percent, { v: pct(key.similarity) })}
            onChange={(v, g) => apply(setChromaAmount(model, id, "similarity", v), g)}
          />
          <SliderRow
            label={c.blend}
            value={key.blend}
            min={0}
            max={CHROMA_BLEND_MAX}
            step={0.01}
            text={fmt(fx.percent, { v: pct(key.blend) })}
            onChange={(v, g) => apply(setChromaAmount(model, id, "blend", v), g)}
          />
        </>
      ) : null}
      <p className={note}>{c.hint}</p>
    </Disclosure>
  );
}

// ── sound clean-up ──────────────────────────────────────────────────────────

function CleanToggles({
  denoise,
  loudnorm,
  onChange,
}: {
  denoise: boolean;
  loudnorm: boolean;
  onChange: (key: CleanKey, on: boolean) => void;
}) {
  const { t } = useI18n();
  const k = t.editor.fx.clean;
  return (
    <>
      <ToggleRow
        label={k.denoise}
        checked={denoise}
        onChange={(on) => onChange("denoise", on)}
        hint={k.denoiseHint}
        testId="denoise"
      />
      <ToggleRow
        label={k.loudnorm}
        checked={loudnorm}
        onChange={(on) => onChange("loudnorm", on)}
        hint={k.loudnormHint}
        testId="loudnorm"
      />
    </>
  );
}

/** Clean-up of a music or sound-effect clip. */
export function SoundCleanSection({
  model,
  sound,
  apply,
}: {
  model: EditorModel;
  sound: SoundClip;
  apply: Apply;
}) {
  const { t } = useI18n();
  const k = t.editor.fx.clean;
  return (
    <Disclosure
      title={k.soundTitle}
      active={Boolean(sound.denoise || sound.loudnorm)}
      testId="sound-clean"
    >
      <CleanToggles
        denoise={Boolean(sound.denoise)}
        loudnorm={Boolean(sound.loudnorm)}
        onChange={(key, on) => apply(setSoundClean(model, sound.id, key, on))}
      />
    </Disclosure>
  );
}

// ── steady the picture, clean the clip's own sound ──────────────────────────

export function ClipCleanSection({
  model,
  clip,
  still,
  apply,
}: {
  model: EditorModel;
  clip: VideoClip;
  still: boolean;
  apply: Apply;
}) {
  const { t } = useI18n();
  const k = t.editor.fx.clean;
  const check = stabilizeCheck(model, clip);
  const why = still
    ? k.stabilizePhoto
    : !clip.stabilize && !check.ok
      ? check.reason === "freeze"
        ? k.stabilizeFreeze
        : check.reason === "clip_range"
          ? fmt(k.stabilizeClip, { range: tenth(check.range), max: STABILIZE_MAX_S })
          : fmt(k.stabilizeDoc, { used: tenth(check.used), docMax: STABILIZE_MAX_DOC_S })
      : null;
  return (
    <Disclosure
      title={k.title}
      active={Boolean(clip.stabilize || clip.denoise || clip.loudnorm)}
      testId="clip-clean"
    >
      <ToggleRow
        label={k.stabilize}
        checked={Boolean(clip.stabilize)}
        disabled={still || (!clip.stabilize && !check.ok)}
        onChange={(on) => apply(setClipStabilize(model, clip.id, on))}
        testId="stabilize"
        hint={
          <>
            {fmt(k.stabilizeHint, { clipMax: STABILIZE_MAX_S, docMax: STABILIZE_MAX_DOC_S })}
            {clip.stabilize
              ? ` ${fmt(k.stabilizeUsed, { used: tenth(check.used + check.range), docMax: STABILIZE_MAX_DOC_S, range: tenth(check.range) })}`
              : ""}
            {why ? <span className="mt-1 block text-[var(--color-warn)]">{why}</span> : null}
          </>
        }
      />
      {still ? null : (
        <>
          <CleanToggles
            denoise={Boolean(clip.denoise)}
            loudnorm={Boolean(clip.loudnorm)}
            onChange={(key, on) => apply(setClipClean(model, clip.id, key, on))}
          />
          {clip.audio ? null : <p className={note}>{k.soundOff}</p>}
        </>
      )}
    </Disclosure>
  );
}
