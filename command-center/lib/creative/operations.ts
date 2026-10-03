/**
 * Creative generations (migration 0036), independent of transport: the web
 * routes under /api/creative call these today; the REST and MCP doors of the
 * plan (§3.9) will call the same functions with their own `db`.
 *
 * Input is shape-checked here so a malformed request never reaches the
 * database; everything that decides — membership, the model being sellable,
 * the price (from the registry and credit_prices, never from this code), the
 * credit hold, idempotency — is decided by 0036's security-definer functions,
 * called through `db.rpc` under the signed-in user's session with the ANON
 * key. Nothing here holds a service key or talks to a provider.
 *
 * Pure apart from the injected `db`, so it is unit-tested with a fake one.
 */

import { extraOffFields } from "@/lib/credits";

export type DbError = { code?: string; message?: string; details?: string | null; hint?: string | null };
export type DbAnswer = { data: unknown; error: DbError | null };

export interface CreativeDb {
  rpc(fn: string, args: Record<string, unknown>): Promise<DbAnswer>;
  /** One creative_jobs row by id, read through RLS (members of its org). */
  readJob(id: string): Promise<DbAnswer>;
  /** The newest creative_jobs rows of one org, read through RLS; only these tools' when `capabilities` is given. */
  listJobs(orgId: string, limit: number, capabilities?: readonly CreativeCapability[]): Promise<DbAnswer>;
}

export interface CreativeResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Capabilities 0036 / 0046 / 0050 / 0055 accept. edit…remove_bg start from a
 * picture in the organization's media library (`params.source_asset_id`,
 * migration 0046); voice_change and dub start from a recording there (0050);
 * describe reads a picture there and answers with text (0055); captions
 * transcribe a recording there into a word-timed caption track (0072).
 */
export const CREATIVE_CAPABILITIES = [
  "t2i",
  "t2v",
  "tts",
  "sfx",
  "music",
  "edit",
  "i2v",
  "upscale",
  "remove_bg",
  "voice_change",
  "dub",
  "video_upscale",
  "describe",
  "captions",
] as const;
export type CreativeCapability = (typeof CREATIVE_CAPABILITIES)[number];

/**
 * The capabilities whose input is a library image. Whether that image may be
 * used — it exists, belongs to the SAME organization, is live, is an image a
 * provider takes — is decided by the database (0046's
 * creative_source_problem), never here: this only checks the id's shape.
 */
export const SOURCE_CAPABILITIES = ["edit", "i2v", "upscale", "remove_bg", "describe"] as const satisfies readonly CreativeCapability[];

/**
 * 0055's explicit allow-list for a description's `language` (optional; absent
 * = English). Only describe takes it.
 */
export const DESCRIBE_LANGUAGES = ["en", "ru", "uz"] as const;
export type DescribeLanguage = (typeof DESCRIBE_LANGUAGES)[number];

/**
 * The capabilities whose input is a library RECORDING — an audio or video
 * file (migration 0050). Whether it may be used — the SAME organization's,
 * live, a type the voice provider takes, of a measured length within the
 * tool's limit — is decided by the database (creative_source_problem); so is
 * the quantity (the recording's seconds), never this code or the browser.
 */
export const MEDIA_SOURCE_CAPABILITIES = ["voice_change", "dub"] as const satisfies readonly CreativeCapability[];

/**
 * Captions (0072) also start from a library recording, checked exactly like a
 * voice tool's (and at most 30 minutes) — but they are an editor tool, not a
 * Studio tab, so they are not in MEDIA_SOURCE_CAPABILITIES (which the Studio's
 * panel types are built from).
 */
export const RECORDING_CAPABILITIES: readonly string[] = [...MEDIA_SOURCE_CAPABILITIES, "captions"];

/**
 * 0072's explicit allow-list for the spoken `language` of a captions job
 * (optional; absent = the provider detects it). The model must list it too.
 */
export const CAPTION_LANGUAGES = ["uz", "ru", "en"] as const;
export type CaptionLanguage = (typeof CAPTION_LANGUAGES)[number];

/**
 * The capabilities whose input is a library VIDEO (migration 0052). Whether it
 * may be used — the SAME organization's, live, a type the provider takes, of
 * a measured length within the model's limit — is decided by the database;
 * so is the quantity (the video's seconds), never this code or the browser.
 */
