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

import { parseJobError, type RunBackend } from "@/lib/runBackend";
import { en } from "@/lib/i18n/en";
import { API_KEY_PREFIX, hashApiKey, parseBearer, sha256Hex } from "@/lib/api/keys";
import { apiError, fromRpcResult, type ApiResult } from "@/lib/api/http";
import { parseGenerationInput, type CreativeCapability } from "@/lib/creative/operations";

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
  /**
   * A signed, expiring path to one variant of a library file (lib/server/media.ts signedMediaPath), or null when this host has no
   * media volume or no signing secret. A connected app's links are absolute on this deployment's origin (lib/server/public-api.ts).
   */
  mediaLink?: (assetId: string, variant: "original" | "thumb" | "proxy", mime: string) => string | null;
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
] as const;

/**
 * Not selectable through the API or MCP. A provider is the platform's choice:
 * the API price is flat per minute (api_video_price), so letting a caller pick
 * Veo or Kling would spend a funded key at a price that does not cover it.
 * The operator's own Create form (and the worker's env) still choose providers.
 */
const PROVIDER_FIELDS = ["video_provider", "image_provider"] as const;

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
  // Blank ('' or null) is what a client that always sent the field sends: ignored for one release. Anything
  // else is refused. Route level only: the SQL entry points still accept the params from a direct caller.
  const blank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");
  if (PROVIDER_FIELDS.some((k) => k in b && !blank(b[k])))
    return {
      ok: false,
      result: bad("unknown_parameter", "video_provider and image_provider cannot be set through the API: the platform chooses the providers."),
    };
  const unknown = Object.keys(b).filter(
    (k) => !(CREATE_VIDEO_FIELDS as readonly string[]).includes(k) && !((PROVIDER_FIELDS as readonly string[]).includes(k) && blank(b[k])),
  );
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

/** Whether Google still accepts a channel's YouTube connection, as far as anything recorded says. */
export type YoutubeConnected = true | false | "unknown";

function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" && Number.isFinite(Date.parse(v)) ? v : null;
}

/**
 * api_list_channels / api_list_connected_accounts answer `publish_channel_connected()`: a token row or secret EXISTS.
 * That is not "Google accepts it": on 2026-11-14 both said `true` for a channel whose refresh token Google had already
 * revoked (invalid_grant), and the run it was asked for stopped at the credential preflight (CLAUDE.md rule 5: an
 * unknown shown as known). So `true` alone is not passed on:
 *
 * - no token at all (`present` false) is `false`: that much the database knows;
 * - a token with no recorded check is `"unknown"`, never `true`;
 * - a recorded check (`check`, the bot's last `youtube_token_live` verdict, as `{status, checked_at, connected_at}`;
 *   the database does not send it yet, see the follow-up in docs/API.md) counts only when it is newer than the
 *   connection: a reconnect after a dead verdict is a new token nobody has asked Google about yet.
 *
 * Never a live Google call: this runs on every list. Pure.
 */
export function honestYoutubeConnected(present: unknown, check: unknown): { connected: YoutubeConnected; checked_at: string | null } {
  if (present === false) return { connected: false, checked_at: null };
  if (present !== true) return { connected: "unknown", checked_at: null };
  const c = obj(check);
  const checkedAt = isoOrNull(c?.checked_at);
  if (!c || checkedAt === null) return { connected: "unknown", checked_at: null };
  const connectedAt = isoOrNull(c.connected_at);
  const current = connectedAt === null || Date.parse(checkedAt) >= Date.parse(connectedAt);
  if (current && c.status === "dead") return { connected: false, checked_at: checkedAt };
  if (current && c.status === "live") return { connected: true, checked_at: checkedAt };
  return { connected: "unknown", checked_at: current ? checkedAt : null };
}

/** `youtube_token_check` is the database's input to the verdict above, not part of the answer. */
function withoutCheck(row: Record<string, unknown>): Record<string, unknown> {
  const { youtube_token_check: _check, ...rest } = row;
  void _check;
  return rest;
}

