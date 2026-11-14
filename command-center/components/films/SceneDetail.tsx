"use client";

import { useId } from "react";
import { ArrowDown, ArrowUp, Copy, Merge, Scissors, Trash2 } from "lucide-react";
import { fmt } from "@/lib/i18n";
import type { FilmStudioDictionary } from "@/lib/i18n/film-studio";
import { FIRST_FRAMES, LAST_FRAMES, type FilmLimits, type Problem, type SceneDraft } from "@/lib/films";

export interface LibraryPicture {
  id: string;
  name: string | null;
  thumbUrl: string | null;
}

const chars = (s: string) => [...s].length;

/** A problem's sentence, with its numbers. */
export function problemText(t: FilmStudioDictionary, p: Problem, clockOf: (n: number) => string): string {
  if (p.code === "film_too_long") return fmt(t.problems.film_too_long, { n: clockOf(p.n ?? 0), max: clockOf(p.max ?? 0) });
  return fmt(t.problems[p.code], { n: p.n ?? "" });
}

/** The planned lengths a scene may take: the database's own range (film_limits), whole seconds. */
export function secondsOptions(limits: Pick<FilmLimits, "scene_seconds_min" | "scene_seconds_max">): number[] {
  const out: number[] = [];
  for (let s = limits.scene_seconds_min; s <= limits.scene_seconds_max; s++) out.push(s);
  return out;
}

/**
 * One scene's fields: narration, visual prompt, avoid list, planned length, shots, and how its first and last frames are made, all
 * inside the database's limits. A mode the storyboard cannot take is disabled with its reason beside it, never hidden. Read-only
 * (a viewer, an archived project) draws the same fields, disabled.
 */
