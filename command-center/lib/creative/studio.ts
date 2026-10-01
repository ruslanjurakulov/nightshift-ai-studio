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
  PARAM_KEYS,
  SOURCE_CAPABILITIES,
  UPSCALE_FACTORS,
  isUuid,
} from "@/lib/creative/operations";
import { formatCredits } from "@/lib/credits";
import { fmt, type Dictionary } from "@/lib/i18n";

/** What the panel can make today (the rest wait for their own UI). */
export const STUDIO_CAPABILITIES = ["t2i", "t2v", "tts", "edit", "i2v", "upscale", "remove_bg"] as const satisfies readonly CreativeCapability[];
export type StudioCapability = (typeof STUDIO_CAPABILITIES)[number];

/** The tools that start from a picture in the library (migration 0046). */
export type SourceCapability = (typeof SOURCE_CAPABILITIES)[number];
export type UpscaleFactor = (typeof UPSCALE_FACTORS)[number];

export function needsSource(c: string): c is SourceCapability {
  return (SOURCE_CAPABILITIES as readonly string[]).includes(c);
}

/** 0046: the prompt is required for these, optional for i2v / upscale, refused for remove_bg. */
export function promptRule(c: StudioCapability): "required" | "optional" | "none" {
  if (c === "remove_bg") return "none";
  if (c === "i2v" || c === "upscale") return "optional";
  return "required";
}

export const ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export const VIDEO_DURATIONS = [5, 10] as const;
export type VideoDuration = (typeof VIDEO_DURATIONS)[number];

export const PROMPT_MAX = 4000;

export function isStudioCapability(v: unknown): v is StudioCapability {
  return typeof v === "string" && (STUDIO_CAPABILITIES as readonly string[]).includes(v);
}

// ── models (0035: members read sellable rows' public columns) ──────────────

export interface StudioModel {
  id: string;
  displayName: string;
  capabilities: string[];
  beta: boolean;
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
}

type ParamKey = (typeof PARAM_KEYS)[number];

/**
 * Only what 0036 / 0046's creative_params_problem accepts for the capability.
 * The source tools keep the picture's own shape, so they never send an aspect
 * ratio; an empty optional prompt is left out rather than sent blank.
 */
export function buildParams(form: StudioForm): Partial<Record<ParamKey, string | number>> {
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
      return { ...(prompt ? { prompt } : {}), source_asset_id: source, duration_s: form.duration };
    case "upscale":
      return { ...(prompt ? { prompt } : {}), source_asset_id: source, factor: form.factor ?? 2 };
    case "remove_bg":
      return { source_asset_id: source };
    default:
      // Speech: the words are the prompt; the price counts their characters.
      return { prompt };
  }
}

/** Enough to ask for a price: the picture when the tool needs one, the words when they are required. */
export function canQuote(form: StudioForm): boolean {
  if (needsSource(form.capability) && !isUuid(form.sourceId)) return false;
  if (promptRule(form.capability) === "required" && !form.prompt.trim()) return false;
  return true;
}

/** One key per click: a replayed click answers the first job instead of paying twice. */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const id = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `studio:${id}`;
}

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

/** What "Try again" puts back into the panel. It spends nothing by itself. */
export interface StudioPrefill {
  capability: StudioCapability;
  model: string;
  prompt: string;
  aspect: AspectRatio;
  duration: VideoDuration;
  sourceId?: string | null;
  factor?: UpscaleFactor;
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
  };
}

/**
 * "Use in Studio" from the Library: /create?tool=upscale&source=<id>. Only
 * the shape is checked here; whether the picture is this organization's and
 * usable is decided by the database when it is priced. Spends nothing.
 */
export function prefillFromQuery(tool: unknown, source: unknown): StudioPrefill | null {
  if (typeof tool !== "string" || !needsSource(tool) || !isUuid(source)) return null;
  return { capability: tool, model: "", prompt: "", aspect: "16:9", duration: 5, sourceId: source, factor: 2 };
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