function mapList(result: ApiResult, key: string, fix: (row: Record<string, unknown>) => Record<string, unknown>): ApiResult {
  if (!result.ok) return result;
  const data = obj(result.data);
  if (!data || !Array.isArray(data[key])) return result;
  return { ...result, data: { ...data, [key]: (data[key] as unknown[]).map((r) => (obj(r) ? fix(obj(r)!) : r)) } };
}

export function honestChannels(result: ApiResult): ApiResult {
  return mapList(result, "channels", (row) => {
    const { connected, checked_at } = honestYoutubeConnected(row.youtube_connected, row.youtube_token_check);
    return { ...withoutCheck(row), youtube_connected: connected, youtube_checked_at: checked_at };
  });
}

export function honestAccounts(result: ApiResult): ApiResult {
  return mapList(result, "accounts", (row) => {
    // Instagram / TikTok rows carry their own connection status (social_accounts.status); only YouTube's is presence.
    if (row.platform !== "youtube") return row;
    const { connected, checked_at } = honestYoutubeConnected(row.connected, row.youtube_token_check);
    return { ...withoutCheck(row), connected, checked_at };
  });
}

export async function listChannels(caller: ApiCaller): Promise<ApiResult> {
  return honestChannels(await call(caller, "api_list_channels", {}));
}

export async function listAccounts(caller: ApiCaller): Promise<ApiResult> {
  return honestAccounts(await call(caller, "api_list_connected_accounts", {}));
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
  return withPublicJobError(await call(caller, "api_get_job", { p_job_id: Number(jobId) }));
}

/**
 * api_get_job returns render_jobs.error verbatim: the operator's header and log tail, with vendor names and
 * remedies. The API sends a code and one fixed sentence instead (the same ones the Create page shows), never the
 * text. Since migration 0111 api_get_job / oauth_get_job do this themselves (render_job_public_error) and answer with
 * `error_code` already present; that answer is passed through untouched, because the sentence it carries has no
 * `[code:]` prefix and would otherwise read as an uncoded failure. A database without 0111 still sends the raw text
 * and is mapped here, so either order of deploy is safe.
 */