export const VIDEO_SOURCE_CAPABILITIES = ["video_upscale"] as const satisfies readonly CreativeCapability[];

/**
 * 0052's explicit allow-list for a video upscale's `target_resolution` (the
 * model must list it too, spec.upscale_targets). The provider takes a target
 * size, not a factor.
 */
export const UPSCALE_TARGETS = ["720p", "1k", "2k", "4k"] as const;
export type UpscaleTarget = (typeof UPSCALE_TARGETS)[number];

/** 0050's explicit allow-list for a dub's `target_language` (the model must list it too). */
export const DUB_LANGUAGES = ["uz", "ru", "en"] as const;
export type DubLanguage = (typeof DUB_LANGUAGES)[number];

/** A voice of the account: 20 letters and digits (0050 requires exactly this for voice_change). */
export const VOICE_ID_RE = /^[A-Za-z0-9]{20}$/;

/**
 * The capabilities a style kit can steer (migration 0048: `params.style_kit_id`).
 * Whether the kit may be used — it exists and is the SAME organization's — is
 * decided by the database (creative_style_problem), never here.
 */
export const STYLE_CAPABILITIES = ["t2i", "t2v", "edit", "i2v"] as const satisfies readonly CreativeCapability[];

/**
 * 0060's explicit allow-list for a picture's `quality` (t2i and edit only,
 * optional). Absent means medium — in the quote AND in the worker, so the
 * tier priced is the tier sent. Whether a model offers a tier, and what it
 * costs, is decided by the database (spec.qualities, one credit_prices row
 * per tier); a tier without a price is refused as `unpriced`, never free.
 */
export const IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
export const DEFAULT_IMAGE_QUALITY: ImageQuality = "medium";
export const QUALITY_CAPABILITIES = ["t2i", "edit"] as const satisfies readonly CreativeCapability[];

export function isImageQuality(v: unknown): v is ImageQuality {
  return typeof v === "string" && (IMAGE_QUALITIES as readonly string[]).includes(v);
}

/**
 * 0070's `audio` (t2v and i2v only, a JSON boolean, optional): the soundtrack
 * of a clip on a model that prices it apart. Absent means silent — in the quote
 * AND in the worker. Whether a model offers the choice, and what each setting
 * costs, is decided by the database (spec.pricing.variants, one credit_prices
 * row per setting); a setting without a price is refused as `unpriced`, never
 * free. The `resolution` already accepted is likewise checked against the
 * model there (an unlisted one is refused before any hold).
 */
export const AUDIO_CAPABILITIES = ["t2v", "i2v"] as const satisfies readonly CreativeCapability[];

/** Upscale factors 0046 accepts; the model must also list the factor (spec.upscale_factors). */
export const UPSCALE_FACTORS = [2, 4] as const;

/** Keys 0036 / 0046 / 0048 / 0050 / 0052 / 0055 / 0060 / 0070's creative_params_problem accepts; anything else is refused there too. */
export const PARAM_KEYS = [
  "prompt",
  "negative_prompt",
  "aspect_ratio",
  "resolution",
  "duration_s",
  "voice_id",
  "seed",
  "source_asset_id",
  "factor",
  "style_kit_id",
  "target_language",
  "target_resolution",
  "end_asset_id",
  "language",
  "quality",
  "audio",
] as const;

/** Codes the routes answer with. Each has a sentence in lib/i18n `creative.errors`. */
export const CREATIVE_ERRORS = [
  "unauthorized",
  "not_configured",
  "creative_unavailable",
  "registry_missing",
  "org_required",
  "invalid_body",
  "invalid_params",
  "invalid_idempotency_key",
  "confirm_price",
  "price_changed",
  "idempotency_conflict",
  "model_not_sellable",
  "entitlement_required",
  "unpriced",
  "capability_not_supported",
  "source_unavailable",
  "style_unavailable",
  "mode_not_supported",
  // 0075: the automatic choice changed since the quote; nothing fits these settings.
  "route_changed",
  "no_model_available",
  "insufficient_credits",
  "run_limit_reached",
  "forbidden",
  "not_found",
  "not_cancellable",
  "failed",
] as const;
export type CreativeError = (typeof CREATIVE_ERRORS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** exact = the model the person picked; the others let the database pick (0075). */
export const CREATIVE_MODES = ["exact", "auto", "cheap", "fast", "quality"] as const;
export type CreativeMode = (typeof CREATIVE_MODES)[number];
/** Why the router picked a model: a code the app words in en / ru / uz. */
export const ROUTE_REASONS = ["cheapest", "fastest", "best_quality", "best_value", "best_available", "only_option"] as const;
export type RouteReason = (typeof ROUTE_REASONS)[number];
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_:.-]{1,255}$/;
const MAX_PARAMS_BYTES = 16_384;

