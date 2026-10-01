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
  DUB_LANGUAGES,
  type DubLanguage,
  MEDIA_SOURCE_CAPABILITIES,
  PARAM_KEYS,
  SOURCE_CAPABILITIES,
  STYLE_CAPABILITIES,
  UPSCALE_FACTORS,
  UPSCALE_TARGETS,
  type UpscaleTarget,
  VIDEO_SOURCE_CAPABILITIES,
  VOICE_ID_RE,
  isUuid,
} from "@/lib/creative/operations";
import { VOICES } from "@/lib/ttsModels";
import { formatCredits } from "@/lib/credits";
import { fmt, type Dictionary } from "@/lib/i18n";

/**
 * The tools the customer sidebar lists as direct links (lib/navigation's
 * STUDIO_TOOLS mirrors this list; tests/navigation-shell holds them in step).
 */
export const STUDIO_CAPABILITIES = ["t2i", "t2v", "tts", "edit", "i2v", "upscale", "remove_bg"] as const satisfies readonly CreativeCapability[];

/**
 * The voice tools (migration 0050): change the voice of a recording, or dub
 * it into another language. They start from an audio or video file in the
 * library and are offered in the composer's tool rows.
 */
export const VOICE_TOOLS = ["voice_change", "dub"] as const satisfies readonly CreativeCapability[];

/**
 * The video tools (migration 0052): upscale a library video. Like the voice
 * tools they live in the composer's tool rows, not the sidebar.
 */
export const VIDEO_TOOLS = ["video_upscale"] as const satisfies readonly CreativeCapability[];

/** Everything the composer can make, in the order it shows the tools (the rest wait for their own UI). */
export const COMPOSER_CAPABILITIES = [...STUDIO_CAPABILITIES, ...VOICE_TOOLS, ...VIDEO_TOOLS] as const;
export type StudioCapability = (typeof COMPOSER_CAPABILITIES)[number];

/** The tools that start from a picture in the library (migration 0046). */
export type SourceCapability = (typeof SOURCE_CAPABILITIES)[number];
export type UpscaleFactor = (typeof UPSCALE_FACTORS)[number];

export function needsSource(c: string): c is SourceCapability {
  return (SOURCE_CAPABILITIES as readonly string[]).includes(c);
}

/** The tools that start from a recording (audio or video) in the library (migration 0050). */
export type RecordingCapability = (typeof MEDIA_SOURCE_CAPABILITIES)[number];

export function needsRecording(c: string): c is RecordingCapability {
  return (MEDIA_SOURCE_CAPABILITIES as readonly string[]).includes(c);
}

/** The tools that start from a video in the library (migration 0052). */
export type VideoCapability = (typeof VIDEO_SOURCE_CAPABILITIES)[number];

export function needsVideo(c: string): c is VideoCapability {
  return (VIDEO_SOURCE_CAPABILITIES as readonly string[]).includes(c);
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

export function isVoiceId(v: unknown): v is string {
  return typeof v === "string" && VOICE_ID_RE.test(v);
}

/** 0048: the kinds a style kit can steer (the picture tools that keep their input cannot). */
export function takesStyle(c: string): boolean {
  return (STYLE_CAPABILITIES as readonly string[]).includes(c);
}

/** 0046 / 0050 / 0052: the prompt is required for these, optional for i2v / upscale, refused for remove_bg and the voice and video tools. */
export function promptRule(c: StudioCapability): "required" | "optional" | "none" {
  if (c === "remove_bg" || needsRecording(c) || needsVideo(c)) return "none";
  if (c === "i2v" || c === "upscale") return "optional";
  return "required";
}

export const ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export const VIDEO_DURATIONS = [5, 10] as const;
export type VideoDuration = (typeof VIDEO_DURATIONS)[number];

export const PROMPT_MAX = 4000;

export function isStudioCapability(v: unknown): v is StudioCapability {
  return typeof v === "string" && (COMPOSER_CAPABILITIES as readonly string[]).includes(v);
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
}

const tier = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5 ? v : null);

