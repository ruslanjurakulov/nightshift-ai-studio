"use client";

import { useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { ASPECT_RATIOS, VIDEO_DURATIONS, modelsFor, type StudioModel } from "@/lib/creative/studio";
import {
  LABEL_MAX,
  MAX_STEPS,
  NAME_MAX,
  PROMPT_MAX,
  WORKFLOW_CAPABILITIES,
  takesPicture,
  takesPrompt,
  workflowErrorMessage,
  type Workflow,
  type WorkflowCapability,
} from "@/lib/workflows";
import {
  addStep,
  draftProblem,
  earlierPictureSteps,
  fromDefinition,
  newDraft,
  removeStep,
  setCapability,
  toDefinition,
  type Draft,
  type DraftStep,
} from "@/lib/workflows-builder";
import { saveWorkflow } from "./workflowsApi";

const field =
  "pill border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-[16px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]";

/**
 * The workflow editor: a name and two to six steps. Saving costs nothing and
 * runs nothing; the database checks every step the way the Studio checks a
 * generation, so a workflow that could not run is refused here, not at Run now.
 */
export function WorkflowBuilder({
  orgId,
  models,
  initial,
  onSaved,
  onCancel,
}: {
  orgId: string;
  models: StudioModel[];
  initial: Workflow | null;
  onSaved: (wf: Workflow) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const b = t.workflows.builder;
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => (initial ? fromDefinition(initial) : newDraft()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchStep = (i: number, patch: Partial<DraftStep>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));

  async function onSave() {
    const problem = draftProblem(draft);
    if (problem) {
      const text = b.problems[problem.problem];
      setError(fmt(text, { n: (problem.step ?? 0) + 1 }));
      return;
    }
    setBusy(true);
    setError(null);
    const out = await saveWorkflow(orgId, draft.name.trim(), toDefinition(draft), initial?.id ?? null);
    setBusy(false);
    if (!out.ok) {
      setError(workflowErrorMessage(t, out.error));
      return;
    }
    onSaved(out.value);
  }

  return (
    <section aria-labelledby={`${id}-h`} className="panel flex flex-col gap-4 p-4">
      <h2 id={`${id}-h`} className="m-0 text-[15px] font-semibold">
        {initial ? b.editTitle : b.newTitle}
      </h2>

      <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
        {b.name}
        <input
          value={draft.name}
          maxLength={NAME_MAX}
          placeholder={b.namePlaceholder}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          className={field}
        />
      </label>

      <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label={b.stepsTitle}>
        {draft.steps.map((s, i) => (
          <StepEditor
            key={s.key}
            index={i}
            step={s}
            draft={draft}
            models={models}
            canRemove={draft.steps.length > 2}
            onPatch={(p) => patchStep(i, p)}
            onCapability={(c) => patchStep(i, setCapability(s, c))}
            onRemove={() => setDraft((d) => removeStep(d, i))}
          />
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={draft.steps.length >= MAX_STEPS}
          onClick={() => setDraft((d) => addStep(d))}
          className="btn-sky ghost pill inline-flex items-center gap-2 px-4 py-2 text-[13px]"
        >
          <Plus className="size-4" aria-hidden />
          {b.addStep}
        </button>
        {draft.steps.length >= MAX_STEPS ? <span className="text-[12px] text-[var(--color-muted)]">{b.maxSteps}</span> : null}
      </div>

      {error ? (
        <p role="alert" className="m-0 text-[13px] text-[var(--color-fail)]">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onSave} disabled={busy} className="btn-sky is-solid pill px-4 py-2 text-[13px]">
          {busy ? b.saving : b.save}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="btn-sky is-quiet pill px-4 py-2 text-[13px]">
          {b.cancel}
        </button>
      </div>
    </section>
  );
}

function StepEditor({
  index,
  step,
  draft,
  models,
  canRemove,
  onPatch,
  onCapability,
  onRemove,
}: {
  index: number;
  step: DraftStep;
  draft: Draft;
  models: StudioModel[];
  canRemove: boolean;
  onPatch: (p: Partial<DraftStep>) => void;
  onCapability: (c: WorkflowCapability) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const b = t.workflows.builder;
  const n = index + 1;
  const available = modelsFor(models, step.capability);
  const earlier = earlierPictureSteps(draft.steps, index);
  const words = takesPrompt(step.capability);
  const picture = takesPicture(step.capability);
  const clip = step.capability === "t2v" || step.capability === "i2v";
  const shaped = step.capability === "t2i" || step.capability === "t2v";

  return (
    <li className="studio-field flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-[13px] font-semibold">{fmt(b.stepN, { n })}</h3>
        {canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={fmt(b.removeStep, { n })}
            className="btn-sky is-quiet pill inline-flex size-8 items-center justify-center"
          >
            <Trash2 className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
          {b.tool}
          <select value={step.capability} onChange={(e) => onCapability(e.target.value as WorkflowCapability)} className={field}>
            {WORKFLOW_CAPABILITIES.map((c) => (
              <option key={c} value={c}>
                {t.workflows.tools[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
          {b.model}
          <select value={step.model} onChange={(e) => onPatch({ model: e.target.value })} className={field} disabled={available.length === 0}>
            <option value="">{available.length === 0 ? b.noModels : b.chooseModel}</option>
            {available.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>

      {picture ? (
        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="mb-1 p-0 text-[12px] text-[var(--color-muted)]">{b.picture}</legend>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="radio"
              name={`src-${step.key}`}
              checked={step.source.mode === "input"}
              onChange={() => onPatch({ source: { ...step.source, mode: "input" } })}
            />
            {b.fromLibrary}
          </label>
          {step.source.mode === "input" ? (
            <input
              value={step.source.label}
              maxLength={LABEL_MAX}
              placeholder={b.inputNamePlaceholder}
              aria-label={b.inputName}
              onChange={(e) => onPatch({ source: { ...step.source, label: e.target.value } })}
              className={field}
            />
          ) : null}
          {earlier.length === 0 ? (
            <p className="m-0 text-[12px] text-[var(--color-muted)]">{b.noEarlierPicture}</p>
          ) : (
            earlier.map((k) => (
              <label key={k} className="flex items-center gap-2 text-[13px]">
                <input
                  type="radio"
                  name={`src-${step.key}`}
                  checked={step.source.mode === "step" && step.source.step === k}
                  onChange={() => onPatch({ source: { ...step.source, mode: "step", step: k } })}
                />
                {fmt(b.fromStep, { n: k + 1 })}
              </label>
            ))
          )}
        </fieldset>
      ) : null}

      {words ? (
        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="mb-1 p-0 text-[12px] text-[var(--color-muted)]">{b.words}</legend>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="radio"
              name={`words-${step.key}`}
              checked={step.prompt.mode === "input"}
              onChange={() => onPatch({ prompt: { ...step.prompt, mode: "input" } })}
            />
            {b.askEachTime}
          </label>
          {step.prompt.mode === "input" ? (
            <input
              value={step.prompt.label}
              maxLength={LABEL_MAX}
              placeholder={b.inputNamePlaceholder}
              aria-label={b.inputName}
              onChange={(e) => onPatch({ prompt: { ...step.prompt, label: e.target.value } })}
              className={field}
            />
          ) : null}
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="radio"
              name={`words-${step.key}`}
              checked={step.prompt.mode === "literal"}
              onChange={() => onPatch({ prompt: { ...step.prompt, mode: "literal" } })}
            />
            {b.typeHere}
          </label>
          {step.prompt.mode === "literal" ? (
            <textarea
              value={step.prompt.text}
              maxLength={PROMPT_MAX}
              rows={3}
              placeholder={b.wordsPlaceholder}
              aria-label={b.words}
              onChange={(e) => onPatch({ prompt: { ...step.prompt, text: e.target.value } })}
              className={`${field} rounded-2xl`}
            />
          ) : null}
        </fieldset>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {clip ? (
          <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
            {b.length}
            <select value={step.seconds} onChange={(e) => onPatch({ seconds: Number(e.target.value) as DraftStep["seconds"] })} className={field}>
              {VIDEO_DURATIONS.map((s) => (
                <option key={s} value={s}>
                  {fmt(b.seconds, { n: s })}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {shaped ? (
          <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
            {b.shape}
            <select value={step.aspect} onChange={(e) => onPatch({ aspect: e.target.value as DraftStep["aspect"] })} className={field}>
              {ASPECT_RATIOS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {step.capability === "upscale" ? (
          <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
            {b.factor}
            <select value={step.factor} onChange={(e) => onPatch({ factor: Number(e.target.value) as DraftStep["factor"] })} className={field}>
              {[2, 4].map((f) => (
                <option key={f} value={f}>
                  {fmt(b.factorX, { n: f })}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    </li>
  );
}
