/**
 * Effects: named one-click starting points for a clip ("Product burst", "Giant in the city" …), each a prompt written for the
 * video models we run, a shape, a length and the models it is written for in order of preference.
 *
 * An effect is a way of FILLING the Studio's video form and nothing else (CLAUDE.md #3). It has no price, no spend path and no
 * run of its own: /create?tool=<cap>&effect=<id> opens the normal composer with the words, the model, the shape and the length in
 * it, and the person still presses Generate there and sees the database's quote and hold. There is no "effect" on the server.
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
 * Pure and client-safe.
 */
import data from "@/lib/effects/effects.json";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import { MODEL_ID_RE } from "@/lib/models-admin";
import { cleanLinkPrompt } from "@/lib/creative/improve";
import { ASPECT_RATIOS, VIDEO_DURATIONS, prefillFromQuery, type AspectRatio, type StudioModel, type StudioPrefill, type VideoDuration } from "@/lib/creative/studio";
import { fitsAfterSignup } from "@/lib/safe-redirect";
import { SIGNUP_PATH } from "@/lib/public-paths";

/** Every effect, in the order the galleries show them. effects.json holds exactly these (pinned by a test). */
export const EFFECT_IDS = [
  "photo-to-life",
  "product-burst",
  "liquid-reveal",
  "giant-in-the-city",
  "snow-globe",
  "orbit-to-street",
  "satisfying-macro",
  "time-freeze",
] as const;
export type EffectId = (typeof EFFECT_IDS)[number];

/** The two Studio tools an effect fills. */
export const EFFECT_CAPABILITIES = ["t2v", "i2v"] as const;
export type EffectCapability = (typeof EFFECT_CAPABILITIES)[number];

/** The drawing a card shows until it has a real sample (components/effects/EffectArt.tsx). */
export const EFFECT_MOTIFS = ["life", "burst", "spiral", "giant", "globe", "orbit", "macro", "freeze"] as const;
export type EffectMotif = (typeof EFFECT_MOTIFS)[number];

/** The one slot a words effect has. A picture effect has none: the picture is the subject. */
export const SUBJECT_SLOT = "{subject}";
/** The longest subject a person may put into the slot (code points). */
export const SUBJECT_MAX = 120;
/**
 * The longest template. The smallest prompt limit among the models we write for is Runway's 1000 characters (registry
 * limits.max_prompt_chars), and the subject must fit beside the template: a test checks each effect against each of its models.
 */
export const EFFECT_PROMPT_MAX = 1000 - SUBJECT_MAX;
/** At most this many models per effect: a preference list, not a catalog. */
export const EFFECT_MODELS_MAX = 6;

export interface Effect {
  id: EffectId;
  capability: EffectCapability;
  /** What the person brings: words for the slot, or one picture. */
  input: "none" | "picture";
  /** Registry ids, first choice first. */
  models: readonly string[];
  /** English, with exactly one {subject} for a words effect and none for a picture effect. */
  prompt: string;
  /** What stands in the slot until the person writes a subject: square brackets, like the Studio templates' [subject]. */
  slotHint: string | null;
  /** The clip's shape (a picture effect's clip takes the picture's shape: there this is only the card's frame). */
  aspect: AspectRatio;
  duration: VideoDuration;
  motif: EffectMotif;
  hues: readonly [string, string];
  /** A showcase entry (lib/site/showcase.json jobId) whose clip is this effect's preview; null until the operator exports one. */
  previewJobId: string | null;
}

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

// ── the words ───────────────────────────────────────────────────────────────

/**
 * A subject as an address may carry it: the link cleaning the Studio applies to words (control, bidi and invisible characters
 * out), one line, no braces (the template's own slot syntax), at most SUBJECT_MAX characters on a whole character.
 */
export function cleanSubject(raw: unknown): string {
  const words = cleanLinkPrompt("t2v", raw).replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  return Array.from(words).slice(0, SUBJECT_MAX).join("").trim();
}

