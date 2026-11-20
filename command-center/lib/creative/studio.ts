/**
 * The Studio's generate panel and job feed — the pure half (migration 0036
 * jobs, 0035 models). Client-safe and unit-tested (tests/studio-generate.test.ts).
 *
 * Nothing here prices anything: the price always comes from
 * /api/creative/quote (the database), and is only ever shown and echoed back
 * as `max_credits` — the ceiling the person confirmed.
 */
import {
  CREATIVE_ERRORS,
  type CreativeCapability,
  type CreativeError,
  DESCRIBE_LANGUAGES,
  type DescribeLanguage,
  DEFAULT_IMAGE_QUALITY,
  AUDIO_CAPABILITIES,
  DUB_LANGUAGES,
  type DubLanguage,
  EXPAND_ASPECTS,
  type ExpandAspect,
  IMAGE_QUALITIES,
  type ImageQuality,
  MAX_VIDEO_EDIT_WORDS,
  MEDIA_SOURCE_CAPABILITIES,
  PARAM_KEYS,
  PICTURE_OP_CAPABILITIES,
  PICTURE_OP_PROMPT_MAX,
  QUALITY_CAPABILITIES,
  RELIGHT_LOOKS,
  type RelightLook,
  ROUTE_REASONS,
  type RouteReason,
  PICTURE_SOURCE_CAPABILITIES,
  STYLE_CAPABILITIES,
  UPSCALE_FACTORS,
  UPSCALE_TARGETS,
  type UpscaleTarget,
  VIDEO_FILE_CAPABILITIES,
  VIDEO_OP_CAPABILITIES,
  VOICE_ID_RE,
  isImageQuality,
  isUuid,
} from "@/lib/creative/operations";
import { VOICES } from "@/lib/ttsModels";
import { registryName } from "@/lib/creative/model-names";
import { planGate } from "@/lib/models-discovery";
import { formatCredits } from "@/lib/credits";
import { formatTimecode } from "@/components/ui/Timecode";
import { fmt } from "@/lib/i18n/core";
import type { Dictionary } from "@/lib/i18n";

/**
 * The Studio's make-and-edit tools (templates and Home's quick tools start
 * from these). The customer sidebar lists these and the voice tools below —
 * lib/navigation's STUDIO_TOOLS mirrors COMPOSER_CAPABILITIES, and
 * tests/navigation-shell holds the two in step.
 */
export const STUDIO_CAPABILITIES = ["t2i", "t2v", "tts", "edit", "i2v", "upscale", "remove_bg"] as const satisfies readonly CreativeCapability[];

/**
 * The voice tools (migration 0050): change the voice of a recording, or dub
 * it into another language. They start from an audio or video file in the
 * library and are offered in the composer's tool rows.
 */
export const VOICE_TOOLS = ["voice_change", "dub"] as const satisfies readonly CreativeCapability[];

/**
 * The tools that READ something rather than make it (migration 0055): describe
 * a library picture as a prompt. The answer is text on the job — "Make
 * similar" then fills the image form with it; it never generates by itself.
 */
export const READ_TOOLS = ["describe"] as const satisfies readonly CreativeCapability[];

/**
 * The video tools (migration 0052): upscale a library video. They live in the
 * composer's tool rows after Describe.
 */
export const VIDEO_TOOLS = ["video_upscale"] as const satisfies readonly CreativeCapability[];

/** The sidebar's tools in the composer's order: what lib/navigation's STUDIO_TOOLS mirrors. */
export const COMPOSER_CAPABILITIES = [...STUDIO_CAPABILITIES, ...VOICE_TOOLS, ...READ_TOOLS, ...VIDEO_TOOLS] as const;

/**
 * The AI edit tools of the Enhance desk (migration 0099): extend a picture to
 * another shape, change its light, erase one named object. They are offered on
 * the desk (and by a link that names them), not in the sidebar's tool rows,
 * and each is only usable once the owner has proven and priced a model for it.
 */
export const PICTURE_OPS = PICTURE_OP_CAPABILITIES;

/**
 * The video AI edit tools of the Enhance desk (migration 0100): change a video
 * by a prompt, change its shape without cropping, take its background out.
 * Offered like the picture ops: on the desk, and only usable once the owner has
 * proven and priced a model for each.
 */
export const VIDEO_OPS = VIDEO_OP_CAPABILITIES;

/** Everything the composer can make, in the order its tabs show the tools. */
export const PANEL_CAPABILITIES = [...COMPOSER_CAPABILITIES, ...PICTURE_OPS, ...VIDEO_OPS] as const;
export type StudioCapability = (typeof PANEL_CAPABILITIES)[number];

/** The tools that start from a picture in the library (migration 0046). */
export type SourceCapability = (typeof PICTURE_SOURCE_CAPABILITIES)[number];
export type UpscaleFactor = (typeof UPSCALE_FACTORS)[number];

export function needsSource(c: string): c is SourceCapability {
  return (PICTURE_SOURCE_CAPABILITIES as readonly string[]).includes(c);
}

export { EXPAND_ASPECTS, RELIGHT_LOOKS, type ExpandAspect, type RelightLook };

export function isPictureOp(c: unknown): c is (typeof PICTURE_OPS)[number] {
  return typeof c === "string" && (PICTURE_OPS as readonly string[]).includes(c);
}

export function isVideoOp(c: unknown): c is (typeof VIDEO_OPS)[number] {
  return typeof c === "string" && (VIDEO_OPS as readonly string[]).includes(c);
}

/** An AI edit tool (0099, 0100): nothing is sold for it until the owner proves and prices a model. */
export function isAiEdit(c: unknown): boolean {
  return isPictureOp(c) || isVideoOp(c);
}

/** The tools asked by a shape: an expand extends a picture to it, a reframe changes a video to it. */
export function takesShape(c: unknown): c is "expand" | "video_reframe" {
  return c === "expand" || c === "video_reframe";
}

export function isExpandAspect(v: unknown): v is ExpandAspect {
  return typeof v === "string" && (EXPAND_ASPECTS as readonly string[]).includes(v);
}

export function isRelightLook(v: unknown): v is RelightLook {
  return typeof v === "string" && (RELIGHT_LOOKS as readonly string[]).includes(v);
}

/** The longest words a picture op takes (0099), for the field's limit. */
export function wordsMax(c: string): number {
  return isPictureOp(c) ? PICTURE_OP_PROMPT_MAX[c] : c === "video_edit" ? MAX_VIDEO_EDIT_WORDS : PROMPT_MAX;
}

/** A picture op's words are one line: line breaks and runs of spaces become one space, then cut to the limit. */
export function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** The tools that start from a recording (audio or video) in the library (migration 0050). */
export type RecordingCapability = (typeof MEDIA_SOURCE_CAPABILITIES)[number];

export function needsRecording(c: string): c is RecordingCapability {
  return (MEDIA_SOURCE_CAPABILITIES as readonly string[]).includes(c);
}

/** The tools that start from a video in the library (migration 0052). */
export type VideoCapability = (typeof VIDEO_FILE_CAPABILITIES)[number];

export function needsVideo(c: string): c is VideoCapability {
  return (VIDEO_FILE_CAPABILITIES as readonly string[]).includes(c);
}

export { UPSCALE_TARGETS, type UpscaleTarget };

export function isUpscaleTarget(v: unknown): v is UpscaleTarget {
  return typeof v === "string" && (UPSCALE_TARGETS as readonly string[]).includes(v);
}

/** The voices offered for a voice change: the same list the Create page offers for narration. */
export const STUDIO_VOICES = VOICES;
export { DUB_LANGUAGES, type DubLanguage };

export function isDubLanguage(v: unknown): v is DubLanguage {
  return typeof v === "string" && (DUB_LANGUAGES as readonly string[]).includes(v);
}

export { DESCRIBE_LANGUAGES, type DescribeLanguage };

export function isDescribeLanguage(v: unknown): v is DescribeLanguage {
  return typeof v === "string" && (DESCRIBE_LANGUAGES as readonly string[]).includes(v);
}

/** The language a description starts in: the one the person reads the app in, else English. */
export function defaultDescribeLanguage(locale: unknown): DescribeLanguage {
  return isDescribeLanguage(locale) ? locale : "en";
}

export function isVoiceId(v: unknown): v is string {
  return typeof v === "string" && VOICE_ID_RE.test(v);
}

export { IMAGE_QUALITIES, type ImageQuality, isImageQuality };

/** 0060: the picture tools that are sold by quality tier (when the model lists tiers). */
export function takesQuality(c: string): boolean {
  return (QUALITY_CAPABILITIES as readonly string[]).includes(c);
}

/**
 * The tier a model is asked for: the one picked if this model sells it, else
 * medium (the tier the database prices and the worker sends when none is
 * named), else the model's first. null = the model has no tiers, so none is
 * sent (the database refuses a tier a model does not list).
 */
export function effectiveQuality(
  model: Pick<StudioModel, "qualities"> | null | undefined,
  picked: ImageQuality | null | undefined,
): ImageQuality | null {
  const offered = model?.qualities ?? [];
  if (offered.length === 0) return null;
  if (picked && offered.includes(picked)) return picked;
  return offered.includes(DEFAULT_IMAGE_QUALITY) ? DEFAULT_IMAGE_QUALITY : offered[0];
}

/** 0070: the video tools whose clip may be made with or without a soundtrack (when the model prices it apart). */
export function takesSound(c: string): boolean {
  return (AUDIO_CAPABILITIES as readonly string[]).includes(c);
}