/** What a member sees of a job. Never the worker's id or the provider's task id. */
export const JOB_COLUMNS =
  "id,org_id,kind,capability,mode,requested_model,routed_model,fallback_from,fallback_reason,params,status,payer,quoted_credits,charged_credits,error_code,error,result,result_asset_ids,expires_at,created_at,updated_at,finished_at";

function fail(status: number, error: CreativeError, extra: Record<string, unknown> = {}): CreativeResult {
  return { status, body: { error, ...extra } };
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** 0036 not applied (or the function renamed): "not enabled here", never a crash or a zero. */
export function isCreativeMissing(error: DbError | null | undefined): boolean {
  if (!error) return false;
  return (
    error.code === "PGRST202" ||
    error.code === "PGRST205" ||
    error.code === "42883" ||
    error.code === "42P01" ||
    /could not find the (function|table)|does not exist/i.test(error.message ?? "")
  );
}

const NS400: Partial<Record<string, { status: number; code: CreativeError }>> = {
  registry_missing: { status: 503, code: "registry_missing" },
  model_not_sellable: { status: 422, code: "model_not_sellable" },
  entitlement_required: { status: 403, code: "entitlement_required" },
  unpriced: { status: 422, code: "unpriced" },
  capability_not_supported: { status: 422, code: "capability_not_supported" },
  // 0046: the picture is not this organization's, was deleted, or is not a
  // usable image. Another organization's id reads exactly like a missing one.
  source_unavailable: { status: 422, code: "source_unavailable" },
  // 0048: the style kit is not this organization's or no longer exists —
  // another organization's kit reads exactly like a missing one.
  style_unavailable: { status: 422, code: "style_unavailable" },
  mode_not_supported: { status: 422, code: "mode_not_supported" },
  // 0075: no available, priced model of this plan takes these settings.
  no_model_available: { status: 422, code: "no_model_available" },
  invalid_params: { status: 400, code: "invalid_params" },
  invalid_idempotency_key: { status: 400, code: "invalid_idempotency_key" },
};
const NS409: Partial<Record<string, CreativeError>> = {
  price_changed: "price_changed",
  // 0075: the router's pick changed since the quote (a price, a probe or a plan).
  route_changed: "route_changed",
  idempotency_conflict: "idempotency_conflict",
  not_cancellable: "not_cancellable",
};

/** A database refusal -> the route's answer. `detail` is 0036's own sentence (never a secret). */
export function mapCreativeError(error: DbError): CreativeResult {
  if (isCreativeMissing(error)) return fail(503, "creative_unavailable");
  const word = (error.message ?? "").trim();
  const detail = typeof error.details === "string" && error.details ? error.details.slice(0, 300) : undefined;
  switch (error.code) {
    case "42501":
      return fail(403, "forbidden");
    case "P0002":
      return fail(404, "not_found");
    case "NS402": {
      const m = /available=(-?[\d.]+)\s+needed=([\d.]+)/.exec(error.details ?? "");
      return fail(402, "insufficient_credits", {
        available: m ? Number(m[1]) : null,
        needed: m ? Number(m[2]) : null,
        ...extraOffFields(error.details),
      });
    }
    case "NS429": {
      // 0034: the plan's parallel runs are all holding credits.
      const m = /active=(\d+)\s+limit=(\d+)/.exec(error.details ?? "");
      return fail(429, "run_limit_reached", { active: m ? Number(m[1]) : null, limit: m ? Number(m[2]) : null });
    }
    case "NS400": {
      const hit = NS400[word];
      return hit ? fail(hit.status, hit.code, detail ? { detail } : {}) : fail(400, "invalid_params", detail ? { detail } : {});
    }
    case "NS409": {
      const hit = NS409[word];
      return fail(409, hit ?? "failed", detail ? { detail } : {});
    }
  }
  return fail(502, "failed");
}

export interface GenerationInput {
  orgId: string;
  capability: CreativeCapability;
  model: string;
  params: Record<string, unknown>;
  mode: string;
  idempotencyKey: string | null;
  maxCredits: number | null;
}

/**
 * A quote / create body -> the input, or the 400. Unknown top-level fields
 * and unknown params are refused, not dropped: a typo must never silently
 * become "the default". `defaultOrg` is the organization the member has open.
 */
export function parseGenerationInput(
  body: unknown,
  defaultOrg: string | null,
  opts: { requirePrice: boolean; idempotencyHeader?: string | null },
): { ok: true; input: GenerationInput } | { ok: false; result: CreativeResult } {
  const b = obj(body);
  if (!b) return { ok: false, result: fail(400, "invalid_body") };
  const allowed = ["org_id", "capability", "model", "params", "mode", "idempotency_key", "max_credits"];
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) return { ok: false, result: fail(400, "invalid_body", { detail: `unknown field(s): ${unknown.join(", ")}` }) };

  const orgId = b.org_id == null ? defaultOrg : b.org_id;
  if (!isUuid(orgId)) return { ok: false, result: fail(400, "org_required") };
  const capability = b.capability;
  if (typeof capability !== "string" || !(CREATIVE_CAPABILITIES as readonly string[]).includes(capability))
    return { ok: false, result: fail(422, "capability_not_supported") };
  const mode = b.mode == null ? "exact" : typeof b.mode === "string" ? b.mode.trim().toLowerCase() : "";
  if (!(CREATIVE_MODES as readonly string[]).includes(mode))
    return { ok: false, result: fail(400, "invalid_params", { detail: "mode must be exact, auto, cheap, fast or quality" }) };
  const model = typeof b.model === "string" ? b.model.trim().toLowerCase() : "";
  // A routed QUOTE names no model (the database picks one); a routed CREATE
  // sends back the model and price its quote showed (0075). exact always names it.
  const modelOptional = mode !== "exact" && !opts.requirePrice && (b.model == null || model === "");
  if (!modelOptional && !MODEL_RE.test(model))
    return { ok: false, result: fail(400, "invalid_params", { detail: "model is required" }) };
  const params = obj(b.params);
  if (!params) return { ok: false, result: fail(400, "invalid_params", { detail: "params must be an object" }) };
  const badKeys = Object.keys(params).filter((k) => !(PARAM_KEYS as readonly string[]).includes(k));
  if (badKeys.length)
    return { ok: false, result: fail(400, "invalid_params", { detail: `unknown parameter(s): ${badKeys.join(", ")}` }) };
  if (JSON.stringify(params).length > MAX_PARAMS_BYTES)
    return { ok: false, result: fail(400, "invalid_params", { detail: "params are too large" }) };
  const recorded = RECORDING_CAPABILITIES.includes(capability);
  const filmed = (VIDEO_SOURCE_CAPABILITIES as readonly string[]).includes(capability);
  const sourced = recorded || filmed || (SOURCE_CAPABILITIES as readonly string[]).includes(capability);
  if (sourced && !isUuid(params.source_asset_id))
    return {
      ok: false,
      result: fail(400, "invalid_params", {
        detail: `source_asset_id (${recorded ? "an audio or video file" : filmed ? "a video" : "an image"} in the media library) is required for ${capability}`,
      }),
    };
  if (!sourced && params.source_asset_id !== undefined)
    return { ok: false, result: fail(400, "invalid_params", { detail: `source_asset_id does not apply to ${capability}` }) };
  if (capability === "upscale" && !(UPSCALE_FACTORS as readonly unknown[]).includes(params.factor))
    return { ok: false, result: fail(400, "invalid_params", { detail: "factor must be 2 or 4" }) };
  if (capability !== "upscale" && params.factor !== undefined)
    return { ok: false, result: fail(400, "invalid_params", { detail: `factor does not apply to ${capability}` }) };
  if (capability === "voice_change" && !(typeof params.voice_id === "string" && VOICE_ID_RE.test(params.voice_id)))
    return { ok: false, result: fail(400, "invalid_params", { detail: "voice_id (a voice of the account) is required for voice_change" }) };
  if (capability === "dub" && !(DUB_LANGUAGES as readonly unknown[]).includes(params.target_language))
    return { ok: false, result: fail(400, "invalid_params", { detail: `target_language must be one of ${DUB_LANGUAGES.join(", ")}` }) };
  if (capability !== "dub" && params.target_language !== undefined)
    return { ok: false, result: fail(400, "invalid_params", { detail: `target_language does not apply to ${capability}` }) };
  if (capability === "describe" && params.language !== undefined && !(DESCRIBE_LANGUAGES as readonly unknown[]).includes(params.language))
    return { ok: false, result: fail(400, "invalid_params", { detail: `language must be one of ${DESCRIBE_LANGUAGES.join(", ")}` }) };
  if (capability === "captions" && params.language !== undefined && !(CAPTION_LANGUAGES as readonly unknown[]).includes(params.language))
    return { ok: false, result: fail(400, "invalid_params", { detail: `language must be one of ${CAPTION_LANGUAGES.join(", ")}` }) };
  if (capability !== "describe" && capability !== "captions" && params.language !== undefined)
    return { ok: false, result: fail(400, "invalid_params", { detail: `language does not apply to ${capability}` }) };
  if ((recorded || filmed) && params.duration_s !== undefined)
    // The length is the file's own, measured by the database — never sent.
    return { ok: false, result: fail(400, "invalid_params", { detail: `duration_s does not apply to ${capability}` }) };
  if (filmed && !(UPSCALE_TARGETS as readonly unknown[]).includes(params.target_resolution))
    return { ok: false, result: fail(400, "invalid_params", { detail: `target_resolution must be one of ${UPSCALE_TARGETS.join(", ")}` }) };
  if (!filmed && params.target_resolution !== undefined)
    return { ok: false, result: fail(400, "invalid_params", { detail: `target_resolution does not apply to ${capability}` }) };
  if (params.end_asset_id !== undefined) {
    if (capability !== "i2v")
      return { ok: false, result: fail(400, "invalid_params", { detail: `end_asset_id does not apply to ${capability}` }) };
    if (!isUuid(params.end_asset_id))
      return { ok: false, result: fail(400, "invalid_params", { detail: "end_asset_id must be the id of an image in the media library" }) };
  }
  if (params.quality !== undefined) {
    if (!(QUALITY_CAPABILITIES as readonly string[]).includes(capability))
      return { ok: false, result: fail(400, "invalid_params", { detail: `quality does not apply to ${capability}` }) };
    if (!isImageQuality(params.quality))
      return { ok: false, result: fail(400, "invalid_params", { detail: `quality must be one of ${IMAGE_QUALITIES.join(", ")}` }) };
  }
  if (params.audio !== undefined) {
    if (!(AUDIO_CAPABILITIES as readonly string[]).includes(capability))
      return { ok: false, result: fail(400, "invalid_params", { detail: `audio does not apply to ${capability}` }) };
    if (typeof params.audio !== "boolean")
      return { ok: false, result: fail(400, "invalid_params", { detail: "audio must be true or false" }) };
  }
  if (params.style_kit_id !== undefined) {
    if (!(STYLE_CAPABILITIES as readonly string[]).includes(capability))
      return { ok: false, result: fail(400, "invalid_params", { detail: `style_kit_id does not apply to ${capability}` }) };
    if (!isUuid(params.style_kit_id))
      return { ok: false, result: fail(400, "invalid_params", { detail: "style_kit_id must be the id of a style kit" }) };
  }

  const headerKey = opts.idempotencyHeader?.trim() || null;
  const bodyKey = typeof b.idempotency_key === "string" ? b.idempotency_key.trim() || null : null;
  if (b.idempotency_key != null && typeof b.idempotency_key !== "string")
    return { ok: false, result: fail(400, "invalid_idempotency_key") };
  if (headerKey && bodyKey && headerKey !== bodyKey) return { ok: false, result: fail(400, "invalid_idempotency_key") };
  const idempotencyKey = headerKey ?? bodyKey;
  if (idempotencyKey && !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) return { ok: false, result: fail(400, "invalid_idempotency_key") };

  const mc = b.max_credits;
  const maxCredits = typeof mc === "number" && Number.isFinite(mc) && mc >= 0 ? mc : null;
  if (opts.requirePrice && maxCredits === null) return { ok: false, result: fail(400, "confirm_price") };

  return {
    ok: true,
    input: { orgId, capability: capability as CreativeCapability, model, params, mode, idempotencyKey, maxCredits },
  };
}

