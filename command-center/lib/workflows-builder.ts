/**
 * The workflow editor's form, as plain data: a draft is what the person is
 * filling in; `toDefinition` turns it into the inputs and steps the database
 * stores, `fromDefinition` reads a saved one back. Pure — no React, no fetch.
 *
 * Words are either typed into the workflow ("literal") or asked for each time
 * it runs ("input", given a name the person chooses). A picture is either
 * chosen from the library each run ("input") or the one an earlier step made
 * ("step"). Only those shapes exist, which is also all the database accepts
 * for a binding: an input by name, or an earlier step by number.
 */
import {
  LABEL_MAX,
  MAX_STEPS,
  MIN_STEPS,
  NAME_MAX,
  PROMPT_MAX,
  makesPicture,
  takesPicture,
  takesPrompt,
  type ParamValue,
  type Workflow,
  type WorkflowCapability,
  type WorkflowInput,
  type WorkflowStep,
} from "@/lib/workflows";

export type AspectChoice = "16:9" | "9:16" | "1:1";
export type SecondsChoice = 5 | 10;
export type FactorChoice = 2 | 4;

export interface TextField {
  mode: "literal" | "input";
  text: string;
  /** What the person calls this input when the workflow runs (mode "input"). */
  label: string;
}
export interface SourceField {
  mode: "input" | "step";
  /** The earlier step's index (mode "step"). */
  step: number;
  label: string;
}

export interface DraftStep {
  /** Stable while editing (list keys); never saved. */
  key: string;
  capability: WorkflowCapability;
  model: string;
  prompt: TextField;
  source: SourceField;
  seconds: SecondsChoice;
  aspect: AspectChoice;
  factor: FactorChoice;
}

export interface Draft {
  name: string;
  steps: DraftStep[];
}

let counter = 0;
function nextKey(): string {
  counter += 1;
  return `s${counter}`;
}

export function newStep(capability: WorkflowCapability = "t2i"): DraftStep {
  return {
    key: nextKey(),
    capability,
    model: "",
    prompt: { mode: "input", text: "", label: "" },
    source: { mode: "input", step: 0, label: "" },
    seconds: 5,
    aspect: "16:9",
    factor: 2,
  };
}

/** A new draft starts as the commonest shape: a picture, then that picture brought to life. */
export function newDraft(): Draft {
  const first = newStep("t2i");
  const second = newStep("i2v");
  second.source = { mode: "step", step: 0, label: "" };
  return { name: "", steps: [first, second] };
}

export function setCapability(step: DraftStep, capability: WorkflowCapability): DraftStep {
  return { ...step, capability, model: "" };
}

/** The picture-making steps before index `at`: what a step may start from. */
export function earlierPictureSteps(steps: readonly DraftStep[], at: number): number[] {
  return steps.flatMap((s, i) => (i < at && makesPicture(s.capability) ? [i] : []));
}

/** Removing a step moves later steps up: a "from step n" pointing at or past it follows (or falls back to a library file). */
export function removeStep(draft: Draft, at: number): Draft {
  const steps = draft.steps
    .filter((_, i) => i !== at)
    .map((s) => {
      if (s.source.mode !== "step") return s;
      if (s.source.step === at) return { ...s, source: { ...s.source, mode: "input" as const, step: 0 } };
      if (s.source.step > at) return { ...s, source: { ...s.source, step: s.source.step - 1 } };
      return s;
    });
  return { ...draft, steps };
}

export function addStep(draft: Draft): Draft {
  if (draft.steps.length >= MAX_STEPS) return draft;
  return { ...draft, steps: [...draft.steps, newStep("t2i")] };
}

export function inputName(kind: "prompt" | "file", stepNumber: number): string {
  return `${kind}_${stepNumber}`;
}

function mkInput(name: string, kind: WorkflowInput["kind"], label: string): WorkflowInput {
  const l = label.trim().slice(0, LABEL_MAX);
  return l ? { name, kind, label: l } : { name, kind };
}

function wordsBinding(f: TextField, n: number): ParamValue {
  return f.mode === "input" ? { $input: inputName("prompt", n) } : f.text.trim();
}

