/**
 * What differs when the caller is an AI app connected with OAuth (migration
 * 0093) instead of a holder of an API key:
 *
 *  - the tools it is offered follow the permissions the person gave
 *    (videos:read / videos:create / videos:publish), and the two paid-download
 *    tools are not offered at all (they are priced in US cents from the prepaid
 *    API balance and served by an API-key route);
 *  - every database call is routed to a function that takes the access token's
 *    hash. create_video, get_job_status and get_balance go to oauth_* functions
 *    that spend and report SITE CREDITS; the reads and publish reuse the API
 *    functions, which the database lets an access token reach only through an
 *    allow-list. Any other function name is refused HERE, before the network:
 *    the USD-balance functions cannot be called by a mapping mistake;
 *  - a refusal is written for the person to read, with the next step and the
 *    link, and with nothing internal in it.
 */

import type { Rpc } from "@/lib/api/operations";
import type { ApiResult } from "@/lib/api/http";

export type McpScope = "videos:read" | "videos:create" | "videos:publish" | "studio:create";

/** The tool -> permission it needs. A tool not listed here is not offered to an OAuth caller. */
export const OAUTH_TOOL_SCOPES = {
  list_channels: "videos:read",
  list_videos: "videos:read",
  get_video: "videos:read",
  list_connected_accounts: "videos:read",
  get_job_status: "videos:read",
  get_balance: "videos:read",
  create_video: "videos:create",
  publish_video: "videos:publish",
  // 0175: the Studio's generations, behind their own permission (a person who allowed "make videos" allowed nothing else). Every
  // model is off for assistants until its terms allow it, so list_creative_models can honestly answer an empty list.
  list_creative_models: "studio:create",
  list_media: "studio:create",
  quote_creative: "studio:create",
  create_creative: "studio:create",
  get_creative_job: "studio:create",
} as const satisfies Record<string, McpScope>;

/** The connected-app Studio tools (0175), in the order a client lists them. Never offered to an API key (it has its own four). */
export const OAUTH_STUDIO_TOOL_NAMES = ["list_creative_models", "list_media", "quote_creative", "create_creative", "get_creative_job"] as const;

/** 0175's functions: a connection's own doors, which take the token's hash as p_token_hash and open with oauth_ctx. */
const OAUTH_CREATIVE = new Set(["oauth_creative_models", "oauth_media_list", "oauth_creative_quote", "oauth_creative_create", "oauth_creative_get"]);

/** Functions an access token may be sent to, and what each is called for it. */
const SAME = new Set(["api_list_channels", "api_list_videos", "api_get_video", "api_list_connected_accounts", "api_request_publish"]);

export const TOKEN_REFUSAL = {
  data: { ok: false, status: 403, error: { code: "not_available_for_connected_apps", message: "This action is not available to connected apps. It needs an API key." } },
  error: null,
} as const;

/** The database call of an OAuth caller: only the allow-listed functions, with the token's hash. */
export function oauthRpc(rpc: Rpc): Rpc {
  return async (fn, args) => {
    const { p_key_hash: hash, p_fingerprint: _fingerprint, ...rest } = args;
    void _fingerprint;
    // A connection's publish has no idempotency record: the API's idempotency
    // table belongs to API keys (its rows are keyed by key id, which a token
    // has none of), so the key and its fingerprint are not passed on; passing
    // one made the call fail. A target still being sent to is answered
    // "already_sending" by the database, but once that post has finished a new
    // call posts again, which is why the OAuth publish_video schema offers no
    // idempotency_key at all (lib/api/mcp.ts).
    if (fn === "api_request_publish") {
      const { p_idem_key: _idem, ...noIdem } = rest;
      void _idem;
      return rpc(fn, { p_key_hash: hash, ...noIdem });
    }
    if (SAME.has(fn)) return rpc(fn, { p_key_hash: hash, ...rest });
    if (fn === "api_get_job") return rpc("oauth_get_job", { p_token_hash: hash, ...rest });
    if (fn === "api_balance") return rpc("oauth_get_balance", { p_token_hash: hash, ...rest });
    if (fn === "api_create_video") return rpc("oauth_create_video", { p_token_hash: hash, ...rest });
    if (OAUTH_CREATIVE.has(fn)) return rpc(fn, { p_token_hash: hash, ...rest });
    return { data: TOKEN_REFUSAL.data, error: null };
  };
}

