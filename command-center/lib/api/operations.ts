/**
 * What each public API operation does, independent of transport: the REST
 * routes under /api/v1 and the MCP tools both call these. Input is validated
 * here (a malformed request never reaches the database); everything that
 * decides — the key, the plan, the limits, the balance, the channel's
 * organization, the publish gate — is decided by migration 0031's functions,
 * which this module calls through `rpc` with the anon key.
 *
 * Pure apart from the injected `rpc`, so it is unit-tested with a fake one.
 */

import { VIDEO_PROVIDERS, IMAGE_PROVIDERS, type RunBackend } from "@/lib/runBackend";
import { API_KEY_PREFIX, hashApiKey, parseBearer, sha256Hex } from "@/lib/api/keys";
import { apiError, fromRpcResult, type ApiResult } from "@/lib/api/http";
import { parseGenerationInput } from "@/lib/creative/operations";

export type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;

export interface ApiCaller {
  /** The key's SHA-256. The key itself, and any part of it, is never kept. */
  keyHash: string;
  requestId: string;
  rpc: Rpc;
  backend: RunBackend;
  /** Whether this host can serve HD download files (0030's shared volume). */
  downloads: boolean;
}

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_:.-]{1,255}$/;
const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TARGET_CHANNEL_RE = /^[A-Za-z0-9._-]{1,128}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The key from the Authorization header, hashed; or the 401 to send. */
export async function authenticate(
  authorization: string | null | undefined,
): Promise<{ ok: true; keyHash: string } | { ok: false; result: ApiResult }> {
  const key = parseBearer(authorization);
  if (!key) {
    return {
      ok: false,
      result: apiError(
        401,
        "invalid_api_key",
        `Send your API key as "Authorization: Bearer ${API_KEY_PREFIX}…". Keys are created in the Developer console.`,
      ),
    };
  }
  return { ok: true, keyHash: await hashApiKey(key) };
}

function isMissing(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    error.code === "42P01" ||
    /could not find the function|does not exist/i.test(error.message ?? "")
  );
}

async function call(caller: ApiCaller, fn: string, args: Record<string, unknown>, migration = "0031"): Promise<ApiResult> {
  const { data, error } = await caller.rpc(fn, { p_key_hash: caller.keyHash, ...args, p_request_id: caller.requestId });
  if (error) {
    return isMissing(error)
      ? apiError(503, "api_unavailable", `The API is not set up on this deployment yet (migration ${migration}).`)
      : apiError(502, "upstream_error", "The database did not answer this request. Retry with backoff.");
  }
  return fromRpcResult(data);
}

