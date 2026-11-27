/**
 * Effects: named one-click starting points for a clip ("Product burst", "Giant in the city" …), each a prompt written for the
 * video models we run, a shape, a length and the models it is written for in order of preference.
 *
 * An effect is a way of FILLING the Studio's video form and nothing else (CLAUDE.md #3). It has no price, no spend path and no
 * run of its own: /create?tool=<cap>&effect=<id> opens the normal composer with the words, the model, the shape and the length in
 * it, and the person still presses Generate there and sees the database's quote and hold. There is no effect route and no effect job.
 *
 * Which model an effect uses is decided only from the models the Studio already offers this workspace (the same list the composer
 * gets: sellable, probe-verified, not switched off, not geo-blocked, plus the operator's own previews in the operator's org). The
 * first of the effect's models that is in that list is the one its card names. When none is, the effect says it is not open here
 * and fills nothing: it is never pointed at some other model the effect was not written for (CLAUDE.md #4, #5).
 *
 * The data is lib/effects/effects.json, here rather than in schemas/ because the web image is built from command-center/ alone;
 * tests/effects-catalog.test.ts checks every model against schemas/model_registry.json. Names and one-line descriptions are in
 * lib/i18n/effects/{en,ru,uz}.ts; the prompts are English on purpose, as the Studio templates are (the models follow English best).
 *
 * Server-only: this module holds every effect's model preference order, full prompt and preview job, and it once put them in
 * the public chunk on /, /solutions/[slug] and the Studio. Client Components are handed the slices in lib/effects/shared.ts,
 * built here (effectFace, effectDeskCards, canvasEffects), and re-exported so server code and tests keep one import.
 */
import "server-only";
import data from "@/lib/effects/effects.json";
import { MODEL_ID_RE } from "@/lib/models-admin";
import { ASPECT_RATIOS, VIDEO_DURATIONS, prefillFromQuery, type StudioModel, type StudioPrefill } from "@/lib/creative/studio";
import { effectSample } from "@/components/effects/effect-sample";
import {
  EFFECT_CAPABILITIES,
  EFFECT_IDS,
  EFFECT_MODELS_MAX,
  EFFECT_MOTIFS,
  EFFECT_PROMPT_MAX,
  SUBJECT_SLOT,
  cleanSubject,
  fillPrompt,
  type CanvasEffect,
  type Effect,
  type EffectAvailability,
  type EffectCapability,
  type EffectDeskCard,
  type EffectFace,
  type EffectId,
} from "@/lib/effects/shared";

export * from "@/lib/effects/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const SLOT_ANY = /\{[^}]*\}/g;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string | number>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

/**
 * One entry as effects.json holds it, or a reason it is refused. `knownModels`, when given, is the registry's ids for the
 * entry's tool: a model outside it is refused (the tests pass schemas/model_registry.json; the app has no registry to pass and
 * relies on the Studio's offered list, which can never contain an unknown model).
 */
export function parseEffect(v: unknown, knownModels?: ReadonlySet<string>): { ok: true; effect: Effect } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (!isObj(v)) return no("not an object");
  const { id, capability, input, models, prompt, slotHint, aspect, duration, motif, hues, previewJobId } = v;
  if (!oneOf(EFFECT_IDS, id)) return no(`unknown id ${String(id)}`);
  if (!oneOf(EFFECT_CAPABILITIES, capability)) return no(`${id}: capability must be t2v or i2v`);
  // A words effect takes no picture and a picture effect no subject: the form either asks for one or the other.
  if (input !== (capability === "i2v" ? "picture" : "none")) return no(`${id}: input does not match ${capability}`);
  if (!Array.isArray(models) || models.length === 0 || models.length > EFFECT_MODELS_MAX) return no(`${id}: models must be 1-${EFFECT_MODELS_MAX}`);
  if (new Set(models).size !== models.length) return no(`${id}: a model is listed twice`);
  for (const m of models) {
    if (typeof m !== "string" || !MODEL_ID_RE.test(m)) return no(`${id}: malformed model id`);
    if (knownModels && !knownModels.has(m)) return no(`${id}: unknown model ${m}`);
  }
  if (typeof prompt !== "string" || prompt.trim() !== prompt || prompt.length < 40 || prompt.length > EFFECT_PROMPT_MAX) return no(`${id}: prompt length`);
  const slots = prompt.match(SLOT_ANY) ?? [];
  if (capability === "t2v") {
    // Exactly one slot, and only the one we fill: a stray {name} would reach the model as literal braces.
    if (slots.length !== 1 || slots[0] !== SUBJECT_SLOT) return no(`${id}: a words effect needs exactly one ${SUBJECT_SLOT}`);
    if (typeof slotHint !== "string" || !/^\[[^\[\]{}]{1,60}\]$/.test(slotHint)) return no(`${id}: slotHint must be [words]`);
  } else {
    if (slots.length !== 0) return no(`${id}: a picture effect has no slot`);
    if (slotHint !== null) return no(`${id}: a picture effect has no slotHint`);
  }
  if (!oneOf(ASPECT_RATIOS, aspect)) return no(`${id}: aspect`);
  if (!oneOf(VIDEO_DURATIONS, duration)) return no(`${id}: duration`);
  if (!oneOf(EFFECT_MOTIFS, motif)) return no(`${id}: motif`);
  if (!Array.isArray(hues) || hues.length !== 2 || !hues.every((h) => typeof h === "string" && HEX.test(h))) return no(`${id}: hues`);
  if (!(previewJobId === null || (typeof previewJobId === "string" && UUID.test(previewJobId)))) return no(`${id}: previewJobId`);
  return {
    ok: true,
    effect: {
      id,
      capability,
      input: capability === "i2v" ? "picture" : "none",
      models: models as string[],
      prompt,
      slotHint: slotHint as string | null,
      aspect,
      duration,
      motif,
      hues: [hues[0], hues[1]] as const,
      previewJobId: previewJobId as string | null,
    },
  };
}