export interface WorkflowDefinition {
  inputs: WorkflowInput[];
  steps: WorkflowStep[];
}

/** The inputs and steps the database stores for this draft. */
export function toDefinition(draft: Draft): WorkflowDefinition {
  const inputs: WorkflowInput[] = [];
  const steps: WorkflowStep[] = draft.steps.map((s, i) => {
    const n = i + 1;
    const params: Record<string, ParamValue> = {};
    if (takesPrompt(s.capability)) {
      params.prompt = wordsBinding(s.prompt, n);
      if (s.prompt.mode === "input") {
        inputs.push(mkInput(inputName("prompt", n), "text", s.prompt.label));
      }
    }
    if (takesPicture(s.capability)) {
      if (s.source.mode === "step") {
        params.source_asset_id = { $step: s.source.step };
      } else {
        params.source_asset_id = { $input: inputName("file", n) };
        inputs.push(mkInput(inputName("file", n), "asset", s.source.label));
      }
    }
    if (s.capability === "t2i" || s.capability === "t2v") params.aspect_ratio = s.aspect;
    if (s.capability === "t2v" || s.capability === "i2v") params.duration_s = s.seconds;
    if (s.capability === "upscale") params.factor = s.factor;
    return { capability: s.capability, model: s.model, params };
  });
  return { inputs, steps };
}

export type DraftProblem = "name" | "steps" | "model" | "words" | "words_long" | "source_step" | "label_long";

/** The first thing wrong with a draft the database would only refuse later, with the step it concerns. */
export function draftProblem(draft: Draft): { problem: DraftProblem; step: number | null } | null {
  const name = draft.name.trim();
  if (!name || name.length > NAME_MAX) return { problem: "name", step: null };
  if (draft.steps.length < MIN_STEPS || draft.steps.length > MAX_STEPS) return { problem: "steps", step: null };
  for (let i = 0; i < draft.steps.length; i++) {
    const s = draft.steps[i];
    if (!s.model) return { problem: "model", step: i };
    if (takesPrompt(s.capability)) {
      if (s.prompt.mode === "literal") {
        if (!s.prompt.text.trim()) return { problem: "words", step: i };
        if (s.prompt.text.length > PROMPT_MAX) return { problem: "words_long", step: i };
      } else if (s.prompt.label.length > LABEL_MAX) return { problem: "label_long", step: i };
    }
    if (takesPicture(s.capability)) {
      if (s.source.mode === "step" && !earlierPictureSteps(draft.steps, i).includes(s.source.step))
        return { problem: "source_step", step: i };
      if (s.source.mode === "input" && s.source.label.length > LABEL_MAX) return { problem: "label_long", step: i };
    }
  }
  return null;
}

function labelOf(inputs: readonly WorkflowInput[], binding: unknown): string {
  if (!binding || typeof binding !== "object" || !("$input" in binding)) return "";
  const name = (binding as { $input: unknown }).$input;
  return inputs.find((i) => i.name === name)?.label ?? "";
}

/** A saved workflow back as a draft (the shapes toDefinition writes; anything else becomes the nearest form). */
export function fromDefinition(wf: Pick<Workflow, "name" | "inputs" | "steps">): Draft {
  return {
    name: wf.name,
    steps: wf.steps.map((s) => {
      const d = newStep(s.capability);
      d.model = s.model;
      const p = s.params;
      if (typeof p.prompt === "string") d.prompt = { mode: "literal", text: p.prompt, label: "" };
      else d.prompt = { mode: "input", text: "", label: labelOf(wf.inputs, p.prompt) };
      const src = p.source_asset_id;
      if (src && typeof src === "object" && "$step" in src && typeof src.$step === "number") {
        d.source = { mode: "step", step: src.$step, label: "" };
      } else {
        d.source = { mode: "input", step: 0, label: labelOf(wf.inputs, src) };
      }
      if (p.aspect_ratio === "16:9" || p.aspect_ratio === "9:16" || p.aspect_ratio === "1:1") d.aspect = p.aspect_ratio;
      if (p.duration_s === 5 || p.duration_s === 10) d.seconds = p.duration_s;
      if (p.factor === 2 || p.factor === 4) d.factor = p.factor;
      return d;
    }),
  };
}