/**
 * The price of a generation, computed by the database. Nothing is held.
 * A routed mode (0075: auto / cheap / fast / quality) asks the database to
 * pick the model: the answer names it (`routed_model`, `display_name`), says
 * why (`route_reason`) and is that model's own quote.
 */
export async function quote(db: CreativeDb, input: GenerationInput): Promise<CreativeResult> {
  const { data, error } =
    input.mode === "exact"
      ? await db.rpc("quote_creative_job", {
          p_org: input.orgId,
          p_capability: input.capability,
          p_model: input.model,
          p_params: input.params,
        })
      : await db.rpc("quote_creative_route", {
          p_org: input.orgId,
          p_capability: input.capability,
          p_mode: input.mode,
          p_params: input.params,
        });
  // A database without 0075 has no router: automatic choice is not available
  // there yet (the existing sentence), never "generation is off".
  if (error && input.mode !== "exact" && isCreativeMissing(error)) return fail(422, "mode_not_supported");
  if (error) return mapCreativeError(error);
  const q = obj(data);
  if (!q || typeof q.credits !== "number") return fail(502, "failed");
  return { status: 200, body: { quote: q } };
}

/**
 * Quote, hold and queue in one database transaction. `maxCredits` is the
 * price the member confirmed: a higher price is refused (price_changed),
 * never charged. A replayed idempotency key answers the first job (200).
 */