/**
 * The soundtrack a model is asked for: the one picked if this model sells the
 * choice, else silent (what the database prices and the worker sends when none
 * is named). null = the model offers no choice, so none is sent (the database
 * refuses audio on a model that does not price it).
 */
export function effectiveSound(model: Pick<StudioModel, "soundChoice"> | null | undefined, picked: boolean | null | undefined): boolean | null {
  if (!model?.soundChoice) return null;
  return picked === true;
}

/** 0048: the kinds a style kit can steer (the picture tools that keep their input cannot). */
export function takesStyle(c: string): boolean {
  return (STYLE_CAPABILITIES as readonly string[]).includes(c);
}

/** 0046 / 0050 / 0052 / 0055: the prompt is required for these, optional for i2v / upscale, refused for remove_bg, the voice and video tools and describe. */
export function promptRule(c: StudioCapability): "required" | "optional" | "none" {
  // A video edit is asked by its words (0100); the other video tools take none.
  if (c === "video_edit") return "required";
  if (c === "remove_bg" || c === "describe" || needsRecording(c) || needsVideo(c)) return "none";
  // expand (what the new areas show) and relight (the light, instead of a look) are asked by a choice; their words are optional.
  if (c === "i2v" || c === "upscale" || c === "expand" || c === "relight") return "optional";
  return "required";
}

/**
 * The shapes and lengths offered when a model's own lists are NOT known (sellable_models() did not answer, or a model built by
 * hand): the three every surface outside the Studio panel (the Assistant, workflows) still offers. The panel itself builds its
 * keys from the picked model's spec (shapesFor / durationsFor below): a model that lists 4, 6 and 8 seconds is never offered 5.
 */
export const ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export const VIDEO_DURATIONS = [5, 10] as const;
export type VideoDuration = (typeof VIDEO_DURATIONS)[number];

/** 0126's creative_params_problem: what an aspect_ratio must look like to be judged at all. */
export const SHAPE_RE = /^[1-9][0-9]?:[1-9][0-9]?$/;
/** 0126's creative_params_problem: a clip is a whole number of seconds from 1 to 60. */
export const CLIP_SECONDS_MIN = 1;
export const CLIP_SECONDS_MAX = 60;
/**
 * 0156's creative_params_problem: what a resolution a request NAMES must look like (the registry schema's own shape: 768p, 2k, 4k
 * as well as 720p). creative_price then sells a named resolution only at its own variant's price (0070 / 0156): a variant without a
 * credit_prices row is answered `unpriced`, which the key shows as it is.
 */
export const NAMED_RESOLUTION_RE = /^([0-9]{3,4}p|[24]k)$/;

/** The order shapes are offered in: the three everyone knows first, then wide to tall. A shape not listed here goes last. */
const SHAPE_ORDER = ["16:9", "9:16", "1:1", "21:9", "4:3", "3:2", "5:4", "4:5", "2:3", "3:4", "9:21", "5:2"];

export function isShape(v: unknown): v is string {
  return typeof v === "string" && SHAPE_RE.test(v);
}

export function isClipSeconds(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= CLIP_SECONDS_MIN && v <= CLIP_SECONDS_MAX;
}

function orderShapes(list: Iterable<string>): string[] {
  const rank = (s: string) => {
    const i = SHAPE_ORDER.indexOf(s);
    return i >= 0 ? i : SHAPE_ORDER.length;
  };
  return [...new Set(list)].filter(isShape).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function orderSeconds(list: Iterable<number>): number[] {
  return [...new Set(list)].filter(isClipSeconds).sort((a, b) => a - b);
}

export const PROMPT_MAX = 4000;

export function isStudioCapability(v: unknown): v is StudioCapability {
  return typeof v === "string" && (PANEL_CAPABILITIES as readonly string[]).includes(v);
}

// ── models (0035: members read sellable rows' public columns) ──────────────

export interface StudioModel {
  id: string;
  displayName: string;
  capabilities: string[];
  beta: boolean;
  /**
   * The registry's own 1–5 marks (spec.quality_tier / spec.speed_tier, the
   * public half sellable_models() returns). Absent or null when the registry
   * gives none: the sheet then shows no mark rather than a guessed one.
   */
  qualityTier?: number | null;
  speedTier?: number | null;
  /** 0052: the model can end an animated picture on a chosen one (spec.end_frame). */
  endFrame?: boolean;
  /** 0052: the sizes the model upscales a video to (spec.upscale_targets). */
  upscaleTargets?: UpscaleTarget[];
  /** 0052: the longest source it takes, in seconds (spec.limits.max_source_seconds); null = not stated. */
  maxSourceSeconds?: number | null;
  /** 0099: the shapes it extends a picture to (spec.aspect_ratios_by_capability.expand), in the canonical order. */
  expandAspects?: ExpandAspect[];
  /** 0099: the lights it relights with by name (spec.relight_looks), in the canonical order. */
  relightLooks?: RelightLook[];
  /** 0100: the shapes it reframes a video to (spec.aspect_ratios_by_capability.video_reframe), in the canonical order. */
  reframeAspects?: ExpandAspect[];
  /**
   * 0060: the render qualities the model is sold by (spec.qualities), cheapest
   * first; absent = it has no tiers. Prices per tier are never kept here: each
   * is asked of /api/creative/quote (the database).
   */
  qualities?: ImageQuality[];
  /**
   * 0070: the clip may be made with or without sound, each priced apart
   * (spec.audio_out and spec.pricing.variants.by audio / resolution_audio).
   * Absent = no choice. What each costs is asked of /api/creative/quote.
   */
  soundChoice?: boolean;
  /**
   * The model takes no aspect ratio: its spec states an EMPTY aspect_ratios list (the picture comes back in the model's own shape).
   * The Studio then offers no shape for a text picture / text video and sends none (buildParams). Absent = the spec was not read or
   * lists shapes: the shape is offered and sent as before.
   */
  fixedShape?: boolean;
  /**
   * 0139: a hidden model the platform operator may try in the operator's own (credits-exempt) organization before it is offered to
   * anyone. Only operator_preview_models() sets it, and that answers no rows to everyone else; the quote and the create ask the
   * database again, so the flag only decides the badge.
   */
  preview?: boolean;
  /**
   * The credit line the model's maker requires wherever it is offered and wherever its results appear (spec.attribution: Runway's
   * Terms of Use §1 ask for "Powered by Runway" linking runway.com). Absent = the maker asks for none, or the spec was not read.
   */
  attribution?: { text: string; url: string };
  /**
   * The plan entitlement the model needs (0035: `paid`, `any`, `key` or
   * `key:value`), from sellable_models(); null = none, absent = not read. Only
   * the plan dialog reads it, to name what would unlock a refused model.
   */
  entitlement?: string | null;
  /**
   * The shapes the spec lists (spec.aspect_ratios), and per tool where it narrows them (spec.aspect_ratios_by_capability). Absent =
   * the spec was not read: the panel then offers ASPECT_RATIOS and the quote decides. 0155 refuses a shape the list does not name,
   * so the panel offers exactly this list.
   */
  aspectRatios?: string[];
  shapesByCapability?: Partial<Record<string, string[]>>;
  /** The clip lengths the spec lists (spec.durations_s), shortest first. Absent = not read (VIDEO_DURATIONS is offered). */
  durations?: number[];
  /** The resolutions the spec lists, as listed (spec.resolutions), and the one a job runs at when it names none. */
  resolutions?: string[];
  defaultResolution?: string | null;
  /**
   * The price follows the resolution (spec.price_variants_by resolution / resolution_audio with a pinned default_resolution, the
   * only case creative_price prices per resolution, 0070). Only then is a resolution offered: on any other model every
   * resolution would be sold at the one rate while the vendor bills each at its own.
   */
  resolutionPriced?: boolean;
  /** When the last real call through the model's adapter worked (model_registry.verified_at); every successful probe moves it. */
  verifiedAt?: string | null;
  /**
   * Why this organization cannot buy the model right now, decided from the same rule creative_price applies (modelLock below);
   * null / absent = nothing known stops it (the quote still decides).
   */
  lock?: ModelLock | null;
}

/**
 * Why a model on sale cannot be bought by this organization, as creative_price decides it (0072 … 0155):
 *  - `first_purchase`: the model's entitlement is `paid` and the organization has made no credit purchase (and is not exempt);
 *  - `not_on_sale`: any other entitlement than `any` / `paid` — the models_image / models_video / models_audio tiers included. The
 *    database refuses these for EVERY organization whatever its plan: it never compares them with plan_entitlements (0034 marks
 *    those keys `planned`; model_tier_allowed() exists and nothing calls it). No plan or purchase opens such a model today, so
 *    none is offered for it.
 */
export type ModelLock = "first_purchase" | "not_on_sale";

/**
 * The lock for one model. `purchased`: the organization has a credit purchase or is exempt (readPurchased); null = not read, and
 * then a `paid` model is NOT shown locked (unknown is not a refusal; the quote answers). A preview (0139) skips the plan rule.
 */
export function modelLock(entitlement: string | null | undefined, purchased: boolean | null, preview = false): ModelLock | null {
  if (preview) return null;
  // The Models catalog's reading of the same rule (lib/models-discovery planGate), so the two pages cannot drift apart.
  const gate = planGate(entitlement ?? null, purchased);
  if (!gate) return null;
  if (gate.kind === "first_purchase") return gate.known ? "first_purchase" : null;
  return gate.kind === "not_open" ? "not_on_sale" : null;
}

/**
 * Which of the two refusals an `entitlement_required` answer is: from the model's own entitlement when the page knows it, else
 * from the database's sentence (creative_price words them differently). null = neither can be told: the generic sentence is shown.
 */
export function entitlementReason(entitlement: string | null | undefined, detail?: unknown): ModelLock | null {
  if (entitlement === "paid") return "first_purchase";
  if (typeof entitlement === "string" && entitlement && entitlement !== "any") return "not_on_sale";
  const d = typeof detail === "string" ? detail : "";
  if (/first credit purchase/i.test(d)) return "first_purchase";
  if (/needs the \S+ entitlement/i.test(d)) return "not_on_sale";
  return null;
}

/**
 * The shapes a model lists for a tool, exactly as 0155's quote reads them: aspect_ratios_by_capability[cap] when it names some,
 * else aspect_ratios. [] = the model makes its own shape (none may be sent). null = the spec was not read.
 */
export function modelShapes(m: Pick<StudioModel, "aspectRatios" | "shapesByCapability"> | null | undefined, cap: string): string[] | null {
  if (!m) return null;
  const narrowed = m.shapesByCapability?.[cap];
  if (narrowed && narrowed.length) return orderShapes(narrowed);
  return m.aspectRatios ? orderShapes(m.aspectRatios) : null;
}

/**
 * The shapes the panel offers for a text picture or a text video. A picked model: its own list (ASPECT_RATIOS when its spec was
 * not read). Auto: every shape some model of this kind lists — the database then routes among the models that make the one picked.
 */
export function shapesFor(
  available: readonly Pick<StudioModel, "aspectRatios" | "shapesByCapability">[],
  current: Pick<StudioModel, "aspectRatios" | "shapesByCapability"> | null,
  routed: boolean,
  cap: string,
): string[] {
  if (!routed) return modelShapes(current, cap) ?? [...ASPECT_RATIOS];
  return orderShapes(available.flatMap((m) => modelShapes(m, cap) ?? [...ASPECT_RATIOS]));
}

/** The clip lengths offered, chosen the same way as the shapes (VIDEO_DURATIONS when a spec was not read). */
export function durationsFor(
  available: readonly Pick<StudioModel, "durations">[],
  current: Pick<StudioModel, "durations"> | null,
  routed: boolean,
): number[] {
  if (!routed) return orderSeconds(current?.durations ?? VIDEO_DURATIONS);
  return orderSeconds(available.flatMap((m) => m.durations ?? VIDEO_DURATIONS));
}

/**
 * The resolutions offered for a clip: only on a hand-picked model whose price follows the resolution (Auto's model is not known
 * before the quote, like a tier). The default first stands for "send none" (what the database prices with no name); the others are
 * the listed names creative_params_problem accepts. Fewer than two = nothing to choose: no picker.
 */
export function resolutionsFor(
  current: Pick<StudioModel, "resolutions" | "defaultResolution" | "resolutionPriced"> | null,
  routed: boolean,
): string[] {
  if (routed || !current?.resolutionPriced || !current.defaultResolution) return [];
  const listed = current.resolutions ?? [];
  if (!listed.includes(current.defaultResolution)) return [];
  const out = listed.filter((r) => r === current.defaultResolution || NAMED_RESOLUTION_RE.test(r));
  return out.length > 1 ? out : [];
}

/**
 * The shape, length and resolution keys ONE model is asked at in the model sheet: what the panel would send if that model were
 * picked with the form as it is (its own list, snapped), so the sheet never shows "this model cannot" for a setting it would never
 * be sent. A value of null = the key is left out (a model that makes its own shape; the model's default resolution).
 */
export function modelSettings(
  m: StudioModel,
  cap: string,
  aspect: string,
  seconds: number,
  resolution: string | null,
): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  if (cap === "t2i" || cap === "t2v") {
    const list = modelShapes(m, cap);
    out.aspect_ratio = list === null ? (m.fixedShape ? null : aspect) : list.length ? snapShape(aspect, list) : null;
  }
  if (cap === "t2v" || cap === "i2v") {
    out.duration_s = snapSeconds(seconds, m.durations ?? []);
    out.resolution = resolution && resolution !== m.defaultResolution && resolutionsFor(m, false).includes(resolution) ? resolution : null;
  }
  return out;
}

