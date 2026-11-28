/**
 * Effects, the client-safe half: the ids, the shapes, the words rules, the links, and the slices a Client Component is handed.
 *
 * No effect's data is here. Each effect's model preference order, its full prompt and its preview job are in
 * lib/effects/effects.json, read only by lib/effects/catalog.ts (server-only). That file once shipped whole in the public chunk
 * on /, /solutions/[slug] and the Studio, so anyone could read which vendor models we route each effect to, in which order
 * (scripts/vendor-bundle-check.mjs). The server resolves an effect's model and prompt and hands the browser the result:
 *
 *   - EffectFace: what a card draws (id, tool, shape, length, drawing, and the real sample when it has one);
 *   - EffectDeskCard: a face and which model it will use in this workspace (resolveEffect, run on the server);
 *   - CanvasEffect: what the Studio canvas needs to fill its composer from an Effects node (the prefill, worked out on the server).
 */
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import { cleanLinkPrompt } from "@/lib/creative/improve";
import type { AspectRatio, StudioPrefill, VideoDuration } from "@/lib/creative/studio";
import type { ShowcaseFiles } from "@/lib/site/showcase";
import type { ShowcaseCard } from "@/lib/site/showcase-card";
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

/** One effect in full, as lib/effects/catalog.ts parses it from effects.json. Only server code ever holds a value of it. */
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

/** An effect's real sample: the showcase card and its files (components/effects/effect-sample.ts effectSample). */
export interface EffectSample {
  entry: ShowcaseCard;
  files: ShowcaseFiles;
}

/**
 * The sample as a card is handed it: the showcase job (its clip's address), its size and its files. Not the card's model id
 * or tool: the frame never reads them, and the model that made the preview is the start of the effect's routing.
 */
export interface FaceSample {
  entry: Pick<ShowcaseCard, "jobId" | "width" | "height">;
  files: ShowcaseFiles;
}

/**
 * What a card, a banner or the public gallery draws for an effect, and all a Client Component is ever handed of it: never its
 * models, its prompt or its preview job id (the sample, when there is one, was resolved on the server).
 */
export interface EffectFace {
  id: EffectId;
  capability: EffectCapability;
  input: Effect["input"];
  aspect: AspectRatio;
  duration: VideoDuration;
  motif: EffectMotif;
  hues: readonly [string, string];
  sample: FaceSample | null;
}

export type EffectAvailability =
  /**
   * `rank` 0 is the effect's first choice; above 0 the card says the first choice is not open here (the model it will use is
   * named either way). `preview`: an operator preview, which only the operator's own organization is ever offered.
   */
  | { state: "ready"; modelId: string; modelName: string; rank: number; preview: boolean; fixedShape: boolean }
  /** None of the effect's models is offered here: nothing is filled and nothing can run from the card. */
  | { state: "unavailable" };

/**
 * resolveEffect's answer as a Client Component is handed it: the model it will use, and only whether that is not the first
 * choice (the card says so), never its place in the effect's preference order.
 */
export type EffectChoice =
  | { state: "ready"; modelId: string; modelName: string; nextChoice: boolean; preview: boolean; fixedShape: boolean }
  | { state: "unavailable" };

export function effectChoice(a: EffectAvailability): EffectChoice {
  if (a.state !== "ready") return { state: "unavailable" };
  return { state: "ready", modelId: a.modelId, modelName: a.modelName, nextChoice: a.rank > 0, preview: a.preview, fixedShape: a.fixedShape };
}

/** One card of the Studio's Effects desk: the effect's face, and the model it will use in this workspace (or that none is open). */
export interface EffectDeskCard {
  face: EffectFace;
  availability: EffectChoice;
}

/**
 * What the Studio canvas knows of an effect: its tool and colours, and the composer's starting values when one of its models
 * is offered here (null: not open in this workspace). `prefill` has no picture in it; the node's wired picture is put in by
 * the canvas (withEffectSource).
 */
export interface CanvasEffect {
  id: EffectId;
  capability: EffectCapability;
  hues: readonly [string, string];
  prefill: StudioPrefill | null;
}

/** A canvas effect's prefill with the node's wired picture in it, as effectPrefill(effect, model, "", sourceId) would build it. */
export function withEffectSource(prefill: StudioPrefill, sourceId: string | null): StudioPrefill {
  return "sourceId" in prefill ? { ...prefill, sourceId } : prefill;
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