function credits(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "?";
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * The permission a tool needs that this grant lacks, or null (granted, or not
 * a connected-app tool at all). A tool the grant lacks is not listed, but an
 * assistant may still call it (it remembers the tool from the docs or another
 * connection): it is then told which permission is missing, not "not found".
 */
export function missingScope(tool: string, scopes: readonly string[]): McpScope | null {
  // Own keys only: the tool name is the caller's input, and "toString" or
  // "constructor" would otherwise find the object's prototype.
  if (!Object.hasOwn(OAUTH_TOOL_SCOPES, tool)) return null;
  const need = OAUTH_TOOL_SCOPES[tool as keyof typeof OAUTH_TOOL_SCOPES];
  return scopes.includes(need) ? null : need;
}

/**
 * publish_refused (0042 api_request_publish): no target took a request, and
 * `errors` says why per target. Without these lines a duplicate reads exactly
 * like a refusal, and an assistant that cannot tell them apart either gives up
 * on a post that is on its way or retries one that, once finished, it would
 * then post a second time.
 */
function publishRefusedText(errors: unknown): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const lines = errors.map((e) => {
    const row = (e && typeof e === "object" ? e : {}) as { account_id?: unknown; channel_id?: unknown; error?: unknown };
    const target = row.account_id != null ? `account ${String(row.account_id)}` : `YouTube channel ${String(row.channel_id ?? "?")}`;
    switch (row.error) {
      case "already_sending":
        return (
          `- ${target}: this video is already being sent there, so nothing new was recorded. Do not call publish_video ` +
          `for it again: once that post has finished, a new call would post the video a second time.`
        );
      case "forbidden":
        return (
          `- ${target}: this connection cannot publish there. It is not one of this workspace's publish targets, ` +
          `or the person who connected the app may not publish to it.`
        );
      default:
        return `- ${target}: refused (${String(row.error ?? "no reason given")}).`;
    }
  });
  return `No publish request was recorded for this video:\n${lines.join("\n")}`;
}

/**
 * The text a refused call comes back with. Only the customer's own numbers are
 * ever named, and every limit says who can lift it: top-ups and plans are the
 * person's to buy, a connection's monthly limit is the person's to raise —
 * never the assistant's, which has no tool for it.
 */
export function oauthRefusalText(result: Extract<ApiResult, { ok: false }>, origin: string, opts: { studio?: "create" | "other" } = {}): string {
  const d = result.details ?? {};
  // The same refusal reads for the thing that was asked: a video, or a Studio generation (0175).
  const what = opts.studio ? "generation" : "video";
  const studio = opts.studio ? studioRefusalText(result, origin, opts.studio === "create") : null;
  if (studio !== null) return studio;
  switch (result.code) {
    case "insufficient_credits": {
      const held = Number(d.held_credits ?? 0);
      return (
        `Not enough credits to start this ${what}. It needs ${credits(d.price_credits)} credits and the workspace has ${credits(d.available_credits)} available` +
        (held > 0 ? ` (${credits(held)} more are set aside for videos already in progress)` : "") +
        `. Nothing was started and nothing was charged.\n` +
        (d.extra_credits_off === true
          ? `Extra credits are turned off for this workspace, so credits bought as top-ups are not used for new ${what}s. ` +
            `The person can turn them on at ${origin}/usage, add credits at ${origin}/credits or choose a plan with more credits at ${origin}/pricing. `
          : `To continue, the person can add credits at ${origin}/credits or choose a plan with more credits at ${origin}/pricing. `) +
        `This connection keeps working afterwards: there is no need to connect the app again.`
      );
    }
    case "connection_limit_reached":
      return (
        `This connection has reached the monthly spending limit the person set for it (limit ${credits(d.limit_credits)} credits, ` +
        `${credits(d.spent_credits)} used this month, and this ${what} needs ${credits(d.price_credits)}). Nothing was started and nothing was charged.\n` +
        `Only the person can raise it: Developers → Connected apps at ${origin}/developers. You cannot change it. ` +
        `Reading videos and jobs still works.`
      );
    case "run_limit_reached": {
      const limit = Number(d.run_limit ?? 0);
      const active = Number(d.active_runs ?? 0);
      return (
        `The plan runs ${limit > 0 ? `at most ${limit} ${plural(limit, "video", "videos")}` : "a limited number of videos"} at once` +
        (active > 0 ? ` and ${active} ${plural(active, "is", "are")} in progress` : "") +
        `. Nothing was started and nothing was charged.\n` +
        `Wait for one to finish and try again in about a minute (get_job_status shows progress), or the person can choose a plan that runs more at once at ${origin}/pricing.`
      );
    }
    case "subscription_required":
      // Since 0147 every plan may connect and no database function answers this. It is still what a database without
      // 0147 (or after its rollback) answers, so it says what that database decided, the plan, without naming plans
      // the owner may rename, and the way back.
      return (
        `Connecting AI apps is not included in this workspace's current plan, so this connection is paused. ` +
        `The person can see the plans at ${origin}/pricing. As soon as the workspace's plan includes it, this same connection works again, with no need to connect the app again.`
      );
    case "invalid_api_key":
    case "invalid_token":
      return "This connection is no longer valid (it was disconnected or has expired). The person needs to connect the app to Nightshift again.";
    case "workspace_access_lost":
      return "The person who connected this app no longer has access to its workspace. They need to connect the app again.";
    case "insufficient_scope": {
      const need = String(d.required_scope ?? "that permission");
      return (
        `This connection was not given the "${need}" permission. The person can disconnect it in Developers → Connected apps ` +
        `at ${origin}/developers and connect it again, allowing that permission.`
      );
    }
    case "publish_refused":
      return publishRefusedText(d.errors) ?? `${result.message} (${result.code})`;
    case "rate_limit_exceeded":
      return `Too many requests in a short time. Wait ${Math.max(1, Math.ceil(result.retryAfter ?? 30))} seconds and try again.`;
    case "pricing_unavailable":
      return "Video prices are not available right now, so nothing was started or charged. Try again later.";
    case "not_available_for_connected_apps":
      return "This action is not available to connected apps.";
    case "internal_error":
    case "upstream_error":
    case "api_unavailable":
      return "Nightshift could not complete this just now. Nothing was started or charged. Try again in a moment.";
    default:
      return `${result.message} (${result.code})`;
  }
}