export function withPublicJobError(result: ApiResult): ApiResult {
  if (!result.ok) return result;
  const data = obj(result.data);
  if (!data || !("error" in data)) return result;
  if ("error_code" in data) return result;
  // Only a failed job has a failure to explain. The worker also writes `error` on a re-queue ("worker stopping
  // before the run started"): operator text that says nothing the caller needs.
  const raw = data.status === "failed" && typeof data.error === "string" && data.error !== "" ? data.error : null;
  if (raw === null) return { ...result, data: { ...data, error: null, error_code: null } };
  const code = parseJobError(raw).code ?? "unknown";
  return { ...result, data: { ...data, error: en.create.jobError[code], error_code: code } };
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
  invalid_body: "Send a JSON object with capability, model (or a mode), params and max_credits.",
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
  if (r.mode === "exact")
    return call(caller, "api_creative_quote", { p_capability: r.capability, p_model: r.model, p_params: r.params }, "0062");
  // A routed mode (0075): the database picks among the models the API sells and
  // answers that model's id, the reason and its quote. Create then sends back
  // that model and price (max_credits); a different pick is 409 route_changed.
  return call(
    caller,
    "api_creative_quote",
    { p_capability: r.capability, p_model: r.model || null, p_params: r.params, p_mode: r.mode },
    "0075",
  );
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

// ── the MCP Studio tools (0162) ────────────────────────────────────────────

/**
 * What the API generates: the capabilities api_creative_quote / _create accept for a key, i.e. the creative list
 * (lib/creative/operations.ts) without captions (a web tool, 0125) and music (no registry capability; 0100's check). 0162's
 * api_creative_models lists only models with one of these (its SQL array is pinned equal by tests/test_api_creative_models_migration.py).
 */
export const API_CREATIVE_CAPABILITIES = [
  "t2i", "edit", "t2v", "i2v", "tts", "sfx", "upscale", "remove_bg", "voice_change", "dub", "video_upscale", "describe",
  "expand", "relight", "erase", "video_edit", "video_reframe", "video_remove_bg",
] as const satisfies readonly CreativeCapability[];

/**
 * The models this key's organization can generate with through the API (0162 api_creative_models): what its create would accept,
 * with each model's shapes, durations and resolutions. No price: quote_generation is the price.
 */
export async function listCreativeModels(caller: ApiCaller, capability?: string | null): Promise<ApiResult> {
  const cap = capability == null ? null : capability.trim().toLowerCase();
  if (cap !== null && !(API_CREATIVE_CAPABILITIES as readonly string[]).includes(cap))
    return bad("invalid_params", `capability must be one of: ${API_CREATIVE_CAPABILITIES.join(", ")}.`);
  return call(caller, "api_creative_models", { p_capability: cap }, "0162");
}

type JobFile = { asset_id: string; kind: string; mime: string; variants: string[]; width?: number | null; height?: number | null; duration_s?: number | null };

/**
 * A generation this key started, with a signed link to each result file (0162 api_creative_job_files). The link is a same-origin
 * path that expires (lib/server/media.ts: MEDIA_URL_TTL_S); ask again for a fresh one. A host with no media volume or signing secret
 * answers the files with `url: null` and says why, never a link that cannot work.
 */
export async function getCreativeJobFiles(caller: ApiCaller, jobId: string): Promise<ApiResult> {
  if (!UUID_RE.test(jobId)) return apiError(404, "job_not_found", "No generation with that id for this key.");
  return withFileLinks(caller, await call(caller, "api_creative_job_files", { p_job_id: jobId.toLowerCase() }, "0162"));
}

/**
 * A generation's answer with a signed link per result file (the database lists files only for a completed job of THIS caller:
 * 0162 for a key, 0176 for a connection). Shared by get_generation and get_creative_job so the two can never sign differently.
 */
function withFileLinks(caller: ApiCaller, result: ApiResult): ApiResult {
  if (!result.ok || !result.data || typeof result.data !== "object") return result;
  const d = result.data as Record<string, unknown>;
  const raw: JobFile[] = Array.isArray(d.files) ? (d.files as JobFile[]) : [];
  const sign = caller.mediaLink;
  const files = raw.map((f) => {
    const id = String(f.asset_id ?? "");
    const mime = String(f.mime ?? "");
    const variants = Array.isArray(f.variants) ? f.variants : [];
    // The original, never the smaller proxy: this is the file the person paid for.
    const url = UUID_RE.test(id) && mime && sign ? sign(id, "original", mime) : null;
    const thumbnail_url = UUID_RE.test(id) && mime && sign && variants.includes("thumb") ? sign(id, "thumb", mime) : null;
    return { asset_id: id, kind: f.kind, mime, width: f.width ?? null, height: f.height ?? null, duration_s: f.duration_s ?? null, url, thumbnail_url };
  });
  // CLAUDE.md #5: an empty or short list must never read as "it made nothing". The database lists files only for a completed job
  // (0162, Breach BR-0162-1), and only those still in the library on this server's own volume.
  const made = Array.isArray(d.result_asset_ids) ? d.result_asset_ids.length : 0;
  const note =
    d.status !== "completed"
      ? // A failed, cancelled or expired generation was not charged and has no files to give; its error says why.
        ["failed", "cancelled", "expired"].includes(String(d.status))
        ? null
        : "Files are listed once the generation is completed."
      : files.length < made
        ? `${made - files.length} of this generation's ${made} results cannot be served from this server (deleted, or stored elsewhere); what is still kept is in the workspace's library in the app.`
        : files.length > 0 && files.every((f) => f.url === null)
          ? "This server cannot hand out file links right now; the files are in the workspace's library in the app."
          : null;
  return { ...result, data: { ...d, files, ...(note ? { files_note: note } : {}) } };
}

// ── the Studio for a connected assistant (OAuth, migration 0176) ──────────
//
// Four doors of a connection's own: oauth_creative_models / _quote / _create / _get and oauth_media_list. They take the access
// token's hash (oauthRpc renames p_key_hash to p_token_hash) and open with oauth_ctx, so an API key's hash is unknown to them. The
// price is creative_price's, kept in the database as a quote; create sends ONLY the quote's id and an idempotency key, so nothing an
// assistant sends at create can differ from what the person was shown. Nothing here computes a credit.

/** quote_creative: the price of one exact generation, kept for this connection for a few minutes. Nothing is held. */
export async function oauthQuoteCreative(caller: ApiCaller, body: unknown): Promise<ApiResult> {
  const b = obj(body);
  // An assistant's quote is exact: it names the model the person chose. The router's modes stay the Studio's and the API's.
  if (b && b.mode != null && b.mode !== "exact") return bad("invalid_params", "Name a model: a connected app quotes one exact model.");
  const parsed = parseCreativeBody(b ? { capability: b.capability, model: b.model, params: b.params } : body, { requireMaxCredits: false });
  if (!parsed.ok) return parsed.result;
  const r = parsed.request;
  if (!(API_CREATIVE_CAPABILITIES as readonly string[]).includes(r.capability))
    return bad("capability_not_supported", `capability must be one of: ${API_CREATIVE_CAPABILITIES.join(", ")}.`);
  return call(caller, "oauth_creative_quote", { p_capability: r.capability, p_model: r.model, p_params: r.params }, "0176");
}

/** create_creative: start the generation a quote priced, at exactly that price, once per idempotency key. */
export async function oauthCreateCreative(caller: ApiCaller, quoteId: string, idempotencyKey: string | null | undefined): Promise<ApiResult> {
  if (idempotencyKey == null || idempotencyKey.trim() === "")
    return bad("idempotency_key_required", "Send an idempotency_key: a generation spends credits, and a retry must not spend twice.");
  const badKey = checkIdempotencyKey(idempotencyKey.trim());
  if (badKey) return badKey;
  if (!UUID_RE.test(quoteId)) return apiError(404, "quote_not_found", "No quote with that id for this connection. Quote again (quote_creative).");
  return call(caller, "oauth_creative_create", { p_quote_id: quoteId.toLowerCase(), p_idem_key: idempotencyKey.trim() }, "0176");
}

/** list_creative_models: the models this connection's workspace can generate with through an assistant now. No prices. */
export async function oauthListCreativeModels(caller: ApiCaller, capability?: string | null): Promise<ApiResult> {
  const cap = capability == null ? null : capability.trim().toLowerCase();
  if (cap !== null && !(API_CREATIVE_CAPABILITIES as readonly string[]).includes(cap))
    return bad("invalid_params", `capability must be one of: ${API_CREATIVE_CAPABILITIES.join(", ")}.`);
  const result = await call(caller, "oauth_creative_models", { p_capability: cap }, "0176");
  if (!result.ok || !result.data || typeof result.data !== "object") return result;
  const d = result.data as Record<string, unknown>;
  // CLAUDE.md #5: an empty list is a fact about what is offered to assistants, not "the Studio has no models".
  if (Array.isArray(d.models) && d.models.length === 0)
    return {
      ...result,
      data: {
        ...d,
        models_note:
          "No model is offered to connected apps " + (cap ? `for ${cap} ` : "") + "right now: a model is offered here only once its terms allow it. " +
          "Every Studio model can still be used in the Studio itself.",
      },
    };
  return result;
}

export const MEDIA_KINDS = ["image", "video", "audio"] as const;

/** list_media: the workspace's own library, newest first; the ids an edit or a picture-to-clip takes as source_asset_id. */
export async function oauthListMedia(caller: ApiCaller, kind?: string | null, limit?: number | null): Promise<ApiResult> {
  const k = kind == null ? null : kind.trim().toLowerCase();
  if (k !== null && !(MEDIA_KINDS as readonly string[]).includes(k)) return bad("invalid_params", "kind must be image, video or audio.");
  const lim = limit == null ? null : intParam(limit, 1, 100);
  if (lim === "bad") return bad("invalid_params", "limit must be a whole number from 1 to 100.");
  return call(caller, "oauth_media_list", { p_kind: k, p_limit: lim }, "0176");
}

/** get_creative_job: a generation this connection started, with short-lived links to its files once it completed. */
export async function oauthGetCreativeJob(caller: ApiCaller, jobId: string): Promise<ApiResult> {
  if (!UUID_RE.test(jobId)) return apiError(404, "job_not_found", "No generation with that id for this connection.");
  return withFileLinks(caller, await call(caller, "oauth_creative_get", { p_job_id: jobId.toLowerCase() }, "0176"));
}