export async function createGeneration(db: CreativeDb, input: GenerationInput): Promise<CreativeResult> {
  if (input.maxCredits === null) return fail(400, "confirm_price");
  const { data, error } = await db.rpc("create_creative_job", {
    p_org: input.orgId,
    p_capability: input.capability,
    p_model: input.model,
    p_params: input.params,
    p_mode: input.mode,
    p_idempotency_key: input.idempotencyKey,
    p_max_credits: input.maxCredits,
  });
  if (error) return mapCreativeError(error);
  const out = obj(data);
  const job = obj(out?.job);
  if (!out || !job || !isUuid(job.id)) return fail(502, "failed");
  const replay = out.replay === true;
  return { status: replay ? 200 : 201, body: { job, replay } };
}

export async function getJob(db: CreativeDb, id: string): Promise<CreativeResult> {
  if (!isUuid(id)) return fail(404, "not_found");
  const { data, error } = await db.readJob(id);
  if (error) return isCreativeMissing(error) ? fail(503, "creative_unavailable") : fail(502, "failed");
  // RLS hides another organization's job: it reads as missing, never as forbidden.
  if (!obj(data)) return fail(404, "not_found");
  return { status: 200, body: { job: data } };
}

/**
 * `capability=t2v,i2v` (a Studio desk's tools): which tools' jobs to list.
 * Absent or empty: every tool. Anything that is not a known tool is refused
 * rather than dropped, so a desk never reads "nothing here" because of a typo.
 */