function bad(code: string, message: string): ApiResult {
  return apiError(400, code, message);
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function checkIdempotencyKey(key: string | null | undefined): ApiResult | null {
  if (key == null) return null;
  return IDEMPOTENCY_KEY_RE.test(key)
    ? null
    : bad("invalid_idempotency_key", "Idempotency-Key: 1-255 characters of A-Z a-z 0-9 _ : . -");
}

// ── videos.create ──────────────────────────────────────────────────────────

export const CREATE_VIDEO_FIELDS = [
  "channel_id",
  "topic",
  "niche",
  "duration",
  "language",
  "visual_style",
  "video_provider",
  "image_provider",
] as const;

const TEXT_LIMITS: Record<string, number> = { topic: 300, niche: 120, language: 40, visual_style: 300 };

/**
 * A create-video body -> the channel and the render_jobs params, or the 400.
 * The same inputs, in the same bounds, that the site's Run now forwards and
 * 0019's insert policy accepts; unknown fields are refused, not ignored, so a
 * typo never silently becomes "the AI decides".
 */
export function parseCreateVideo(
  body: unknown,
): { ok: true; channelId: string; params: Record<string, string | number> } | { ok: false; result: ApiResult } {
  const b = obj(body);
  if (!b) return { ok: false, result: bad("invalid_body", "Send a JSON object.") };
  const unknown = Object.keys(b).filter((k) => !(CREATE_VIDEO_FIELDS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, result: bad("unknown_parameter", `Unknown field(s): ${unknown.join(", ")}.`) };
  const channelId = typeof b.channel_id === "string" ? b.channel_id.trim() : "";
  if (!CHANNEL_RE.test(channelId))
    return { ok: false, result: bad("channel_required", "channel_id is required (see GET /v1/channels).") };

  const params: Record<string, string | number> = {};
  for (const k of ["topic", "niche", "language", "visual_style"] as const) {
    const v = b[k];
    if (v == null || v === "") continue;
    if (typeof v !== "string") return { ok: false, result: bad("invalid_params", `${k} must be a string.`) };
    const s = v.trim();
    if (s.length > TEXT_LIMITS[k])
      return { ok: false, result: bad("invalid_params", `${k} is limited to ${TEXT_LIMITS[k]} characters.`) };
    if (s) params[k] = s;
  }
  if (b.duration != null) {
    const d = b.duration;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 30 || d > 3600)
      return { ok: false, result: bad("invalid_params", "duration is whole seconds between 30 and 3600.") };
    params.duration = d;
  }
  for (const [k, list] of [
    ["video_provider", VIDEO_PROVIDERS],
    ["image_provider", IMAGE_PROVIDERS],
  ] as const) {
    const v = b[k];
    if (v == null || v === "") continue;
    if (typeof v !== "string" || !(list as readonly string[]).includes(v.trim().toLowerCase()))
      return { ok: false, result: bad("invalid_params", `${k} must be one of: ${list.join(", ")}.`) };
    params[k] = v.trim().toLowerCase();
  }
  return { ok: true, channelId, params };
}

/** Same request, same fingerprint: the body as parsed, keys in a fixed order. */
export function fingerprint(endpoint: string, value: unknown): Promise<string> {
  return sha256Hex(endpoint + "\n" + stableJson(value));
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

export async function createVideo(caller: ApiCaller, body: unknown, idempotencyKey?: string | null): Promise<ApiResult> {
  const idem = checkIdempotencyKey(idempotencyKey);
  if (idem) return idem;
  const parsed = parseCreateVideo(body);
  if (!parsed.ok) return parsed.result;
  // API videos are queued for the VPS worker (render_jobs): a job there is
  // what the API holds money against and reports status for.
  if (caller.backend !== "queue")
    return apiError(503, "queue_backend_required", "Video creation through the API needs the render queue, which this deployment does not use yet.");
  return call(caller, "api_create_video", {
    p_channel_id: parsed.channelId,
    p_params: parsed.params,
    p_idem_key: idempotencyKey ?? null,
    p_fingerprint: idempotencyKey ? await fingerprint("videos.create", { channel_id: parsed.channelId, ...parsed.params }) : null,
  });
}

// ── reads ──────────────────────────────────────────────────────────────────

export function getMe(caller: ApiCaller): Promise<ApiResult> {
  return call(caller, "api_auth", {});
}

export function getBalance(caller: ApiCaller): Promise<ApiResult> {
  return call(caller, "api_balance", {});
}

export function listChannels(caller: ApiCaller): Promise<ApiResult> {
  return call(caller, "api_list_channels", {});
}

export function listAccounts(caller: ApiCaller): Promise<ApiResult> {
  return call(caller, "api_list_connected_accounts", {});
}

function intParam(v: unknown, min: number, max: number): number | null | "bad" {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,6}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : "bad";
}

export async function listVideos(
  caller: ApiCaller,
  query: { channel_id?: unknown; limit?: unknown; offset?: unknown },
): Promise<ApiResult> {
  const channel = query.channel_id == null || query.channel_id === "" ? null : String(query.channel_id);
  if (channel !== null && !CHANNEL_RE.test(channel)) return bad("invalid_params", "channel_id is not a channel id.");
  const limit = intParam(query.limit, 1, 100);
  const offset = intParam(query.offset, 0, 10000);
  if (limit === "bad") return bad("invalid_params", "limit is a whole number from 1 to 100.");
  if (offset === "bad") return bad("invalid_params", "offset is a whole number from 0 to 10000.");
  return call(caller, "api_list_videos", { p_channel_id: channel, p_limit: limit ?? 20, p_offset: offset ?? 0 });
}

export async function getVideo(caller: ApiCaller, videoId: string): Promise<ApiResult> {
  if (!VIDEO_ID_RE.test(videoId)) return apiError(404, "video_not_found", "No video with that id in this key's organization.");
  return call(caller, "api_get_video", { p_video_id: videoId });
}

export async function getJob(caller: ApiCaller, jobId: string): Promise<ApiResult> {
  if (!/^[1-9]\d{0,14}$/.test(jobId)) return apiError(404, "job_not_found", "No job with that id in this key's organization.");
  return call(caller, "api_get_job", { p_job_id: Number(jobId) });
}

// ── videos.publish ─────────────────────────────────────────────────────────

export function parsePublish(
  body: unknown,
): { ok: true; accountIds: string[]; channelIds: string[] } | { ok: false; result: ApiResult } {
  const b = obj(body);
  if (!b) return { ok: false, result: bad("invalid_body", "Send a JSON object.") };
  const unknown = Object.keys(b).filter((k) => k !== "account_ids" && k !== "channel_ids");
  if (unknown.length) return { ok: false, result: bad("unknown_parameter", `Unknown field(s): ${unknown.join(", ")}.`) };
  const list = (v: unknown, re: RegExp, name: string): string[] | ApiResult => {
    if (v == null) return [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && re.test(x)))
      return bad("invalid_params", `${name} must be an array of ids.`);
    return [...new Set(v as string[])];
  };
  const accountIds = list(b.account_ids, UUID_RE, "account_ids");
  if (!Array.isArray(accountIds)) return { ok: false, result: accountIds };
  const channelIds = list(b.channel_ids, TARGET_CHANNEL_RE, "channel_ids");
  if (!Array.isArray(channelIds)) return { ok: false, result: channelIds };
  if (accountIds.length + channelIds.length === 0)
    return { ok: false, result: bad("targets_required", "Name at least one account_id or YouTube channel_id (see GET /v1/accounts).") };
  if (accountIds.length + channelIds.length > 10)
    return { ok: false, result: bad("too_many_targets", "At most 10 targets per request.") };
  return { ok: true, accountIds: accountIds.map((a) => a.toLowerCase()), channelIds };
}

