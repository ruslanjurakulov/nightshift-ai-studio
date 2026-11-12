/**
 * Character Studio ("Qahramon studiyasi", migration 0137, docs/CHARACTER_STUDIO.md): the shapes the page and the routes share.
 *
 * Pure: no React, no fetch, no environment except the switch. The browser never prices anything: every number shown comes from
 * 0137's quote_character_swap for the person's own clip, per model, and a missing number reads as "not on sale", never as 0
 * (CLAUDE.md #5). Every refusal the database can give is a closed word here; anything else is "failed".
 */

/**
 * NIGHTSHIFT_CHARACTER_STUDIO (server-side only; never a NEXT_PUBLIC value): off = the page and every route is a 404. Exactly "on" (any
 * case, trimmed), the worker's own rule (tools/character_swap_worker.py), so the two can never disagree about whether it is on.
 */
export function characterStudioEnabled(raw: string | undefined = process.env.NIGHTSHIFT_CHARACTER_STUDIO): boolean {
  return String(raw ?? "").trim().toLowerCase() === "on";
}

export const MODEL_IDS = ["kling-4.0-omni-edit", "seedance-2.5-edit"] as const;
export type ModelId = (typeof MODEL_IDS)[number];
export const RESOLUTIONS = ["720p", "1080p"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/** What the picker says about each model beside its price: the maker's own name, and the two rules a person must know first. */
export const MODEL_FACTS: Record<ModelId, { name: string; maker: string; keepsSound: boolean; ownClipsOnly: boolean; maxPictures: number }> = {
  "kling-4.0-omni-edit": { name: "Kling 4.0 Omni", maker: "Kling", keepsSound: true, ownClipsOnly: false, maxPictures: 10 },
  "seedance-2.5-edit": { name: "Seedance 2.5", maker: "BytePlus", keepsSound: false, ownClipsOnly: true, maxPictures: 30 },
};

/** The consent text the person read (0137 accepts v1 only). Raise it together with the wording and the database. */
export const CONSENT_VERSION = "v1";
export const DECLARATIONS = ["rights_to_video", "performers_consented", "no_minors", "references_owned_or_licensed", "data_to_provider"] as const;
export type Declaration = (typeof DECLARATIONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return UUID.test(v) ? v : null;
}
export const IDEM_RE = /^[A-Za-z0-9_:.-]{8,128}$/;
export const PROMPT_MAX = 2000;

export function isModel(raw: unknown): raw is ModelId {
  return typeof raw === "string" && (MODEL_IDS as readonly string[]).includes(raw);
}
export function isResolution(raw: unknown): raw is Resolution {
  return typeof raw === "string" && (RESOLUTIONS as readonly string[]).includes(raw);
}

/** The words name at least one picture (@Image 1): the database refuses them otherwise (prompt_needs_character). A hint only. */
export function namesACharacter(prompt: string): boolean {
  return /@image\s*[0-9]/i.test(prompt);
}

/** The pictures the words name, by number (1-based): the page warns about a picture nobody names. */
export function namedPictures(prompt: string): number[] {
  return [...new Set([...prompt.matchAll(/@image\s*([0-9]{1,2})\b/gi)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

export interface ModelQuote {
  model: ModelId;
  onSale: boolean;
  /** The charge for this clip, or null when the model is not on sale. */
  credits: number | null;
  /** What is held while it runs (the charge raised to the platform's job minimum), or null. */
  hold: number | null;
  /** Why this video cannot go to this model (the database's word), or null. */
  problem: string | null;
}
export interface SwapQuote {
  seconds: number;
  billedSeconds: number;
  resolution: Resolution;
  exempt: boolean;
  models: ModelQuote[];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function word(v: unknown): string | null {
  return typeof v === "string" && /^[a-z0-9_]{1,64}$/.test(v) ? v : null;
}

/** 0137's quote, or null when it is not one. A model on sale with no number is not on sale: no price is invented. */
export function coerceQuote(data: unknown): SwapQuote | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const seconds = num(d.seconds);
  const billed = num(d.billed_seconds);
  if (seconds === null || billed === null || !isResolution(d.resolution) || !Array.isArray(d.models)) return null;
  const models: ModelQuote[] = [];
  for (const raw of d.models) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    if (!isModel(m.model)) continue;
    const credits = num(m.credits);
    const hold = num(m.hold);
    const onSale = m.on_sale === true && credits !== null && hold !== null;
    models.push({ model: m.model, onSale, credits: onSale ? credits : null, hold: onSale ? hold : null, problem: word(m.problem) });
  }
  return { seconds, billedSeconds: billed, resolution: d.resolution, exempt: d.exempt === true, models };
}

export type SwapError =
  | "not_found"
  | "unauthorized"
  | "forbidden"
  | "not_configured"
  | "not_available"
  | "bad_request"
  | "org_required"
  | "read_failed"
  | "failed"
  | "invalid_resolution"
  | "invalid_idempotency_key"
  | "idempotency_conflict"
  | "prompt_length"
  | "prompt_characters"
  | "prompt_needs_character"
  | "prompt_real_person"
  | "model_unknown"
  | "input_unavailable"
  | "input_too_short"
  | "input_too_long"
  | "needs_own_generated_clip"
  | "references_count"
  | "references_unavailable"
  | "project_unavailable"
  | "declarations_shape"
  | "declarations_unknown"
  | "declarations_incomplete"
  | "consent_version_stale"
  | "consent_required"
  | "consent_limit"
  | "not_on_sale"
  | "price_changed"
  | "org_daily_limit"
  | "job_in_progress"
  | "platform_busy"
  | "swap_hold_unavailable"
  | "parallel_limit"
  | "not_cancellable";

/** Database refusals the page explains in words; the status each answers with. */
const REFUSALS: Partial<Record<SwapError, number>> = {
  invalid_resolution: 400,
  invalid_idempotency_key: 400,
  idempotency_conflict: 409,
  prompt_length: 400,
  prompt_characters: 400,
  prompt_needs_character: 400,
  prompt_real_person: 400,
  model_unknown: 400,
  input_unavailable: 400,
  input_too_short: 400,
  input_too_long: 400,
  needs_own_generated_clip: 400,
  references_count: 400,
  references_unavailable: 400,
  project_unavailable: 400,
  declarations_shape: 400,
  declarations_unknown: 400,
  declarations_incomplete: 400,
  consent_version_stale: 409,
  consent_required: 409,
  consent_limit: 429,
  not_on_sale: 409,
  price_changed: 409,
  org_daily_limit: 429,
  job_in_progress: 409,
  platform_busy: 429,
  swap_hold_unavailable: 402,
  not_cancellable: 409,
};

export interface MappedError {
  error: SwapError;
  status: number;
  /** price_changed: the charge the database computed now (detail charge=...). */
  charge?: number;
  /** swap_hold_unavailable: what it tried to hold (detail hold=... charge=...). */
  hold?: number;
}

/** A Supabase / PostgREST error from one of 0137's functions, as a closed word. Nothing of the database's own text passes through. */
export function mapSwapError(error: { code?: string; message?: string; details?: string } | null | undefined): MappedError {
  const code = error?.code ?? "";
  const message = (error?.message ?? "").trim();
  const details = error?.details ?? "";
  if (code === "42P01" || code === "42883" || code === "PGRST202") return { error: "not_available", status: 503 };
  if (code === "42501" || message === "forbidden") return { error: "forbidden", status: 403 };
  if (code === "P0002" || message === "not_found") return { error: "not_found", status: 404 };
  if (code === "NS429" && message !== "org_daily_limit" && message !== "platform_busy" && message !== "consent_limit") {
    return { error: "parallel_limit", status: 429 };
  }
  const known = REFUSALS[message as SwapError];
  if (known !== undefined) {
    const out: MappedError = { error: message as SwapError, status: known };
    const charge = /charge=([0-9]+(?:\.[0-9]{1,2})?)/.exec(details);
    const hold = /hold=([0-9]+(?:\.[0-9]{1,2})?)/.exec(details);
    if (charge) out.charge = Number(charge[1]);
    if (hold && message === "swap_hold_unavailable") out.hold = Number(hold[1]);
    return out;
  }
  return { error: "failed", status: 502 };
}

export type JobStatus = "requested" | "running" | "ready" | "failed" | "cancelled";
const STATUSES: JobStatus[] = ["requested", "running", "ready", "failed", "cancelled"];

export interface SwapJob {
  id: string;
  model: ModelId;
  resolution: Resolution;
  status: JobStatus;
  errorCode: string | null;
  credits: number | null;
  charged: number | null;
  outputAssetId: string | null;
  createdAt: string | null;
}

export const JOB_COLUMNS = "id, model_id, resolution, status, error_code, charge_credits, charged_credits, output_asset_id, created_at";

export function coerceJobs(data: unknown): SwapJob[] {
  if (!Array.isArray(data)) return [];
  const out: SwapJob[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = parseId(r.id);
    if (!id || !isModel(r.model_id) || !isResolution(r.resolution) || !STATUSES.includes(r.status as JobStatus)) continue;
    out.push({
      id,
      model: r.model_id,
      resolution: r.resolution,
      status: r.status as JobStatus,
      errorCode: word(r.error_code),
      credits: num(typeof r.charge_credits === "string" ? Number(r.charge_credits) : r.charge_credits),
      charged: num(typeof r.charged_credits === "string" ? Number(r.charged_credits) : r.charged_credits),
      outputAssetId: parseId(r.output_asset_id),
      createdAt: typeof r.created_at === "string" ? r.created_at : null,
    });
  }
  return out;
}

export interface TemplateSample {
  model: ModelId;
  webUrl: string;
  posterUrl: string | null;
}
export interface SwapTemplate {
  id: string;
  slug: string;
  title: { en: string; ru: string; uz: string };
  prompt: string;
  characters: number;
  /** One slot per model, in the picker's order; null = no sample yet ("Namuna tez orada"). */
  samples: Record<ModelId, TemplateSample | null>;
}

export const TEMPLATE_COLUMNS = "id, slug, position, title_en, title_ru, title_uz, prompt, characters";
export const SAMPLE_COLUMNS = "template_id, model_id, web_url, poster_url";

/** A sample's link is shown only when it is a plain https URL (0137 checks the same shape); anything else is an empty slot. */
const SAMPLE_URL = /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._~/-]+$/;

export function coerceTemplates(templates: unknown, samples: unknown): SwapTemplate[] {
  if (!Array.isArray(templates)) return [];
  const byTemplate = new Map<string, Record<ModelId, TemplateSample | null>>();
  for (const raw of Array.isArray(samples) ? samples : []) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const tid = parseId(s.template_id);
    if (!tid || !isModel(s.model_id) || typeof s.web_url !== "string" || !SAMPLE_URL.test(s.web_url) || s.web_url.length > 500) continue;
    const slots = byTemplate.get(tid) ?? { "kling-4.0-omni-edit": null, "seedance-2.5-edit": null };
    const poster = typeof s.poster_url === "string" && SAMPLE_URL.test(s.poster_url) ? s.poster_url : null;
    slots[s.model_id] = { model: s.model_id, webUrl: s.web_url, posterUrl: poster };
    byTemplate.set(tid, slots);
  }
  const out: SwapTemplate[] = [];
  const rows = [...templates].sort((a, b) => Number((a as { position?: unknown }).position) - Number((b as { position?: unknown }).position));
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = parseId(r.id);
    const title = [r.title_en, r.title_ru, r.title_uz];
    if (!id || typeof r.slug !== "string" || typeof r.prompt !== "string" || title.some((x) => typeof x !== "string")) continue;
    out.push({
      id,
      slug: r.slug,
      title: { en: r.title_en as string, ru: r.title_ru as string, uz: r.title_uz as string },
      prompt: r.prompt.slice(0, PROMPT_MAX),
      characters: typeof r.characters === "number" && r.characters >= 1 && r.characters <= 10 ? r.characters : 1,
      samples: byTemplate.get(id) ?? { "kling-4.0-omni-edit": null, "seedance-2.5-edit": null },
    });
  }
  return out;
}

/** The library items the studio can pick: a video (mp4 / mov) to change, pictures (png / jpeg / webp) of the characters. */
export interface PickItem {
  id: string;
  kind: "video" | "image";
  name: string | null;
  thumbUrl: string | null;
  durationS: number | null;
  source: string;
}

export interface StudioState {
  available: boolean;
  error?: "read_failed";
  templates: SwapTemplate[];
  jobs: SwapJob[];
  videos: PickItem[];
  pictures: PickItem[];
}