export function SceneDetail({
  t,
  scene,
  index,
  count,
  next,
  limits,
  problems,
  readOnly,
  pictures,
  onChange,
  onMove,
  onRemove,
  onDuplicate,
  onSplit,
  onMerge,
  headingId,
}: {
  t: FilmStudioDictionary;
  scene: SceneDraft;
  index: number;
  count: number;
  next: SceneDraft | null;
  limits: FilmLimits;
  problems: Problem[];
  readOnly: boolean;
  pictures: readonly LibraryPicture[];
  onChange: (patch: Partial<SceneDraft>, field: string) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onSplit: () => void;
  onMerge: () => void;
  headingId: string;
}) {
  const id = useId();
  const has = (code: Problem["code"]) => problems.some((p) => p.code === code);
  const counter = (n: number, max: number) => (
    <span className="fs-count" data-over={n > max ? "true" : undefined}>
      {fmt(t.scene.count, { n, max })}
    </span>
  );
  const lastNeedsNext = !next || next.firstFrame === "previous";

  return (
    <div className="fs-section" data-testid="fs-scene-detail">
      <div className="fs-row">
        <h2 id={headingId} className="fs-h2 fs-grow" tabIndex={-1}>
          {fmt(t.scene.heading, { n: index + 1 })}
        </h2>
        {!readOnly && (
          <>
            <button type="button" className="fs-icon-key" onClick={() => onMove(-1)} disabled={index === 0} aria-label={t.scene.moveUp} title={t.scene.moveUp}>
              <ArrowUp aria-hidden className="size-4" />
            </button>
            <button type="button" className="fs-icon-key" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={t.scene.moveDown} title={t.scene.moveDown}>
              <ArrowDown aria-hidden className="size-4" />
            </button>
            <button
              type="button"
              className="fs-icon-key"
              onClick={onDuplicate}
              disabled={count >= limits.max_scenes}
              aria-label={t.canvas.duplicate}
              title={t.canvas.duplicate}
            >
              <Copy aria-hidden className="size-4" />
            </button>
            <button
              type="button"
              className="fs-icon-key"
              onClick={onSplit}
              disabled={count >= limits.max_scenes || scene.plannedSeconds < limits.scene_seconds_min * 2}
              aria-label={t.canvas.split}
              title={scene.plannedSeconds < limits.scene_seconds_min * 2 ? fmt(t.canvas.splitTooShort, { n: limits.scene_seconds_min * 2 }) : t.canvas.split}
            >
              <Scissors aria-hidden className="size-4" />
            </button>
            <button
              type="button"
              className="fs-icon-key"
              onClick={onMerge}
              disabled={!next || next.hasTakes || scene.plannedSeconds + next.plannedSeconds > limits.scene_seconds_max}
              aria-label={t.canvas.merge}
              title={
                !next
                  ? t.canvas.mergeLast
                  : next.hasTakes
                    ? t.canvas.mergeTakes
                    : scene.plannedSeconds + next.plannedSeconds > limits.scene_seconds_max
                      ? fmt(t.canvas.mergeTooLong, { n: limits.scene_seconds_max })
                      : t.canvas.merge
              }
            >
              <Merge aria-hidden className="size-4" />
            </button>
            <button
              type="button"
              className="fs-icon-key"
              onClick={onRemove}
              disabled={scene.hasTakes}
              aria-label={scene.hasTakes ? t.scene.removeHasTakes : t.scene.remove}
              title={scene.hasTakes ? t.scene.removeHasTakes : t.scene.remove}
            >
              <Trash2 aria-hidden className="size-4" />
            </button>
          </>
        )}
      </div>

      <div className="fs-field" data-bad={has("scene_title_too_long") ? "true" : undefined}>
        <label htmlFor={`${id}-title`}>{t.scene.title}</label>
        <input
          id={`${id}-title`}
          className="ns-field"
          value={scene.title}
          placeholder={t.canvas.untitled}
          disabled={readOnly}
          onChange={(e) => onChange({ title: e.target.value }, "title")}
        />
        {counter(chars(scene.title), limits.max_title_chars)}
      </div>

      <div className="fs-field" data-bad={has("narration_too_long") ? "true" : undefined}>
        <label htmlFor={`${id}-narr`}>{t.scene.narration}</label>
        <textarea
          id={`${id}-narr`}
          className="ns-field"
          rows={4}
          value={scene.narration}
          disabled={readOnly}
          aria-describedby={`${id}-narr-h`}
          onChange={(e) => onChange({ narration: e.target.value }, "narration")}
        />
        <span id={`${id}-narr-h`} className="fs-small">
          {t.scene.narrationHint}
        </span>
        {counter(chars(scene.narration), limits.max_narration_chars)}
      </div>

      <div className="fs-field" data-bad={has("prompt_too_long") ? "true" : undefined}>
        <label htmlFor={`${id}-vis`}>{t.scene.visual}</label>
        <textarea
          id={`${id}-vis`}
          className="ns-field"
          rows={4}
          value={scene.visualPrompt}
          disabled={readOnly}
          aria-describedby={`${id}-vis-h`}
          onChange={(e) => onChange({ visualPrompt: e.target.value }, "visual")}
        />
        <span id={`${id}-vis-h`} className="fs-small">
          {t.scene.visualHint}
        </span>
        {counter(chars(scene.visualPrompt), limits.max_prompt_chars)}
      </div>

      <div className="fs-field" data-bad={has("negative_too_long") ? "true" : undefined}>
        <label htmlFor={`${id}-neg`}>{t.scene.negative}</label>
        <textarea
          id={`${id}-neg`}
          className="ns-field"
          rows={2}
          value={scene.negativePrompt}
          disabled={readOnly}
          aria-describedby={`${id}-neg-h`}
          onChange={(e) => onChange({ negativePrompt: e.target.value }, "negative")}
        />
        <span id={`${id}-neg-h`} className="fs-small">
          {t.scene.negativeHint}
        </span>
      </div>

      <div className="fs-fields">
        <div className="fs-field">
          <label htmlFor={`${id}-len`}>{t.scene.length}</label>
          <select
            id={`${id}-len`}
            className="ns-field"
            value={scene.plannedSeconds}
            disabled={readOnly}
            onChange={(e) => onChange({ plannedSeconds: Number(e.target.value) }, "length")}
          >
            {secondsOptions(limits).map((s) => (
              <option key={s} value={s}>
                {fmt(t.scene.seconds, { n: s })}
              </option>
            ))}
          </select>
        </div>
        <div className="fs-field">
          <label htmlFor={`${id}-shots`}>{t.scene.shots}</label>
          <select
            id={`${id}-shots`}
            className="ns-field"
            value={scene.shotCount}
            disabled={readOnly}
            aria-describedby={`${id}-shots-h`}
            onChange={(e) => onChange({ shotCount: Number(e.target.value) }, "shots")}
          >
            {Array.from({ length: limits.max_shots }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span id={`${id}-shots-h`} className="fs-small">
            {t.scene.shotsHint}
          </span>
        </div>
      </div>

      <fieldset className="fs-field" data-bad={has("first_scene_previous") || has("first_frame_picture") ? "true" : undefined}>
        <legend>{t.scene.firstFrame}</legend>
        <div className="fs-choice">
          {FIRST_FRAMES.map((m) => {
            const off = m === "previous" && index === 0;
            return (
              <label key={m}>
                <input
                  type="radio"
                  name={`${id}-ff`}
                  value={m}
                  checked={scene.firstFrame === m}
                  disabled={readOnly || off}
                  onChange={() => onChange({ firstFrame: m }, "first_frame")}
                />
                <span className="flex flex-col gap-0.5">
                  <span>{t.scene.ff[m]}</span>
                  {off && <span className="fs-small">{t.scene.previousNotFirst}</span>}
                </span>
              </label>
            );
          })}
        </div>
        {scene.firstFrame === "asset" && (
          <PicturePicker
            t={t}
            pictures={pictures}
            value={scene.firstFrameAssetId}
            missing={scene.firstFrameMissing}
            disabled={readOnly}
            onPick={(pid) => onChange({ firstFrameAssetId: pid, firstFrameMissing: false }, "first_frame")}
          />
        )}
      </fieldset>

      <fieldset className="fs-field" data-bad={has("next_keyframe_needs_next") || has("last_frame_picture") ? "true" : undefined}>
        <legend>{t.scene.lastFrame}</legend>
        <div className="fs-choice">
          {LAST_FRAMES.map((m) => {
            // Ending on the next scene's key frame needs a next scene with a key frame of its own (0166 film_check_storyboard).
            const off = m === "next_keyframe" && lastNeedsNext && scene.lastFrame !== "next_keyframe";
            return (
              <label key={m}>
                <input
                  type="radio"
                  name={`${id}-lf`}
                  value={m}
                  checked={scene.lastFrame === m}
                  disabled={readOnly || off}
                  onChange={() => onChange({ lastFrame: m }, "last_frame")}
                />
                <span className="flex flex-col gap-0.5">
                  <span>{t.scene.lf[m]}</span>
                  {m === "next_keyframe" && lastNeedsNext && <span className="fs-small">{t.scene.nextNeedsKeyframe}</span>}
                </span>
              </label>
            );
          })}
        </div>
        {scene.lastFrame === "asset" && (
          <PicturePicker
            t={t}
            pictures={pictures}
            value={scene.lastFrameAssetId}
            missing={scene.lastFrameMissing}
            disabled={readOnly}
            onPick={(pid) => onChange({ lastFrameAssetId: pid, lastFrameMissing: false }, "last_frame")}
          />
        )}
      </fieldset>

      {problems.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-live="polite">
          {problems.map((p) => (
            <li key={p.code} className="fs-bad" style={{ color: "var(--ns-tally)", fontSize: 13 }}>
              {problemText(t, p, (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A library picture for a frame. "Missing" is film_json's own flag for the saved picture, never a guess from this list (it shows only
 * the newest pictures, so a picture outside it is not therefore gone).
 */
export function PicturePicker({
  t,
  pictures,
  value,
  missing,
  disabled,
  onPick,
}: {
  t: FilmStudioDictionary;
  pictures: readonly LibraryPicture[];
  value: string | null;
  missing: boolean;
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="fs-small">{t.scene.choosePicture}</span>
      {missing && <p className="fs-bad">{t.scene.missingPicture}</p>}
      {pictures.length === 0 ? (
        <p className="fs-small">{t.scene.noPictures}</p>
      ) : (
        <ul className="fs-pics">
          {pictures.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                className="fs-pic"
                aria-pressed={value === p.id}
                aria-label={p.name ?? fmt(t.refs.unnamedPicture, { n: i + 1 })}
                disabled={disabled}
                onClick={() => onPick(p.id)}
              >
                {p.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.thumbUrl} alt="" loading="lazy" />
                ) : (
                  <span aria-hidden="true">{i + 1}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