/** The shape kept when the model changes: the one picked if the list has it, else 16:9 if it does, else the list's first. */
export function snapShape(value: string, list: readonly string[]): string {
  if (list.includes(value)) return value;
  // The orientation is kept: a tall shape goes to the tallest the model lists, a wide one to the widest (a 9:16 never turns into
  // 16:9 while the model makes some tall shape). A square, or no shape of the same orientation, goes to 16:9 when listed, else the
  // list's first. The panel says so whenever the shape changes (snapNote).
  const ratio = (s: string) => {
    const [w, h] = s.split(":").map(Number);
    return w && h ? w / h : 1;
  };
  const r = ratio(value);
  const same = list.filter((s) => (r > 1 ? ratio(s) > 1 : r < 1 ? ratio(s) < 1 : false));
  if (same.length) return same.reduce((best, s) => (r > 1 ? ratio(s) > ratio(best) : ratio(s) < ratio(best)) ? s : best, same[0]);
  if (r === 1 && list.includes("1:1")) return "1:1";
  return list.includes("16:9") ? "16:9" : (list[0] ?? value);
}

/** The length kept when the model changes: the one picked if listed, else the nearest listed (the shorter on a tie). */
export function snapSeconds(value: number, list: readonly number[]): number {
  if (list.length === 0 || list.includes(value)) return value;
  return list.reduce((best, s) => (Math.abs(s - value) < Math.abs(best - value) ? s : best), list[0]);
}

/** A resolution as people read it: 4k -> 4K, 2k -> 2K; a p-number stays as it is. */
export function resolutionLabel(r: string): string {
  return r.replace(/k$/i, "K");
}

/** Lines up a resolution for "the best it makes": 2160p and 4k are the same height. Unknown words rank last. */
function resolutionHeight(r: string): number {
  const p = /^(\d{3,4})p$/i.exec(r);
  if (p) return Number(p[1]);
  const k = /^(\d)k$/i.exec(r);
  return k ? ({ 2: 1440, 4: 2160, 8: 4320 } as Record<string, number>)[k[1]] ?? 0 : 0;
}

/**
 * The model sheet's one line of facts, from the model's own lists only ("16:9 · 9:16 · 4–8 s · up to 1080p"): its shapes for this
 * tool, its clip lengths, the largest resolution it lists. A list the spec does not state adds nothing (never a guessed fact).
 */
export function capabilityLine(t: Dictionary, m: StudioModel, cap: string): string {
  const g = t.gen;
  const parts: string[] = [];
  if (cap === "t2i" || cap === "t2v") {
    const shapes = modelShapes(m, cap);
    if (shapes && shapes.length === 0) parts.push(g.factOwnShape);
    else if (shapes) parts.push(...shapes.slice(0, 3), ...(shapes.length > 3 ? [fmt(g.factMore, { n: shapes.length - 3 })] : []));
  }
  if ((cap === "t2v" || cap === "i2v") && m.durations && m.durations.length) {
    const s = orderSeconds(m.durations);
    const lo = s[0];
    const hi = s[s.length - 1];
    if (lo !== undefined && hi !== undefined)
      parts.push(lo === hi ? fmt(g.factSeconds, { n: lo }) : fmt(g.factSecondsRange, { min: lo, max: hi }));
  }
  if ((cap === "t2v" || cap === "i2v") && m.resolutions && m.resolutions.length) {
    const best = [...m.resolutions].sort((a, b) => resolutionHeight(b) - resolutionHeight(a))[0];
    if (best && resolutionHeight(best) > 0) parts.push(fmt(g.factUpTo, { r: resolutionLabel(best) }));
  }
  return parts.join(" · ");
}

const tier = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5 ? v : null);

/**
 * spec.attribution as a link the Studio may render, or null. Only an https URL is ever an href (the schema allows nothing else, and a
 * row that says otherwise is not trusted to put a `javascript:` link in front of a member); the words are the maker's, shown as given.
 */
export function modelAttribution(v: unknown): { text: string; url: string } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const { text, url } = v as Record<string, unknown>;
  if (typeof text !== "string" || !text.trim() || text.length > 60 || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password ? { text: text.trim(), url: u.href } : null;
  } catch {
    return null;
  }
}

/**
 * Adds the registry's speed and quality marks (sellable_models() rows) to the
 * models the Studio already offers — and, from the same public spec, what a
 * model's video tools take (0052: an end frame, upscale sizes, the longest
 * source). It never adds a model: what may be picked is still coerceModels'
 * answer; a row without a mark leaves it unmarked, and a model the sellable
 * rows do not describe offers no end frame and no size (the database would
 * refuse them anyway).
 */
/**
 * Only the models `sellable_models()` lists. The RLS policy on model_registry shows a member every verified row, and it cannot know a
 * vendor-announced shutdown date (migration 0125: model_past_shutdown is revoked from signed-in users), so a model past its date would still be
 * picked here and refused by the quote. When the function answered, a model it does not list is dropped; when it did not (a missing
 * migration, an error), the list is left as it was.
 */