/** The effect's prompt with the subject in its slot, or the slot's [hint] until there is one. A picture effect is its prompt. */
export function fillPrompt(effect: Pick<Effect, "prompt" | "slotHint">, subject: string): string {
  if (!effect.prompt.includes(SUBJECT_SLOT)) return effect.prompt;
  const s = cleanSubject(subject);
  // A function, not a string: with a string replacement, `$&`, `$'` and `` $` `` in the subject are expanded, which put the
  // template's own {subject} back and grew a 424-character template past 5000 (Lens, PR #732).
  return effect.prompt.replace(SUBJECT_SLOT, () => s || effect.slotHint || "[subject]");
}

/**
 * Whether `prompt` is this effect's own words: the template exactly, or for a words effect the template with one cleaned,
 * non-empty subject in its slot. A sample is shown as an effect's preview only when its job was given exactly these words
 * (components/effects/effect-sample.ts effectSample), so a preview is the effect's output, never some other clip.
 */
export function isEffectPrompt(effect: Pick<Effect, "prompt">, prompt: string): boolean {
  if (!effect.prompt.includes(SUBJECT_SLOT)) return prompt === effect.prompt;
  const [head, tail] = effect.prompt.split(SUBJECT_SLOT) as [string, string];
  if (prompt.length <= head.length + tail.length || !prompt.startsWith(head) || !prompt.endsWith(tail)) return false;
  const subject = prompt.slice(head.length, prompt.length - tail.length);
  return subject === cleanSubject(subject) && !/^\[.*\]$/.test(subject);
}

// ── which model ─────────────────────────────────────────────────────────────

type OfferedModel = Pick<StudioModel, "id" | "displayName" | "capabilities"> & Partial<Pick<StudioModel, "preview" | "fixedShape">>;

export type EffectAvailability =
  /**
   * `rank` 0 is the effect's first choice; above 0 the card says the first choice is not open here (the model it will use is
   * named either way). `preview`: an operator preview, which only the operator's own organization is ever offered.
   */
  | { state: "ready"; modelId: string; modelName: string; rank: number; preview: boolean; fixedShape: boolean }
  /** None of the effect's models is offered here: nothing is filled and nothing can run from the card. */
  | { state: "unavailable" };

/** The first of the effect's models the Studio offers this workspace for the effect's tool, or "unavailable". Never another one. */
export function resolveEffect(effect: Pick<Effect, "capability" | "models">, offered: readonly OfferedModel[]): EffectAvailability {
  for (let rank = 0; rank < effect.models.length; rank++) {
    const m = offered.find((o) => o.id === effect.models[rank] && o.capabilities.includes(effect.capability));
    if (m) return { state: "ready", modelId: m.id, modelName: m.displayName, rank, preview: m.preview === true, fixedShape: m.fixedShape === true };
  }
  return { state: "unavailable" };
}

// ── the links ───────────────────────────────────────────────────────────────

/** `/create?tool=<cap>&effect=<id>` (a section path: the caller puts the channel in front). The tool keeps the sidebar on Video. */
export function effectSection(effect: Pick<Effect, "id" | "capability">): string {
  return `/create?${new URLSearchParams({ tool: effect.capability, effect: effect.id }).toString()}`;
}

/** The effects gallery inside the Studio. */
export const EFFECTS_DESK_SECTION = "/create?desk=effects";

/**
 * The public site's "Use this effect": sign-up, then the Studio form under the all-channels workspace (lib/safe-redirect.ts
 * carries it through the e-mail confirmation and /welcome; only that same-origin Studio path survives). The path is built from
 * the catalog's own id and tool, never from anything a visitor typed, so it cannot point anywhere else.
 */
export function publicEffectHref(effect: Pick<Effect, "id" | "capability">): string {
  const next = `/${ALL_CHANNELS_SLUG}${effectSection(effect)}`;
  return fitsAfterSignup(next) ? `${SIGNUP_PATH}?next=${encodeURIComponent(next)}` : SIGNUP_PATH;
}

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