/**
 * Adds the registry's speed and quality marks (sellable_models() rows) to the
 * models the Studio already offers — and, from the same public spec, what a
 * model's video tools take (0052: an end frame, upscale sizes, the longest
 * source). It never adds a model: what may be picked is still coerceModels'
 * answer; a row without a mark leaves it unmarked, and a model the sellable
 * rows do not describe offers no end frame and no size (the database would
 * refuse them anyway).
 */
export function withTiers(models: StudioModel[], sellable: unknown): StudioModel[] {
  if (!Array.isArray(sellable)) return models;
  type Marks = Pick<StudioModel, "qualityTier" | "speedTier" | "endFrame" | "upscaleTargets" | "maxSourceSeconds">;
  const marks = new Map<string, Marks>();
  for (const r of sellable) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const spec = row.spec && typeof row.spec === "object" && !Array.isArray(row.spec) ? (row.spec as Record<string, unknown>) : {};
    const limits = spec.limits && typeof spec.limits === "object" && !Array.isArray(spec.limits) ? (spec.limits as Record<string, unknown>) : {};
    const longest = limits.max_source_seconds;
    if (typeof row.id !== "string") continue;
    const targets = Array.isArray(spec.upscale_targets) ? spec.upscale_targets.filter(isUpscaleTarget) : [];
    // Only what the spec states: a model that says nothing about the video
    // tools carries nothing for them (absent reads as "no").
    marks.set(row.id, {
      qualityTier: tier(spec.quality_tier),
      speedTier: tier(spec.speed_tier),
      ...(spec.end_frame === true ? { endFrame: true } : {}),
      ...(targets.length ? { upscaleTargets: targets } : {}),
      ...(typeof longest === "number" && Number.isInteger(longest) && longest > 0 ? { maxSourceSeconds: longest } : {}),
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
    });
  }
  return out;
}

export function modelsFor(models: StudioModel[], capability: string): StudioModel[] {
  return models.filter((m) => m.capabilities.includes(capability));
}

// ── the request ────────────────────────────────────────────────────────────

export interface StudioForm {
  capability: StudioCapability;
  prompt: string;
  aspect: AspectRatio;
  duration: VideoDuration;
  /** The library picture edit / i2v / upscale / remove_bg start from. */
  sourceId?: string | null;
  factor?: UpscaleFactor;
  /** A style kit of the organization (0048); null / absent = no style. */
  styleKitId?: string | null;
  /** The voice a voice change speaks in (0050): one of the account's voices, picked — never defaulted. */
  voiceId?: string | null;
  /** The language a dub is made in (0050). */
  targetLanguage?: DubLanguage | null;
  /** The picture an animation ends on (0052); only sent for a model that takes one. */
  endFrameId?: string | null;
  /** The size a video upscale makes (0052). */
  target?: UpscaleTarget | null;
}

type ParamKey = (typeof PARAM_KEYS)[number];

/**
 * Only what 0036 / 0046 / 0048's creative_params_problem accepts for the
 * capability. The source tools keep the picture's own shape, so they never
 * send an aspect ratio; an empty optional prompt is left out rather than sent
 * blank; "no style" is the key left out, never sent empty. @names stay in the
 * prompt as typed — the worker resolves them.
 */
export function buildParams(form: StudioForm): Partial<Record<ParamKey, string | number>> {
  const base = baseParams(form);
  return takesStyle(form.capability) && isUuid(form.styleKitId) ? { ...base, style_kit_id: form.styleKitId } : base;
}