export function onlySellable(models: StudioModel[], sellable: unknown): StudioModel[] {
  if (!Array.isArray(sellable)) return models;
  const ids = new Set<string>();
  for (const r of sellable) {
    if (r && typeof r === "object" && typeof (r as Record<string, unknown>).id === "string") ids.add((r as { id: string }).id);
  }
  return models.filter((m) => ids.has(m.id));
}

export function withTiers(models: StudioModel[], sellable: unknown): StudioModel[] {
  if (!Array.isArray(sellable)) return models;
  type Marks = Pick<
    StudioModel,
    | "qualityTier"
    | "speedTier"
    | "entitlement"
    | "endFrame"
    | "upscaleTargets"
    | "maxSourceSeconds"
    | "qualities"
    | "soundChoice"
    | "expandAspects"
    | "relightLooks"
    | "reframeAspects"
    | "fixedShape"
    | "attribution"
    | "aspectRatios"
    | "shapesByCapability"
    | "durations"
    | "resolutions"
    | "defaultResolution"
    | "resolutionPriced"
  >;
  const marks = new Map<string, Marks>();
  for (const r of sellable) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const spec = row.spec && typeof row.spec === "object" && !Array.isArray(row.spec) ? (row.spec as Record<string, unknown>) : {};
    const limits = spec.limits && typeof spec.limits === "object" && !Array.isArray(spec.limits) ? (spec.limits as Record<string, unknown>) : {};
    const longest = limits.max_source_seconds;
    if (typeof row.id !== "string") continue;
    const targets = Array.isArray(spec.upscale_targets) ? spec.upscale_targets.filter(isUpscaleTarget) : [];
    // 0099: in the canonical order, like the tiers; only what the spec states.
    const byCap = spec.aspect_ratios_by_capability;
    const expandList =
      byCap && typeof byCap === "object" && !Array.isArray(byCap) && Array.isArray((byCap as Record<string, unknown>).expand)
        ? ((byCap as Record<string, unknown[]>).expand as unknown[])
        : [];
    const shapes = EXPAND_ASPECTS.filter((a) => expandList.includes(a));
    const reframeList =
      byCap && typeof byCap === "object" && !Array.isArray(byCap) && Array.isArray((byCap as Record<string, unknown>).video_reframe)
        ? ((byCap as Record<string, unknown[]>).video_reframe as unknown[])
        : [];
    const reframes = EXPAND_ASPECTS.filter((a) => reframeList.includes(a));
    const looks = Array.isArray(spec.relight_looks) ? RELIGHT_LOOKS.filter((l) => (spec.relight_looks as unknown[]).includes(l)) : [];
    // In the canonical order, so the selector reads low, medium, high whatever the row's order.
    const tiers = Array.isArray(spec.qualities) ? IMAGE_QUALITIES.filter((q) => (spec.qualities as unknown[]).includes(q)) : [];
    const makerLine = modelAttribution(spec.attribution);
    // The lists the quote reads (0155: shapes; 0159: lengths; 0070: resolutions), only as the spec states them.
    const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
    const shapeList = strList(spec.aspect_ratios);
    const narrowed: Partial<Record<string, string[]>> = {};
    if (byCap && typeof byCap === "object" && !Array.isArray(byCap)) {
      for (const [cap, list] of Object.entries(byCap as Record<string, unknown>)) {
        const l = strList(list);
        if (l && l.length) narrowed[cap] = orderShapes(l);
      }
    }
    const seconds = Array.isArray(spec.durations_s) ? orderSeconds(spec.durations_s.filter((x): x is number => typeof x === "number")) : null;
    const resList = strList(spec.resolutions);
    const defRes = typeof spec.default_resolution === "string" && spec.default_resolution ? spec.default_resolution : null;
    const byRes = spec.price_variants_by === "resolution" || spec.price_variants_by === "resolution_audio";
    // Only what the spec states: a model that says nothing about the video
    // tools carries nothing for them (absent reads as "no").
    marks.set(row.id, {
      qualityTier: tier(spec.quality_tier),
      speedTier: tier(spec.speed_tier),
      entitlement: typeof row.entitlement === "string" && row.entitlement ? row.entitlement : null,
      ...(spec.end_frame === true ? { endFrame: true } : {}),
      ...(targets.length ? { upscaleTargets: targets } : {}),
      ...(shapes.length ? { expandAspects: shapes } : {}),
      ...(reframes.length ? { reframeAspects: reframes } : {}),
      ...(looks.length ? { relightLooks: looks } : {}),
      ...(tiers.length ? { qualities: tiers } : {}),
      ...(spec.audio_out === true && (spec.price_variants_by === "audio" || spec.price_variants_by === "resolution_audio")
        ? { soundChoice: true }
        : {}),
      ...(typeof longest === "number" && Number.isInteger(longest) && longest > 0 ? { maxSourceSeconds: longest } : {}),
      // Only a list the spec states and leaves empty: a spec that says nothing about shapes keeps the shape picker.
      ...(Array.isArray(spec.aspect_ratios) && spec.aspect_ratios.length === 0 ? { fixedShape: true } : {}),
      ...(makerLine ? { attribution: makerLine } : {}),
      ...(shapeList ? { aspectRatios: orderShapes(shapeList) } : {}),
      ...(Object.keys(narrowed).length ? { shapesByCapability: narrowed } : {}),
      ...(seconds ? { durations: seconds } : {}),
      ...(resList ? { resolutions: resList } : {}),
      ...(defRes ? { defaultResolution: defRes } : {}),
      ...(byRes && defRes && resList?.includes(defRes) ? { resolutionPriced: true } : {}),
    });
  }
  return models.map((m) => {
    const k = marks.get(m.id);
    return k ? { ...m, ...k } : m;
  });
}

/** model_registry rows -> what can be picked: beta/ga AND verified, nothing else. */
export function coerceModels(rows: unknown): StudioModel[] {
  if (!Array.isArray(rows)) return [];
  const out: StudioModel[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id) continue;
    if (row.availability !== "beta" && row.availability !== "ga") continue;
    if (!row.verified_at) continue;
    const caps = Array.isArray(row.capabilities) ? row.capabilities.filter((c): c is string => typeof c === "string") : [];
    if (!caps.length) continue;
    out.push({
      id: row.id,
      displayName: typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : row.id,
      capabilities: caps,
      beta: row.availability === "beta",
      verifiedAt: typeof row.verified_at === "string" ? row.verified_at : null,
    });
  }
  return out;
}

/**
 * 0139: operator_preview_models() rows as Studio models marked `preview`. The database answers rows only to a platform admin in the
 * exempt organization; a row without an id, a name or a capability is dropped. The marks (speed, quality, what the tools take) come
 * from the same public half of spec, through withTiers, so a preview is described exactly like a model on sale.
 */
export function coercePreviewModels(rows: unknown): StudioModel[] {
  if (!Array.isArray(rows)) return [];
  const out: StudioModel[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id) continue;
    const caps = Array.isArray(row.capabilities) ? row.capabilities.filter((c): c is string => typeof c === "string") : [];
    if (!caps.length) continue;
    out.push({
      id: row.id,
      displayName: typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : row.id,
      capabilities: caps,
      beta: false,
      preview: true,
      verifiedAt: typeof row.verified_at === "string" ? row.verified_at : null,
    });
  }
  return withTiers(out, rows);
}

/**
 * The Studio's list with the operator's previews added after the models on sale. A model already on sale is never listed twice
 * (it stopped being a preview the day it was opened).
 */
export function withPreviews(models: StudioModel[], previews: StudioModel[]): StudioModel[] {
  const ids = new Set(models.map((m) => m.id));
  return [...models, ...previews.filter((m) => !ids.has(m.id))];
}

export function modelsFor(models: StudioModel[], capability: string): StudioModel[] {
  return models.filter((m) => m.capabilities.includes(capability));
}

// ── the request ────────────────────────────────────────────────────────────

export interface StudioForm {
  capability: StudioCapability;
  prompt: string;
  /** A shape the picked model lists (the panel snaps it to the model's list: shapesFor / snapShape). */
  aspect: string;
  /** Seconds, one the picked model lists (durationsFor / snapSeconds). */
  duration: number;
  /**
   * A clip's resolution (0070), named only when it is not the model's pinned default (resolutionsFor): null / absent = the key is
   * left out, and the database prices and the worker sends the default.
   */
  resolution?: string | null;
  /** The library picture edit / i2v / upscale / remove_bg start from. */
  sourceId?: string | null;
  factor?: UpscaleFactor;
  /** A style kit of the organization (0048); null / absent = no style. */
  styleKitId?: string | null;
  /** The voice speech or a voice change speaks in: one of the account's voices, picked — never defaulted. */
  voiceId?: string | null;
  /** The language a dub is made in (0050). */
  targetLanguage?: DubLanguage | null;
  /** The picture an animation ends on (0052); only sent for a model that takes one. */
  endFrameId?: string | null;
  /** The size a video upscale makes (0052). */
  target?: UpscaleTarget | null;
  /** The shape an expand extends the picture to (0099), or a reframe changes the video to (0100). */
  shape?: ExpandAspect | null;
  /** The light a relight is asked for by name (0099); the words replace it when typed. */
  look?: RelightLook | null;
  /** The language a description is written in (0055); absent = English. */
  describeLanguage?: DescribeLanguage | null;
  /**
   * The picture's render quality (0060): only sent for a picture tool whose
   * model sells tiers (the panel passes the model's effective tier, else
   * null). null / absent = the key is left out.
   */
  quality?: ImageQuality | null;
  /**
   * The clip's soundtrack (0070): only sent for a video tool whose model sells
   * the choice (the panel passes the model's effective setting, else null).
   * null / absent = the key is left out (silent).
   */
  audio?: boolean | null;
  /**
   * The picked model takes no aspect ratio (StudioModel.fixedShape): a text picture / text video is sent without one, so the
   * model makes its own shape. The panel passes it for the hand-picked model only (Auto's model is not known before the quote).
   * null / absent = the aspect is sent as before.
   */
  noAspect?: boolean | null;
}