/** The catalog: the well-formed entries in EFFECT_IDS order, each once, and why any other was refused. */
export function parseEffects(raw: unknown, knownModels?: (cap: EffectCapability) => ReadonlySet<string>): { effects: Effect[]; refused: string[] } {
  const list = isObj(raw) && Array.isArray(raw.effects) ? raw.effects : [];
  const byId = new Map<EffectId, Effect>();
  const refused: string[] = [];
  for (const v of list) {
    const cap = isObj(v) && oneOf(EFFECT_CAPABILITIES, v.capability) ? v.capability : null;
    const r = parseEffect(v, cap && knownModels ? knownModels(cap) : undefined);
    if (!r.ok) refused.push(r.reason);
    else if (byId.has(r.effect.id)) refused.push(`${r.effect.id}: listed twice`);
    else byId.set(r.effect.id, r.effect);
  }
  return { effects: EFFECT_IDS.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])), refused };
}

export const EFFECTS: readonly Effect[] = parseEffects(data).effects;

export function effectById(id: unknown): Effect | null {
  return typeof id === "string" ? (EFFECTS.find((e) => e.id === id) ?? null) : null;
}

// ── which model ─────────────────────────────────────────────────────────────

type OfferedModel = Pick<StudioModel, "id" | "displayName" | "capabilities"> & Partial<Pick<StudioModel, "preview" | "fixedShape">>;

/** The first of the effect's models the Studio offers this workspace for the effect's tool, or "unavailable". Never another one. */
export function resolveEffect(effect: Pick<Effect, "capability" | "models">, offered: readonly OfferedModel[]): EffectAvailability {
  for (let rank = 0; rank < effect.models.length; rank++) {
    const m = offered.find((o) => o.id === effect.models[rank] && o.capabilities.includes(effect.capability));
    if (m) return { state: "ready", modelId: m.id, modelName: m.displayName, rank, preview: m.preview === true, fixedShape: m.fixedShape === true };
  }
  return { state: "unavailable" };
}

// ── the links ───────────────────────────────────────────────────────────────

type Query = Record<string, string | string[] | undefined>;
const one = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * The effect a /create link asks for, with the subject it carries, or null. Only for the very tool the link names, so a stale or
 * hand-edited link cannot switch the tool (the same rule as a Studio template, lib/presets.ts presetPrefill). A picture effect
 * keeps a well-formed `source` (the Library's "Use in Studio"); a malformed one is dropped, never sent.
 */
export function effectFromQuery(q: Query): { effect: Effect; subject: string; sourceId: string | null } | null {
  const effect = effectById(one(q.effect));
  if (!effect || one(q.tool) !== effect.capability) return null;
  const subject = effect.input === "none" ? cleanSubject(one(q.subject)) : "";
  const sourceId = effect.input === "picture" ? (prefillFromQuery(effect.capability, one(q.source))?.sourceId ?? null) : null;
  return { effect, subject, sourceId };
}

/** What a ready effect puts into the composer: its tool, the model the card named, its words, shape and length. Spends nothing. */
export function effectPrefill(effect: Effect, modelId: string, subject: string, sourceId: string | null = null): StudioPrefill {
  return {
    capability: effect.capability,
    model: modelId,
    prompt: fillPrompt(effect, subject),
    aspect: effect.aspect,
    duration: effect.duration,
    // The effect is its own words, shape and length: the channel's default style kit must not be added to it unseen.
    styleKitId: null,
    ...(effect.input === "picture" ? { sourceId, factor: 2 as const } : {}),
  };
}

// ── what a Client Component is handed ───────────────────────────────────────

/** What a card draws: the effect's tool, shape, length and drawing, and its real sample when it has one. No models, no prompt. */
export function effectFace(effect: Effect): EffectFace {
  return {
    id: effect.id,
    capability: effect.capability,
    input: effect.input,
    aspect: effect.aspect,
    duration: effect.duration,
    motif: effect.motif,
    hues: [effect.hues[0], effect.hues[1]],
    sample: effectSample(effect),
  };
}

/** The Studio's Effects desk for a workspace offered `models`: each effect's face and the model it will use here (resolveEffect). */
export function effectDeskCards(models: readonly OfferedModel[], effects: readonly Effect[] = EFFECTS): EffectDeskCard[] {
  return effects.map((e) => ({ face: effectFace(e), availability: resolveEffect(e, models) }));
}

/**
 * The Studio canvas's effects for a workspace offered `models`: an effect whose model is open here comes with the composer's
 * starting values (effectPrefill with no subject and no picture; the canvas puts the node's picture in), any other with none.
 */
export function canvasEffects(models: readonly OfferedModel[], effects: readonly Effect[] = EFFECTS): CanvasEffect[] {
  return effects.map((e) => {
    const pick = resolveEffect(e, models);
    return {
      id: e.id,
      capability: e.capability,
      hues: [e.hues[0], e.hues[1]],
      prefill: pick.state === "ready" ? effectPrefill(e, pick.modelId, "", null) : null,
    };
  });
}