function baseParams(form: StudioForm): Partial<Record<ParamKey, string | number>> {
  const prompt = form.prompt.trim();
  const source = form.sourceId ?? "";
  switch (form.capability) {
    case "t2i":
      return { prompt, aspect_ratio: form.aspect };
    case "t2v":
      return { prompt, aspect_ratio: form.aspect, duration_s: form.duration };
    case "edit":
      return { prompt, source_asset_id: source };
    case "i2v":
      // "No end frame" is the key left out, never sent empty.
      return {
        ...(prompt ? { prompt } : {}),
        source_asset_id: source,
        duration_s: form.duration,
        ...(isUuid(form.endFrameId) ? { end_asset_id: form.endFrameId } : {}),
      };
    case "upscale":
      return { ...(prompt ? { prompt } : {}), source_asset_id: source, factor: form.factor ?? 2 };
    case "remove_bg":
      return { source_asset_id: source };
    case "voice_change":
      // The length (and so the price) is the recording's own: never sent.
      return { source_asset_id: source, voice_id: form.voiceId ?? "" };
    case "dub":
      return { source_asset_id: source, target_language: form.targetLanguage ?? "" };
    case "video_upscale":
      // The length (and so the price) is the video's own: never sent.
      return { source_asset_id: source, target_resolution: form.target ?? "" };
    default:
      // Speech: the words are the prompt; the price counts their characters.
      return { prompt };
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
  | "need_voice"
  | "need_language"
  | "need_words";

export function blockedReason(form: StudioForm, hasModel: boolean): BlockedReason | null {
  if (!hasModel) return "no_model";
  if (needsSource(form.capability) && !isUuid(form.sourceId)) return "need_picture";
  if (needsRecording(form.capability) && !isUuid(form.sourceId)) return "need_recording";
  if (needsVideo(form.capability) && !isUuid(form.sourceId)) return "need_video";
  if (form.capability === "video_upscale" && !isUpscaleTarget(form.target)) return "need_target";
  if (form.capability === "voice_change" && !isVoiceId(form.voiceId)) return "need_voice";
  if (form.capability === "dub" && !isDubLanguage(form.targetLanguage)) return "need_language";
  if (promptRule(form.capability) === "required" && !form.prompt.trim()) return "need_words";
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
  if ((needsSource(form.capability) || needsRecording(form.capability) || needsVideo(form.capability)) && !isUuid(form.sourceId))
    return null;
  // A video upscale is priced per size: no stand-in size is ever asked about.
  if (form.capability === "video_upscale" && !isUpscaleTarget(form.target)) return null;
  if (!WORDS_FREE_PRICE.includes(form.capability)) return null;
  return buildParams({
    ...form,
    prompt: PRICE_STAND_IN,
    voiceId: isVoiceId(form.voiceId) ? form.voiceId : (STUDIO_VOICES[0]?.id ?? null),
    targetLanguage: isDubLanguage(form.targetLanguage) ? form.targetLanguage : DUB_LANGUAGES[0],
  });
}

/** The most models the sheet prices at once: each is one quote call. */
export const SHEET_PRICE_MAX = 8;

// ── the button and the errors ──────────────────────────────────────────────

export type QuoteState =
  | { status: "idle" }
  | { status: "quoting" }
  | { status: "ready"; credits: number }
  | { status: "error"; code: CreativeError };

/** Price on the button: "Generate · N credits" once the database has priced it. */
export function generateLabel(t: Dictionary, quote: QuoteState, locale = "en"): string {
  if (quote.status === "quoting") return t.gen.quoting;
  if (quote.status === "ready") return fmt(t.gen.generatePriced, { n: formatCredits(quote.credits, locale) });
  return t.gen.generate;
}

export function asCreativeError(code: unknown): CreativeError {
  return typeof code === "string" && (CREATIVE_ERRORS as readonly string[]).includes(code)
    ? (code as CreativeError)
    : "failed";
}

/** A route's error code -> the sentence the person reads (never the code itself). */
export function apiErrorMessage(t: Dictionary, code: unknown): string {
  return t.creative.errors[asCreativeError(code)];
}

/** What the panel offers next to the message. */
export function errorAction(code: unknown): "credits" | "requote" | null {
  const c = asCreativeError(code);
  if (c === "insufficient_credits") return "credits";
  if (c === "price_changed") return "requote";
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
  params: Record<string, unknown>;
  quoted_credits: number;
  charged_credits: number | null;
  error_code: string | null;
  result: Record<string, unknown> | null;
  result_asset_ids: string[];
  created_at: string;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function coerceJobs(rows: unknown): StudioJob[] {
  if (!Array.isArray(rows)) return [];
  const out: StudioJob[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const j = r as Record<string, unknown>;
    if (typeof j.id !== "string" || typeof j.status !== "string") continue;
    const params = j.params && typeof j.params === "object" && !Array.isArray(j.params) ? (j.params as Record<string, unknown>) : {};
    const result = j.result && typeof j.result === "object" && !Array.isArray(j.result) ? (j.result as Record<string, unknown>) : null;
    out.push({
      id: j.id,
      capability: typeof j.capability === "string" ? j.capability : "",
      status: j.status,
      requested_model: typeof j.requested_model === "string" ? j.requested_model : "",
      params,
      quoted_credits: num(j.quoted_credits) ?? 0,
      charged_credits: num(j.charged_credits),
      error_code: typeof j.error_code === "string" ? j.error_code : null,
      result,
      result_asset_ids: Array.isArray(j.result_asset_ids) ? j.result_asset_ids.filter((x): x is string => typeof x === "string") : [],
      created_at: typeof j.created_at === "string" ? j.created_at : "",
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
};

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
export const COMPARE_CAPABILITIES = ["edit", "upscale", "remove_bg"] as const;

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
const PICTURE_RESULTS = ["t2i", "edit", "upscale", "remove_bg"] as const;

/** "Use as picture": the finished job's first result, when it is a library picture; else null. */
export function sourceFromJob(job: Pick<StudioJob, "status" | "capability" | "result_asset_ids">): string | null {
  if (job.status !== "completed") return null;
  if (!(PICTURE_RESULTS as readonly string[]).includes(job.capability)) return null;
  const id = job.result_asset_ids[0];
  return isUuid(id) ? id : null;
}

/** What a finished job made, for its card: a picture, a clip or a voice. */
export function outputKind(capability: string): "image" | "video" | "audio" {
  if (capability === "t2v" || capability === "i2v" || needsVideo(capability)) return "video";
  if (capability === "tts" || capability === "sfx" || capability === "music" || needsRecording(capability)) return "audio";
  return "image";
}

/** The card's shape: the shape that was asked for, else square (a picture tool keeps its own). */
export function cardAspect(job: Pick<StudioJob, "capability" | "params">): string {
  if (outputKind(job.capability) === "audio") return "16 / 7";
  const a = job.params.aspect_ratio;
  if (a === "16:9") return "16 / 9";
  if (a === "9:16") return "9 / 16";
  return "1 / 1";
}

/** What "Try again" puts back into the panel. It spends nothing by itself. */
export interface StudioPrefill {
  capability: StudioCapability;
  model: string;
  prompt: string;
  aspect: AspectRatio;
  duration: VideoDuration;
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
}

function asFactor(v: unknown): UpscaleFactor {
  return (UPSCALE_FACTORS as readonly unknown[]).includes(v) ? (v as UpscaleFactor) : 2;
}

export function prefillFromJob(job: StudioJob): StudioPrefill | null {
  if (!isStudioCapability(job.capability)) return null;
  const p = job.params;
  const aspect = (ASPECT_RATIOS as readonly string[]).includes(p.aspect_ratio as string) ? (p.aspect_ratio as AspectRatio) : "16:9";
  const duration = (VIDEO_DURATIONS as readonly number[]).includes(p.duration_s as number) ? (p.duration_s as VideoDuration) : 5;
  return {
    capability: job.capability,
    model: job.requested_model,
    prompt: typeof p.prompt === "string" ? p.prompt : "",
    aspect,
    duration,
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