type ParamKey = (typeof PARAM_KEYS)[number];

/**
 * Only what 0036 / 0046 / 0048's creative_params_problem accepts for the
 * capability. The source tools keep the picture's own shape, so they never
 * send an aspect ratio; an empty optional prompt is left out rather than sent
 * blank; "no style" is the key left out, never sent empty. @names stay in the
 * prompt as typed — the worker resolves them.
 */
export function buildParams(form: StudioForm): Partial<Record<ParamKey, string | number | boolean>> {
  const base = baseParams(form);
  const styled = takesStyle(form.capability) && isUuid(form.styleKitId) ? { ...base, style_kit_id: form.styleKitId } : base;
  // A tier only for the picture tools, and never an unnamed one (the database refuses a tier on any other tool).
  const tiered = takesQuality(form.capability) && isImageQuality(form.quality) ? { ...styled, quality: form.quality } : styled;
  // The soundtrack only for the video tools, and only a real choice (the database refuses it on any other tool).
  return takesSound(form.capability) && typeof form.audio === "boolean" ? { ...tiered, audio: form.audio } : tiered;
}

function isNamedResolution(v: unknown): v is string {
  return typeof v === "string" && NAMED_RESOLUTION_RE.test(v);
}

function baseParams(form: StudioForm): Partial<Record<ParamKey, string | number>> {
  const prompt = form.prompt.trim();
  const source = form.sourceId ?? "";
  switch (form.capability) {
    case "t2i":
      return form.noAspect === true ? { prompt } : { prompt, aspect_ratio: form.aspect };
    case "t2v":
      return {
        ...(form.noAspect === true ? { prompt } : { prompt, aspect_ratio: form.aspect }),
        duration_s: form.duration,
        ...(isNamedResolution(form.resolution) ? { resolution: form.resolution } : {}),
      };
    case "edit":
      return { prompt, source_asset_id: source };
    case "i2v":
      // "No end frame" is the key left out, never sent empty.
      return {
        ...(prompt ? { prompt } : {}),
        source_asset_id: source,
        duration_s: form.duration,
        ...(isNamedResolution(form.resolution) ? { resolution: form.resolution } : {}),
        ...(isUuid(form.endFrameId) ? { end_asset_id: form.endFrameId } : {}),
      };
    case "upscale":
      return { ...(prompt ? { prompt } : {}), source_asset_id: source, factor: form.factor ?? 2 };
    case "expand": {
      // The shape is the ask; the words (optional) say what the new areas show.
      const words = oneLine(form.prompt, PICTURE_OP_PROMPT_MAX.expand);
      return { ...(words ? { prompt: words } : {}), source_asset_id: source, aspect_ratio: form.shape ?? "" };
    }
    case "relight": {
      // EXACTLY ONE of the words and the look: typed words win, the chip is then not sent (0099 refuses both).
      const words = oneLine(form.prompt, PICTURE_OP_PROMPT_MAX.relight);
      return words ? { source_asset_id: source, prompt: words } : { source_asset_id: source, look: form.look ?? "" };
    }
    case "erase":
      return { source_asset_id: source, prompt: oneLine(form.prompt, PICTURE_OP_PROMPT_MAX.erase) };
    case "video_edit":
      // What to change, on one line. The length (and so the price) is the video's own: never sent (0100).
      return { source_asset_id: source, prompt: oneLine(form.prompt, MAX_VIDEO_EDIT_WORDS) };
    case "video_reframe":
      return { source_asset_id: source, aspect_ratio: form.shape ?? "" };
    case "video_remove_bg":
      return { source_asset_id: source };
    case "remove_bg":
      return { source_asset_id: source };
    case "describe":
      // The picture is the whole input: no words, no shape (0055 refuses them).
      return isDescribeLanguage(form.describeLanguage)
        ? { source_asset_id: source, language: form.describeLanguage }
        : { source_asset_id: source };
    case "voice_change":
      // The length (and so the price) is the recording's own: never sent.
      return { source_asset_id: source, voice_id: form.voiceId ?? "" };
    case "dub":
      return { source_asset_id: source, target_language: form.targetLanguage ?? "" };
    case "video_upscale":
      // The length (and so the price) is the video's own: never sent.
      return { source_asset_id: source, target_resolution: form.target ?? "" };
    default:
      // Speech: the words are the prompt (the price counts their characters)
      // and the voice is the one picked — the speech provider needs one.
      return isVoiceId(form.voiceId) ? { prompt, voice_id: form.voiceId } : { prompt };
  }
}

/**
 * Enough to ask for a price: the picture or recording when the tool needs
 * one, the voice / language a voice tool needs, the words when they are required.
 */
export function canQuote(form: StudioForm): boolean {
  return blockedReason(form, true) === null;
}

/** One key per click: a replayed click answers the first job instead of paying twice. */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const id = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `studio:${id}`;
}

/** What the person can do next when Generate cannot be pressed (null: it can, or it is busy). */
export type BlockedReason =
  | "no_model"
  | "need_picture"
  | "need_recording"
  | "need_video"
  | "need_target"
  | "need_shape"
  | "need_look"
  | "need_object"
  | "need_voice"
  | "need_language"
  | "need_words";

export function blockedReason(form: StudioForm, hasModel: boolean): BlockedReason | null {
  if (!hasModel) return "no_model";
  if (needsSource(form.capability) && !isUuid(form.sourceId)) return "need_picture";
  if (needsRecording(form.capability) && !isUuid(form.sourceId)) return "need_recording";
  if (needsVideo(form.capability) && !isUuid(form.sourceId)) return "need_video";
  if (form.capability === "video_upscale" && !isUpscaleTarget(form.target)) return "need_target";
  if ((form.capability === "expand" || form.capability === "video_reframe") && !isExpandAspect(form.shape)) return "need_shape";
  if (form.capability === "relight" && !isRelightLook(form.look) && !form.prompt.trim()) return "need_look";
  if (form.capability === "erase" && !oneLine(form.prompt, PROMPT_MAX)) return "need_object";
  if (form.capability === "voice_change" && !isVoiceId(form.voiceId)) return "need_voice";
  if (form.capability === "dub" && !isDubLanguage(form.targetLanguage)) return "need_language";
  if (promptRule(form.capability) === "required" && !form.prompt.trim()) return "need_words";
  // Speech: the words first, then the voice that speaks them.
  if (form.capability === "tts" && !isVoiceId(form.voiceId)) return "need_voice";
  return null;
}

/**
 * Kinds whose price does not depend on the words (0046's creative_quantity:
 * one picture, or seconds of video; 0050: the recording's seconds). For these
 * the model sheet can ask the database for each model's price before
 * anything is typed — the words, a voice tool's voice and a dub's language
 * are stand-ins that the price never reads. Speech is priced by its
 * characters, so it waits for the real words. Must follow creative_quantity
 * (and 0050's creative_source_seconds) if they change.
 */
export const WORDS_FREE_PRICE: readonly StudioCapability[] = [
  "t2i",
  "t2v",
  "edit",
  "i2v",
  "upscale",
  "remove_bg",
  "voice_change",
  "dub",
  "video_upscale",
  "describe",
  // 0099: one picture each, whatever the shape, the light or the object.
  "expand",
  "relight",
  "erase",
  // 0100: priced by the video's own seconds, whatever the words or the shape.
  "video_edit",
  "video_reframe",
  "video_remove_bg",
];
const PRICE_STAND_IN = "price check";

/**
 * The params the model sheet prices each model with: the form's own when it
 * is complete, else (for a kind priced without words) the same settings with
 * a stand-in description. null = no honest price can be asked for yet (no
 * picture picked, or speech without its words). Only ever sent to
 * /api/creative/quote — never to create.
 */
export function sheetQuoteParams(form: StudioForm): ReturnType<typeof buildParams> | null {
  if (canQuote(form)) return buildParams(form);
  // Speech is priced by its words, not its voice: with the words typed, the
  // sheet can show prices before a voice is picked.
  if (form.capability === "tts" && form.prompt.trim()) {
    return buildParams({ ...form, voiceId: isVoiceId(form.voiceId) ? form.voiceId : (STUDIO_VOICES[0]?.id ?? null) });
  }
  if ((needsSource(form.capability) || needsRecording(form.capability) || needsVideo(form.capability)) && !isUuid(form.sourceId))
    return null;
  // A video upscale is priced per size: no stand-in size is ever asked about.
  if (form.capability === "video_upscale" && !isUpscaleTarget(form.target)) return null;
  // An expand is quoted for the shape asked; no stand-in shape is ever asked about.
  if ((form.capability === "expand" || form.capability === "video_reframe") && !isExpandAspect(form.shape)) return null;
  if (!WORDS_FREE_PRICE.includes(form.capability)) return null;
  return buildParams({
    ...form,
    prompt: PRICE_STAND_IN,
    voiceId: isVoiceId(form.voiceId) ? form.voiceId : (STUDIO_VOICES[0]?.id ?? null),
    targetLanguage: isDubLanguage(form.targetLanguage) ? form.targetLanguage : DUB_LANGUAGES[0],
  });
}