/**
 * The Studio tools' own refusals (0175), or null for one that reads the same as a video's (credits, the connection's limit, the
 * plan's runs, permissions). Each names the next step (CLAUDE.md #6): a model that is not offered here is not a model that needs a
 * confirmation in the Studio, and neither is a price that moved.
 */
function studioRefusalText(result: Extract<ApiResult, { ok: false }>, origin: string, creating: boolean): string | null {
  const d = result.details ?? {};
  const model = typeof d.model === "string" ? d.model : "That model";
  switch (result.code) {
    case "model_not_offered":
    case "model_not_sellable":
      return (
        `${model === "That model" ? model : `The model ${model}`} is not offered to connected apps for this, so nothing was quoted or charged. ` +
        `A model is offered here only once its terms allow it. Call list_creative_models and pick one it lists, or the person can use ` +
        `this model in the Studio at ${origin}/studio.`
      );
    case "acknowledgement_required":
      return (
        `${model === "That model" ? model : `The model ${model}`} needs the person to confirm, in the Studio, that they have the rights to what they put in ` +
        `(for example a photo of a person). A connected app cannot give that confirmation for them. Nothing was quoted or charged. ` +
        `The person can make this generation in the Studio at ${origin}/studio, or you can pick another model from list_creative_models.`
      );
    case "model_temporarily_off":
      return "That model is switched off for now. Nothing was quoted or charged. Pick another model from list_creative_models, or try again later.";
    case "price_changed":
      return (
        `The price changed since the quote${d.price_credits != null ? ` (it was ${credits(d.quoted_credits)} credits and is now ${credits(d.price_credits)})` : ""}. ` +
        "Nothing was started and nothing was charged. Call quote_creative again, tell the person the new price, and create only if they agree."
      );
    case "quote_expired":
      return "That quote has expired. Nothing was started or charged. Call quote_creative again, tell the person the price, and create only if they agree.";
    case "quote_not_found":
      return "There is no quote with that id for this connection. Call quote_creative, tell the person the price, then create_creative with the quote_id it returns.";
    case "quote_used":
      return (
        `That quote already paid for a generation${typeof d.job_id === "string" ? ` (${d.job_id}; get_creative_job shows it)` : ""}. ` +
        "Nothing new was started. For another one, quote again and confirm the price with the person."
      );
    case "quote_required":
      return "create_creative needs the quote_id of a quote the person agreed to. Call quote_creative first.";
    case "idempotency_key_required":
    case "invalid_idempotency_key":
      return "Send a fresh idempotency_key (1-255 characters of A-Z a-z 0-9 _ : . -) with each new generation, and the same one only to retry it.";
    case "idempotency_key_reused":
      return "That idempotency_key was already used with a different quote. Nothing new was started. Use a fresh key for a new generation.";
    case "source_unavailable":
      return (
        "A file in the request is not in this workspace's media library (or it was deleted, or it cannot be used as a source). " +
        "Nothing was quoted or charged. Call list_media and use the asset_id of one of the workspace's own files as source_asset_id."
      );
    case "entitlement_required":
      return `That model needs a plan or a purchase this workspace does not have. Nothing was quoted or charged. The person can see the plans at ${origin}/pricing, or pick another model from list_creative_models.`;
    case "unpriced":
      return "That model or setting has no price yet, so it cannot be sold. Nothing was quoted or charged. Pick another model or setting from list_creative_models.";
    case "invalid_params":
    case "capability_not_supported":
      return `${result.message}${typeof d.detail === "string" ? ` (${d.detail})` : ""} Nothing was quoted or charged. list_creative_models names what each model takes.`;
    case "job_not_found":
      return "There is no generation with that id for this connection. Only generations this connection started can be read here.";
    case "rate_limit_exceeded":
      return `Too many quotes or generations in a short time. Wait ${Math.max(1, Math.ceil(result.retryAfter ?? 30))} seconds and try again.`;
    case "forbidden":
      return "This workspace's generations cannot be started by a connected app. Nothing was started or charged.";
    case "upstream_error":
    case "internal_error":
      if (!creating) return null;
      return (
        "Nightshift could not complete this just now. Whether a generation started is not known: call create_creative again with the " +
        "SAME quote_id and idempotency_key (it starts at most once), never a new key."
      );
    default:
      return null;
  }
}