export async function publishVideo(
  caller: ApiCaller,
  videoId: string,
  body: unknown,
  idempotencyKey?: string | null,
): Promise<ApiResult> {
  const idem = checkIdempotencyKey(idempotencyKey);
  if (idem) return idem;
  if (!VIDEO_ID_RE.test(videoId)) return apiError(404, "video_not_found", "No video with that id in this key's organization.");
  const parsed = parsePublish(body);
  if (!parsed.ok) return parsed.result;
  return call(caller, "api_request_publish", {
    p_video_id: videoId,
    p_account_ids: parsed.accountIds,
    p_channel_ids: parsed.channelIds,
    p_idem_key: idempotencyKey ?? null,
    p_fingerprint: idempotencyKey
      ? await fingerprint("videos.publish", { video_id: videoId, account_ids: parsed.accountIds, channel_ids: parsed.channelIds })
      : null,
  });
}

// ── downloads (0030's flow, paid from the API balance) ─────────────────────

export async function requestDownload(
  caller: ApiCaller,
  videoId: string,
  body: unknown,
  idempotencyKey?: string | null,
): Promise<ApiResult> {
  const idem = checkIdempotencyKey(idempotencyKey);
  if (idem) return idem;
  if (!VIDEO_ID_RE.test(videoId)) return apiError(404, "video_not_found", "No video with that id in this key's organization.");
  const b = obj(body);
  if (!b) return bad("invalid_body", "Send a JSON object.");
  const unknown = Object.keys(b).filter((k) => k !== "quality");
  if (unknown.length) return bad("unknown_parameter", `Unknown field(s): ${unknown.join(", ")}.`);
  if (b.quality !== "720p" && b.quality !== "1080p") return bad("invalid_params", "quality must be 720p or 1080p.");
  // Nothing is sold that this host could not serve.
  if (!caller.downloads)
    return apiError(503, "downloads_unavailable", "HD downloads are served from the Nightshift server; this host has no downloads volume.");
  return call(caller, "api_request_download", {
    p_video_id: videoId,
    p_quality: b.quality,
    p_idem_key: idempotencyKey ?? null,
    p_fingerprint: idempotencyKey ? await fingerprint("downloads.create", { video_id: videoId, quality: b.quality }) : null,
  });
}

export async function getDownload(caller: ApiCaller, id: string): Promise<ApiResult> {
  if (!/^[1-9]\d{0,14}$/.test(id)) return apiError(404, "download_not_found", "No download with that id in this key's organization.");
  const result = await call(caller, "api_get_download", { p_id: Number(id) });
  if (result.ok && result.data && typeof result.data === "object") {
    const d = result.data as Record<string, unknown>;
    if (d.status === "ready") return { ...result, data: { ...d, file_url: `/api/v1/downloads/${id}/file` } };
  }
  return result;
}

// ── creative generations (0062) ────────────────────────────────────────────
//
// The same generation the Studio starts, with a key instead of a session. The
// money is the organization's credits (not the USD API balance): the database
// holds the quote with the UI's own create_creative_job, the worker captures
// or releases it, and nothing here computes or moves a credit. The body is
// shape-checked with the Studio's own parser (lib/creative/operations), so
// the two doors accept exactly the same generations; what a request may NOT
// carry is an organization (the key's is used) or an idempotency key in the
// body (it is a header, required).