/**
 * The params a model's quality tiers are priced with (0060): the form's own
 * settings with a stand-in for the words, so the price check neither sends
 * what the person is typing nor re-asks on every pause while they type (a
 * picture's price never reads its words). null = no honest price can be asked
 * for yet (not a tiered tool, or an edit without its picture). The tier itself
 * is added per request, never kept here.
 */
export function tierQuoteParams(form: StudioForm): ReturnType<typeof buildParams> | null {
  if (!takesQuality(form.capability)) return null;
  if (needsSource(form.capability) && !isUuid(form.sourceId)) return null;
  return buildParams({ ...form, prompt: PRICE_STAND_IN, quality: null });
}

/**
 * The params a model's two soundtrack settings (0070) are priced with: the
 * form's own settings with a stand-in for the words, like the tiers — a
 * clip's price never reads its words, so the check neither sends what the
 * person is typing nor re-asks on every pause. null = no honest price can be
 * asked for yet (not a tool with a soundtrack, or a clip from a picture before
 * the picture is picked). The setting itself is added per request.
 */
export function soundQuoteParams(form: StudioForm): ReturnType<typeof buildParams> | null {
  if (!takesSound(form.capability)) return null;
  if (needsSource(form.capability) && !isUuid(form.sourceId)) return null;
  return buildParams({ ...form, prompt: PRICE_STAND_IN, audio: null });
}

/** The most models the sheet prices at once: each is one quote call. */
export const SHEET_PRICE_MAX = 8;

// ── the button and the errors ──────────────────────────────────────────────

export type QuoteState =
  | { status: "idle" }
  | { status: "quoting" }
  // `routed`: Auto's pick (0075) — the model the database chose, why, and the
  // display name it answered; the press sends that model back with the price.
  | { status: "ready"; credits: number; routed?: RoutedPick }
  // `detail`: the database's own sentence for a refusal, when the route passed it (only read to tell two entitlement refusals apart).
  | { status: "error"; code: CreativeError; detail?: string };

/** What Auto picked: the model, its name to show, and why (a reason code). */
export interface RoutedPick {
  model: string;
  name: string;
  reason: RouteReason | null;
}

/**
 * A routed quote's answer (quote_creative_route) -> the pick, or null when the
 * answer does not name one (then nothing may be started from it).
 */
export function routedPick(q: Record<string, unknown> | null | undefined, names?: ReadonlyMap<string, string>): RoutedPick | null {
  if (!q) return null;
  const model = typeof q.routed_model === "string" ? q.routed_model : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(model)) return null;
  const reason =
    typeof q.route_reason === "string" && (ROUTE_REASONS as readonly string[]).includes(q.route_reason)
      ? (q.route_reason as RouteReason)
      : null;
  const name = names?.get(model) ?? (typeof q.display_name === "string" && q.display_name.trim() ? q.display_name : model);
  return { model, name, reason };
}

/** "Auto picked X for N credits" and the reason, in the person's language. */
export function routedLine(t: Dictionary, pick: RoutedPick, credits: number, locale = "en"): { picked: string; why: string | null } {
  return {
    picked: fmt(t.gen.router.picked, { model: pick.name, n: formatCredits(credits, locale) }),
    why: pick.reason ? fmt(t.gen.router.why, { reason: t.gen.router.reasons[pick.reason] }) : null,
  };
}

/**
 * Price on the button: "Generate · N credits" once the database has priced it
 * ("Describe · N credits" for a description: the press pays for text, not a picture).
 */
export function generateLabel(t: Dictionary, quote: QuoteState, locale = "en", capability?: string): string {
  if (quote.status === "quoting") return t.gen.quoting;
  const reads = capability === "describe";
  if (quote.status === "ready")
    return fmt(reads ? t.gen.describePriced : t.gen.generatePriced, { n: formatCredits(quote.credits, locale) });
  return reads ? t.gen.describe : t.gen.generate;
}

export function asCreativeError(code: unknown): CreativeError {
  return typeof code === "string" && (CREATIVE_ERRORS as readonly string[]).includes(code)
    ? (code as CreativeError)
    : "failed";
}

/**
 * The video-upscale sizes to offer. A picked model: its own. Auto: every size
 * some model of this kind makes (in the fixed order) — never the hand-picked
 * model's list, which Auto does not use; the database then picks among the
 * models that make the chosen size (BR-L-024).
 */
export function upscaleTargetsFor(
  available: readonly Pick<StudioModel, "upscaleTargets">[],
  current: Pick<StudioModel, "upscaleTargets"> | null,
  routed: boolean,
): UpscaleTarget[] {
  if (!routed) return current?.upscaleTargets ?? [];
  return UPSCALE_TARGETS.filter((x) => available.some((m) => m.upscaleTargets?.includes(x)));
}

/**
 * The shapes an expand offers. A picked model: its own. Auto: every shape some
 * model of this kind extends to (in the fixed order) — never the hand-picked
 * model's list, which Auto does not use; the database then picks among the
 * models that make the chosen shape.
 */
export function expandShapesFor(
  available: readonly Pick<StudioModel, "expandAspects">[],
  current: Pick<StudioModel, "expandAspects"> | null,
  routed: boolean,
): ExpandAspect[] {
  if (!routed) return current?.expandAspects ?? [];
  return EXPAND_ASPECTS.filter((x) => available.some((m) => m.expandAspects?.includes(x)));
}

/** The lights a relight offers by name, chosen the same way as the shapes. */
export function reframeShapesFor(
  available: readonly Pick<StudioModel, "reframeAspects">[],
  current: Pick<StudioModel, "reframeAspects"> | null,
  routed: boolean,
): ExpandAspect[] {
  if (!routed) return current?.reframeAspects ?? [];
  return EXPAND_ASPECTS.filter((x) => available.some((m) => m.reframeAspects?.includes(x)));
}

/** The lights a relight offers by name, chosen the same way as the shapes. */
export function relightLooksFor(
  available: readonly Pick<StudioModel, "relightLooks">[],
  current: Pick<StudioModel, "relightLooks"> | null,
  routed: boolean,
): RelightLook[] {
  if (!routed) return current?.relightLooks ?? [];
  return RELIGHT_LOOKS.filter((x) => available.some((m) => m.relightLooks?.includes(x)));
}

/** A route's error code -> the sentence the person reads (never the code itself). */
export function apiErrorMessage(t: Dictionary, code: unknown): string {
  return t.creative.errors[asCreativeError(code)];
}

/**
 * What the panel offers next to the message: credits (the Credits page, and
 * the plan dialog), plans (the plan dialog: a model the plan does not open,
 * or every parallel run busy), or a fresh price.
 */
export function errorAction(code: unknown): "credits" | "plans" | "requote" | null {
  const c = asCreativeError(code);
  if (c === "insufficient_credits") return "credits";
  if (c === "entitlement_required" || c === "run_limit_reached") return "plans";
  if (c === "price_changed" || c === "route_changed") return "requote";
  return null;
}

// ── jobs ───────────────────────────────────────────────────────────────────

export const ACTIVE_STATUSES = ["queued", "planning", "running", "provider_pending", "processing", "rendering"] as const;

export function isActiveStatus(status: unknown): boolean {
  return typeof status === "string" && (ACTIVE_STATUSES as readonly string[]).includes(status);
}