export function parseCapabilityFilter(raw: string | null | undefined): { ok: true; value: CreativeCapability[] | null } | { ok: false } {
  if (raw === null || raw === undefined || raw.trim() === "") return { ok: true, value: null };
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > CREATIVE_CAPABILITIES.length) return { ok: false };
  const known = parts.filter((p): p is CreativeCapability => (CREATIVE_CAPABILITIES as readonly string[]).includes(p));
  if (known.length !== parts.length) return { ok: false };
  return { ok: true, value: [...new Set(known)] };
}

export async function listJobs(
  db: CreativeDb,
  orgId: string | null,
  limit = 50,
  capabilities: readonly CreativeCapability[] | null = null,
): Promise<CreativeResult> {
  if (!isUuid(orgId)) return fail(400, "org_required");
  const n = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
  const { data, error } = capabilities && capabilities.length > 0 ? await db.listJobs(orgId, n, capabilities) : await db.listJobs(orgId, n);
  if (error) return isCreativeMissing(error) ? fail(503, "creative_unavailable") : fail(502, "failed");
  return { status: 200, body: { jobs: Array.isArray(data) ? data : [] } };
}

/** Stop a job the provider has not started; its hold is released by the database. */
export async function cancelJob(db: CreativeDb, id: string): Promise<CreativeResult> {
  if (!isUuid(id)) return fail(404, "not_found");
  const { data, error } = await db.rpc("cancel_creative_job", { p_job: id });
  if (error) return mapCreativeError(error);
  const out = obj(data);
  if (!out || !obj(out.job)) return fail(502, "failed");
  return { status: 200, body: { job: out.job, already: out.already === true } };
}