const CREATIVE_BODY_FIELDS = ["capability", "model", "params", "mode", "max_credits"] as const;
/** Any well-formed organization id: parseGenerationInput needs one and the API never uses it. */
const NO_ORG = "00000000-0000-0000-0000-000000000000";

const CREATIVE_MESSAGES: Record<string, string> = {
  invalid_body: "Send a JSON object with capability, model, params and max_credits.",
  capability_not_supported: "capability is not one this API can generate.",
  invalid_params: "A parameter is missing or not accepted.",
  invalid_idempotency_key: "Idempotency-Key: 1-255 characters of A-Z a-z 0-9 _ : . -",
};

export interface CreativeRequest {
  capability: string;
  model: string;
  params: Record<string, unknown>;
  mode: string;
  maxCredits: number | null;
}

/** A quote / create body -> the request, or the 400 / 422. `max_credits` is required for create. */
export function parseCreativeBody(
  body: unknown,
  opts: { requireMaxCredits: boolean },
): { ok: true; request: CreativeRequest } | { ok: false; result: ApiResult } {
  const b = obj(body);
  if (!b) return { ok: false, result: bad("invalid_body", CREATIVE_MESSAGES.invalid_body) };
  const unknown = Object.keys(b).filter((k) => !(CREATIVE_BODY_FIELDS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, result: bad("unknown_parameter", `Unknown field(s): ${unknown.join(", ")}.`) };
  if (opts.requireMaxCredits && b.max_credits == null)
    return {
      ok: false,
      result: bad("max_credits_required", "max_credits is required: the most credits you accept to be charged for this generation (see the quote)."),
    };
  if (b.max_credits != null && !(typeof b.max_credits === "number" && Number.isFinite(b.max_credits) && b.max_credits >= 0))
    return { ok: false, result: bad("max_credits_required", "max_credits must be a number of credits, 0 or more.") };
  const parsed = parseGenerationInput({ ...b, org_id: NO_ORG }, NO_ORG, { requirePrice: opts.requireMaxCredits });
  if (!parsed.ok) {
    const code = String(parsed.result.body.error ?? "invalid_params");
    const detail = typeof parsed.result.body.detail === "string" ? parsed.result.body.detail : undefined;
    return {
      ok: false,
      result: apiError(parsed.result.status, code === "confirm_price" ? "max_credits_required" : code, detail ?? CREATIVE_MESSAGES[code] ?? "The request is not valid.", {
        details: detail ? { detail } : undefined,
      }),
    };
  }
  const i = parsed.input;
  return { ok: true, request: { capability: i.capability, model: i.model, params: i.params, mode: i.mode, maxCredits: i.maxCredits } };
}

/** POST /v1/creative/quote — the price in credits. Nothing is held or charged. */
export async function quoteCreative(caller: ApiCaller, body: unknown): Promise<ApiResult> {
  const parsed = parseCreativeBody(body, { requireMaxCredits: false });
  if (!parsed.ok) return parsed.result;
  const r = parsed.request;
  return call(caller, "api_creative_quote", { p_capability: r.capability, p_model: r.model, p_params: r.params }, "0062");
}

/**
 * POST /v1/creative/jobs — quote, hold and queue one generation. An
 * Idempotency-Key header and max_credits are required: a retry never pays
 * twice, and a price above max_credits is refused, not charged.
 */
export async function createCreative(caller: ApiCaller, body: unknown, idempotencyKey?: string | null): Promise<ApiResult> {
  if (idempotencyKey == null || idempotencyKey.trim() === "")
    return bad("idempotency_key_required", "Send an Idempotency-Key header: a generation spends credits, and a retry must not spend twice.");
  const key = idempotencyKey.trim();
  const badKey = checkIdempotencyKey(key);
  if (badKey) return badKey;
  const parsed = parseCreativeBody(body, { requireMaxCredits: true });
  if (!parsed.ok) return parsed.result;
  const r = parsed.request;
  return call(caller, "api_creative_create", {
    p_capability: r.capability,
    p_model: r.model,
    p_params: r.params,
    p_mode: r.mode,
    p_max_credits: r.maxCredits,
    p_idem_key: key,
    p_fingerprint: await fingerprint("creative.create", {
      capability: r.capability,
      model: r.model,
      params: r.params,
      mode: r.mode,
      max_credits: r.maxCredits,
    }),
  }, "0062");
}

/** GET /v1/creative/jobs/{id} — a generation this key started. */
export async function getCreativeJob(caller: ApiCaller, jobId: string): Promise<ApiResult> {
  if (!UUID_RE.test(jobId)) return apiError(404, "job_not_found", "No generation with that id for this key.");
  return call(caller, "api_creative_get", { p_job_id: jobId.toLowerCase() }, "0062");
}