export interface StudioJob {
  id: string;
  capability: string;
  status: string;
  requested_model: string;
  /** 0075: the model that runs the job (exact: the one picked; Auto: its pick, or a failover). */
  routed_model?: string | null;
  /** 0075: the model a routed job moved away from, and why (an error code). */
  fallback_from?: string | null;
  fallback_reason?: string | null;
  params: Record<string, unknown>;
  quoted_credits: number;
  charged_credits: number | null;
  error_code: string | null;
  result: Record<string, unknown> | null;
  result_asset_ids: string[];
  created_at: string;
  /** 0036: when a worker claimed it (null while it waits in line) and when it ended. They time the placeholder's estimate. */
  started_at?: string | null;
  finished_at?: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Jobs of tools that live in the editor, not in the Studio (0072: captions —
 * the result is a transcript the editor turns into captions, not a card).
 * The Studio's feed and Home's recent strip skip them.
 */
const EDITOR_ONLY_CAPABILITIES = ["captions"];

export function coerceJobs(rows: unknown): StudioJob[] {
  if (!Array.isArray(rows)) return [];
  const out: StudioJob[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const j = r as Record<string, unknown>;
    if (typeof j.id !== "string" || typeof j.status !== "string") continue;
    if (typeof j.capability === "string" && EDITOR_ONLY_CAPABILITIES.includes(j.capability)) continue;
    const params = j.params && typeof j.params === "object" && !Array.isArray(j.params) ? (j.params as Record<string, unknown>) : {};
    const result = j.result && typeof j.result === "object" && !Array.isArray(j.result) ? (j.result as Record<string, unknown>) : null;
    out.push({
      id: j.id,
      capability: typeof j.capability === "string" ? j.capability : "",
      status: j.status,
      requested_model: typeof j.requested_model === "string" ? j.requested_model : "",
      routed_model: typeof j.routed_model === "string" ? j.routed_model : null,
      fallback_from: typeof j.fallback_from === "string" ? j.fallback_from : null,
      fallback_reason: typeof j.fallback_reason === "string" ? j.fallback_reason : null,
      params,
      quoted_credits: num(j.quoted_credits) ?? 0,
      charged_credits: num(j.charged_credits),
      error_code: typeof j.error_code === "string" ? j.error_code : null,
      result,
      result_asset_ids: Array.isArray(j.result_asset_ids) ? j.result_asset_ids.filter((x): x is string => typeof x === "string") : [],
      created_at: typeof j.created_at === "string" ? j.created_at : "",
      started_at: typeof j.started_at === "string" ? j.started_at : null,
      finished_at: typeof j.finished_at === "string" ? j.finished_at : null,
    });
  }
  return out;
}

export function kindLabel(t: Dictionary, capability: string): string {
  const k = t.gen.kinds as Record<string, string>;
  return k[capability] ?? capability;
}

export function truncate(text: string, max = 120): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export type StatusTone = "idle" | "run" | "ok" | "fail" | "warn";

export function statusView(t: Dictionary, status: string): { tone: StatusTone; label: string; live: boolean } {
  if (status === "queued") return { tone: "idle", label: t.gen.status.queued, live: false };
  if (isActiveStatus(status)) return { tone: "run", label: t.gen.status.active, live: true };
  if (status === "completed") return { tone: "ok", label: t.gen.status.completed, live: false };
  if (status === "cancelled") return { tone: "idle", label: t.gen.status.cancelled, live: false };
  if (status === "expired") return { tone: "warn", label: t.gen.status.expired, live: false };
  return { tone: "fail", label: t.gen.status.failed, live: false };
}

/** Held while it runs, charged when it worked, returned otherwise (0036 releases the hold itself). */
export function creditsLine(t: Dictionary, job: StudioJob, locale = "en"): string {
  if (isActiveStatus(job.status)) return fmt(t.gen.held, { n: formatCredits(job.quoted_credits, locale) });
  if (job.status === "completed") return fmt(t.gen.charged, { n: formatCredits(job.charged_credits ?? job.quoted_credits, locale) });
  return t.gen.returned;
}

/** Ended without a result: offered "Try again" and "Dismiss". */
export function isUnsuccessful(status: string): boolean {
  return status === "failed" || status === "cancelled" || status === "expired";
}

const REASON_GROUPS: Record<string, keyof Dictionary["gen"]["reasons"]> = {
  policy: "policy",
  bad_request: "bad_request",
  // The vendor refused an option sent through its tool (the aspect ratio): the person changes the settings (0143).
  vendor_tool_unsupported: "bad_request",
  // The vendor account's plan refuses the voice (a library voice on a free ElevenLabs plan, 0183): pick another, it is not "busy".
  plan_required: "plan",
  rate_limited: "busy",
  unavailable: "busy",
  provider_timeout: "busy",
  quota: "busy",
  auth: "service",
  not_configured: "service",
  adapter_missing: "service",
  not_found: "service",
  bad_response: "service",
  provider_error: "service",
  payer_not_supported: "service",
  mode_not_supported: "service",
  submit_interrupted: "service",
  worker_lost: "service",
  credits_unavailable: "credits",
  no_credit_hold: "credits",
  hold_not_open: "credits",
  hold_below_quote: "credits",
  style_unavailable: "style",
  not_picked_up: "expired",
  cancelled: "cancelled",
  // 0072: a recording with no speech, or too many words for one track.
  no_speech: "no_speech",
  too_many_words: "bad_request",
};

/** The model that made (or makes) a job: a failover's model when there was one (0075). */
export function jobModel(job: Pick<StudioJob, "requested_model" | "routed_model">): string {
  return job.routed_model || job.requested_model;
}

/**
 * "Made with X: Y was unavailable." for a routed job that moved to another
 * model (0075); null otherwise. Model ids become their names; the code is
 * never shown.
 */
export function fellBackLine(
  t: Dictionary,
  job: Pick<StudioJob, "routed_model" | "fallback_from">,
  names: ReadonlyMap<string, string>,
): string | null {
  if (!job.fallback_from || !job.routed_model || job.fallback_from === job.routed_model) return null;
  return fmt(t.gen.router.fellBack, {
    model: names.get(job.routed_model) ?? registryName(job.routed_model),
    from: names.get(job.fallback_from) ?? registryName(job.fallback_from),
  });
}

/** A finished job's error_code -> a plain sentence (internal codes never reach the screen). */
export function failureReason(t: Dictionary, job: Pick<StudioJob, "status" | "error_code">): string {
  const group =
    (job.error_code && REASON_GROUPS[job.error_code]) ||
    (job.status === "cancelled" ? "cancelled" : job.status === "expired" ? "expired" : "generic");
  return t.gen.reasons[group];
}

/** A link to the result when the job carries a web address for it; else null (see the Library). */
export function resultHref(job: Pick<StudioJob, "result">): string | null {
  const r = job.result;
  if (!r) return null;
  const ok = (v: unknown): v is string => typeof v === "string" && /^https:\/\/[^\s]+$/i.test(v);
  if (ok(r.url)) return r.url;
  if (Array.isArray(r.files)) {
    for (const f of r.files) {
      if (f && typeof f === "object" && ok((f as Record<string, unknown>).url)) return (f as { url: string }).url;
    }
  }
  return null;
}

/** Tools whose result is the same picture changed: shown against it, before and after. */
export const COMPARE_CAPABILITIES = ["edit", "upscale", "remove_bg", "expand", "relight", "erase"] as const;

/** A finished picture job's source and first result, when both are known; else null. */
export function compareSources(job: Pick<StudioJob, "status" | "capability" | "params" | "result_asset_ids">): {
  before: string;
  after: string;
} | null {
  if (job.status !== "completed") return null;
  if (!(COMPARE_CAPABILITIES as readonly string[]).includes(job.capability)) return null;
  const before = job.params.source_asset_id;
  const after = job.result_asset_ids[0];
  return isUuid(before) && isUuid(after) ? { before, after } : null;
}

/** Kinds whose result is a picture another tool can start from. */
const PICTURE_RESULTS = ["t2i", "edit", "upscale", "remove_bg", "expand", "relight", "erase"] as const;

/** "Use as picture": the finished job's first result, when it is a library picture; else null. */
export function sourceFromJob(job: Pick<StudioJob, "status" | "capability" | "result_asset_ids">): string | null {
  if (job.status !== "completed") return null;
  if (!(PICTURE_RESULTS as readonly string[]).includes(job.capability)) return null;
  const id = job.result_asset_ids[0];
  return isUuid(id) ? id : null;
}

// ── descriptions (0055) ────────────────────────────────────────────────────

export interface DescribeResult {
  text: string;
  language: DescribeLanguage;
  /** The picture's pixel size as the library recorded it, when known. */
  width: number | null;
  height: number | null;
}

/** A finished description: its text (never more than 0055 allows) and the picture's size; else null. */
export function describeResult(job: Pick<StudioJob, "status" | "capability" | "result">): DescribeResult | null {
  if (job.status !== "completed" || job.capability !== "describe" || !job.result) return null;
  const r = job.result;
  const text = typeof r.text === "string" ? r.text.trim().slice(0, DESCRIBE_MAX) : "";
  if (!text) return null;
  const px = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
  return {
    text,
    language: isDescribeLanguage(r.language) ? r.language : "en",
    width: px(r.width),
    height: px(r.height),
  };
}

/** 0055's longest description. */
export const DESCRIBE_MAX = 600;

/**
 * The composer's shape nearest to a picture's own; the form's usual 16:9 when
 * the size is not known (the person sees it picked and can change it).
 */
export function nearestAspect(width: number | null, height: number | null): AspectRatio {
  if (!width || !height) return "16:9";
  const r = Math.log(width / height);
  const options: [AspectRatio, number][] = [
    ["16:9", Math.log(16 / 9)],
    ["9:16", Math.log(9 / 16)],
    ["1:1", 0],
  ];
  return options.reduce((best, o) => (Math.abs(o[1] - r) < Math.abs(best[1] - r) ? o : best))[0];
}

/**
 * "Make similar": the image form with the description as its words and the
 * picture's shape. It FILLS the form only — the person still reads the price
 * on Generate and presses it; nothing is made from here.
 */
export function similarPrefill(d: Pick<DescribeResult, "text" | "width" | "height">): StudioPrefill {
  return {
    capability: "t2i",
    model: "",
    prompt: d.text.slice(0, PROMPT_MAX),
    aspect: nearestAspect(d.width, d.height),
    duration: 5,
  };
}

/** "Describe" from a finished picture: the composer on describe with that picture; priced there, never started here. */
export function describePrefill(assetId: string, language: DescribeLanguage): StudioPrefill | null {
  if (!isUuid(assetId)) return null;
  return { capability: "describe", model: "", prompt: "", aspect: "16:9", duration: 5, sourceId: assetId, factor: 2, describeLanguage: language };
}

/** What a finished job made, for its card: a picture, a clip, a voice or (a description) text. */
export function outputKind(capability: string): "image" | "video" | "audio" | "text" {
  if (capability === "describe") return "text";
  if (capability === "t2v" || capability === "i2v" || needsVideo(capability)) return "video";
  if (capability === "tts" || capability === "sfx" || capability === "music" || needsRecording(capability)) return "audio";
  return "image";
}

const RATIO = /^(\d{1,2}):(\d{1,2})$/;

/**
 * The card's shape. `asked`: it is the shape the form sent (an expand's 4:3 included), which the result comes back in,
 * so the placeholder and the finished card are the same frame and the result appears in the place it held.
 *
 * Without one — a model that takes no shape (StudioModel.fixedShape: the picture comes back in the model's own) and
 * the tools that keep their source's shape (upscale, edit, remove_bg, relight, i2v, video_upscale) — the shape is not
 * known until the file is, and the two states differ on purpose:
 *  - working (the placeholder): a neutral 3:2 for a picture, 16:9 for a clip, so something the size of a likely
 *    result holds its place — grounded-image-1.0 returned 1920x1280 in practice, which 3:2 happens to match;
 *  - ended: the square every such card always had. A finished card is drawn object-cover; a guessed 3:2 or 16:9
 *    frame would crop a portrait upscale or a square cut-out to a strip of its middle. The result fades into the
 *    square from the placeholder (JobFeed's gen-reveal), which is a change of frame, not a jump inside one.
 * A sound or a description: a wide bar, either way.
 */
export function cardShape(job: Pick<StudioJob, "capability" | "params" | "status">): { aspect: string; asked: boolean } {
  const kind = outputKind(job.capability);
  if (kind === "audio" || kind === "text") return { aspect: "16 / 7", asked: false };
  const a = job.params.aspect_ratio;
  const m = typeof a === "string" ? RATIO.exec(a) : null;
  const w = m ? Number(m[1]) : 0;
  const h = m ? Number(m[2]) : 0;
  if (w > 0 && h > 0) return { aspect: `${w} / ${h}`, asked: true };
  if (!isActiveStatus(job.status)) return { aspect: "1 / 1", asked: false };
  return { aspect: kind === "video" ? "16 / 9" : "3 / 2", asked: false };
}

export function cardAspect(job: Pick<StudioJob, "capability" | "params" | "status">): string {
  return cardShape(job).aspect;
}

/**
 * The edge print of a result's frame (IDENTITY.md §Signature devices): only
 * facts the job itself carries — the shape it was asked for, a clip's length,
 * the credits held or charged. Nothing is guessed: an unknown shape or length
 * is left off, and a job that ended without a result prints no price.
 */
export function edgeFacts(t: Dictionary, job: StudioJob, locale = "en"): string[] {
  const kind = outputKind(job.capability);
  const facts: string[] = [];
  const a = job.params.aspect_ratio;
  if ((kind === "image" || kind === "video") && (a === "16:9" || a === "9:16" || a === "1:1")) facts.push(a);
  const d = job.params.duration_s;
  if (kind === "video" && typeof d === "number" && Number.isFinite(d) && d > 0) facts.push(formatTimecode(d, "duration"));
  if (!isUnsuccessful(job.status)) {
    const credits = job.status === "completed" ? (job.charged_credits ?? job.quoted_credits) : job.quoted_credits;
    if (typeof credits === "number" && Number.isFinite(credits)) facts.push(`${formatCredits(credits, locale)} ${t.gen.crShort}`);
  }
  return facts;
}

/** What "Try again" puts back into the panel. It spends nothing by itself. */
export interface StudioPrefill {
  capability: StudioCapability;
  model: string;
  /** 0075: start with "Auto" on (the database picks the model at the quote). Only where the panel offers Auto. */
  auto?: boolean;
  prompt: string;
  aspect: string;
  duration: number;
  /** A clip's resolution, when the job named one (the panel keeps it only if the model offers it). */
  resolution?: string | null;
  sourceId?: string | null;
  factor?: UpscaleFactor;
  /** Present only for the kinds a style can steer: the job's kit, or null for none. */
  styleKitId?: string | null;
  /** A voice change's voice (0050), when the job had a valid one. */
  voiceId?: string | null;
  /** A dub's language (0050), when the job had an offered one. */
  targetLanguage?: DubLanguage | null;
  /** An animation's end frame (0052), when the job had one. */
  endFrameId?: string | null;
  /** A video upscale's size (0052), when the job had an offered one. */
  target?: UpscaleTarget | null;
  /** An expand's shape (0099), when the job had an offered one. */
  shape?: ExpandAspect | null;
  /** A relight's light by name (0099), when the job had an offered one. */
  look?: RelightLook | null;
  /** A picture's render quality (0060), when the job named one. */
  quality?: ImageQuality | null;
  /** A clip's soundtrack (0070), when the job named one. */
  audio?: boolean | null;
  /** A description's language (0055), when the job named an offered one. */
  describeLanguage?: DescribeLanguage | null;
}

function asFactor(v: unknown): UpscaleFactor {
  return (UPSCALE_FACTORS as readonly unknown[]).includes(v) ? (v as UpscaleFactor) : 2;
}

export function prefillFromJob(job: StudioJob): StudioPrefill | null {
  if (!isStudioCapability(job.capability)) return null;
  const p = job.params;
  // Any shape and length the database could have accepted: the panel snaps them to the model's own lists.
  const aspect = isShape(p.aspect_ratio) ? p.aspect_ratio : "16:9";
  const duration = isClipSeconds(p.duration_s) ? p.duration_s : 5;
  return {
    capability: job.capability,
    model: job.requested_model,
    prompt: typeof p.prompt === "string" ? p.prompt : "",
    aspect,
    duration,
    ...((job.capability === "t2v" || job.capability === "i2v") && isNamedResolution(p.resolution) ? { resolution: p.resolution } : {}),
    ...(needsSource(job.capability)
      ? { sourceId: isUuid(p.source_asset_id) ? p.source_asset_id : null, factor: asFactor(p.factor) }
      : {}),
    ...(takesStyle(job.capability) ? { styleKitId: isUuid(p.style_kit_id) ? p.style_kit_id : null } : {}),
    ...(job.capability === "i2v" && isUuid(p.end_asset_id) ? { endFrameId: p.end_asset_id } : {}),
    ...(needsVideo(job.capability)
      ? {
          sourceId: isUuid(p.source_asset_id) ? p.source_asset_id : null,
          target: isUpscaleTarget(p.target_resolution) ? p.target_resolution : null,
        }
      : {}),
    ...(takesShape(job.capability) ? { shape: isExpandAspect(p.aspect_ratio) ? p.aspect_ratio : null } : {}),
    ...(job.capability === "relight" ? { look: isRelightLook(p.look) ? p.look : null } : {}),
    ...(takesQuality(job.capability) && isImageQuality(p.quality) ? { quality: p.quality } : {}),
    ...(takesSound(job.capability) && typeof p.audio === "boolean" ? { audio: p.audio } : {}),
    ...(job.capability === "describe" ? { describeLanguage: isDescribeLanguage(p.language) ? p.language : "en" } : {}),
    ...(job.capability === "tts" ? { voiceId: isVoiceId(p.voice_id) ? p.voice_id : null } : {}),
    ...(needsRecording(job.capability)
      ? {
          sourceId: isUuid(p.source_asset_id) ? p.source_asset_id : null,
          ...(job.capability === "voice_change" ? { voiceId: isVoiceId(p.voice_id) ? p.voice_id : null } : {}),
          ...(job.capability === "dub" ? { targetLanguage: isDubLanguage(p.target_language) ? p.target_language : null } : {}),
        }
      : {}),
  };
}

/**
 * A link into the Studio with a tool chosen: "Use in Studio" from the Library
 * (/create?tool=upscale&source=<id>) and the sidebar's tool rows
 * (/create?tool=t2v). Only the shape is checked here; whether a picture is
 * this organization's and usable is decided by the database when it is
 * priced. It fills the form and nothing else: no price, no spend.
 *
 * A picture tool may come without a picture (the sidebar) — the panel then
 * asks for one — but a source that is present must be a well-formed id. A
 * text tool starts from words, so a source on it is a malformed link.
 */
export function prefillFromQuery(tool: unknown, source: unknown): StudioPrefill | null {
  if (!isStudioCapability(tool)) return null;
  const base = { capability: tool, model: "", prompt: "", aspect: "16:9" as const, duration: 5 as const };
  if (needsSource(tool)) {
    if (source === undefined) return { ...base, sourceId: null, factor: 2 };
    return isUuid(source) ? { ...base, sourceId: source, factor: 2 } : null;
  }
  if (needsRecording(tool) || needsVideo(tool)) {
    if (source === undefined) return { ...base, sourceId: null };
    return isUuid(source) ? { ...base, sourceId: source } : null;
  }
  return source === undefined ? base : null;
}

// ── dismissed failures (a per-viewer convenience; the job itself stays) ─────

export const DISMISSED_KEY = "nightshift.studio.dismissedJobs";
const DISMISSED_MAX = 200;

type KV = Pick<Storage, "getItem" | "setItem">;

function storage(s?: KV | null): KV | null {
  if (s !== undefined) return s;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readDismissed(s?: KV | null): string[] {
  try {
    const raw = storage(s)?.getItem(DISMISSED_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-DISMISSED_MAX) : [];
  } catch {
    return [];
  }
}

/** Adds an id; returns the new list (what to render with even when storage is unavailable). */
export function addDismissed(id: string, current: string[], s?: KV | null): string[] {
  const next = [...current.filter((x) => x !== id), id].slice(-DISMISSED_MAX);
  try {
    storage(s)?.setItem(DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // Private mode or blocked storage: dismissed for this visit only.
  }
  return next;
}
