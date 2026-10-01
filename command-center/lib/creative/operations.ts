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

export type DbError = { code?: string; message?: string; details?: string | null; hint?: string | null };
export type DbAnswer = { data: unknown; error: DbError | null };

export interface CreativeDb {
  rpc(fn: string, args: Record<string, unknown>): Promise<DbAnswer>;
  /** One creative_jobs row by id, read through RLS (members of its org). */
  readJob(id: string): Promise<DbAnswer>;
  /** The newest creative_jobs rows of one org, read through RLS. */
  listJobs(orgId: string, limit: number): Promise<DbAnswer>;
}

export interface CreativeResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Capabilities 0036 / 0046 / 0050 accept. edit…remove_bg start from a picture
 * in the organization's media library (`params.source_asset_id`, migration
 * 0046); voice_change and dub start from a recording there (0050).
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
] as const;
export type CreativeCapability = (typeof CREATIVE_CAPABILITIES)[number];

/**
 * The capabilities whose input is a library image. Whether that image may be
 * used — it exists, belongs to the SAME organization, is live, is an image a
 * provider takes — is decided by the database (0046's
 * creative_source_problem), never here: this only checks the id's shape.
 */
export const SOURCE_CAPABILITIES = ["edit", "i2v", "upscale", "remove_bg"] as const satisfies readonly CreativeCapability[];

/**
 * The capabilities whose input is a library RECORDING — an audio or video
 * file (migration 0050). Whether it may be used — the SAME organization's,
 * live, a type the voice provider takes, of a measured length within the
 * tool's limit — is decided by the database (creative_source_problem); so is
 * the quantity (the recording's seconds), never this code or the browser.
 */
export const MEDIA_SOURCE_CAPABILITIES = ["voice_change", "dub"] as const satisfies readonly CreativeCapability[];

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

/** Upscale factors 0046 accepts; the model must also list the factor (spec.upscale_factors). */
export const UPSCALE_FACTORS = [2, 4] as const;

/** Keys 0036 / 0046 / 0048's creative_params_problem accepts; anything else is refused there too. */
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
  invalid_params: { status: 400, code: "invalid_params" },
  invalid_idempotency_key: { status: 400, code: "invalid_idempotency_key" },
};
const NS409: Partial<Record<string, CreativeError>> = {
  price_changed: "price_changed",
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
  const model = typeof b.model === "string" ? b.model.trim().toLowerCase() : "";
  if (!MODEL_RE.test(model)) return { ok: false, result: fail(400, "invalid_params", { detail: "model is required" }) };
  const params = obj(b.params);
  if (!params) return { ok: false, result: fail(400, "invalid_params", { detail: "params must be an object" }) };
  const badKeys = Object.keys(params).filter((k) => !(PARAM_KEYS as readonly string[]).includes(k));
  if (badKeys.length)
    return { ok: false, result: fail(400, "invalid_params", { detail: `unknown parameter(s): ${badKeys.join(", ")}` }) };
  if (JSON.stringify(params).length > MAX_PARAMS_BYTES)
    return { ok: false, result: fail(400, "invalid_params", { detail: "params are too large" }) };
  const recorded = (MEDIA_SOURCE_CAPABILITIES as readonly string[]).includes(capability);
  const sourced = recorded || (SOURCE_CAPABILITIES as readonly string[]).includes(capability);
  if (sourced && !isUuid(params.source_asset_id))
    return {
      ok: false,
      result: fail(400, "invalid_params", {
        detail: `source_asset_id (${recorded ? "an audio or video file" : "an image"} in the media library) is required for ${capability}`,
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
  if (recorded && params.duration_s !== undefined)
    // The length is the recording's own, measured by the database — never sent.
    return { ok: false, result: fail(400, "invalid_params", { detail: `duration_s does not apply to ${capability}` }) };
  if (params.style_kit_id !== undefined) {
    if (!(STYLE_CAPABILITIES as readonly string[]).includes(capability))
      return { ok: false, result: fail(400, "invalid_params", { detail: `style_kit_id does not apply to ${capability}` }) };
    if (!isUuid(params.style_kit_id))
      return { ok: false, result: fail(400, "invalid_params", { detail: "style_kit_id must be the id of a style kit" }) };
  }
  const mode = b.mode == null ? "exact" : typeof b.mode === "string" ? b.mode.trim().toLowerCase() : "";
  if (!mode) return { ok: false, result: fail(400, "invalid_params", { detail: "mode must be text" }) };

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

/** The price of a generation, computed by the database. Nothing is held. */
export async function quote(db: CreativeDb, input: GenerationInput): Promise<CreativeResult> {
  const { data, error } = await db.rpc("quote_creative_job", {
    p_org: input.orgId,
    p_capability: input.capability,
    p_model: input.model,
    p_params: input.params,
  });
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

export async function listJobs(db: CreativeDb, orgId: string | null, limit = 50): Promise<CreativeResult> {
  if (!isUuid(orgId)) return fail(400, "org_required");
  const { data, error } = await db.listJobs(orgId, Math.max(1, Math.min(100, Math.trunc(limit) || 50)));
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
