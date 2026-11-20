/**
 * The MCP server (Streamable HTTP, stateless) — a thin layer over the public
 * API's operations (lib/api/operations.ts). Every tool calls exactly one
 * operation with the caller's key, so an MCP tool call is one API request:
 * same key, same activation, tier, rate limit, balance, holds and database
 * checks as REST. Nothing here decides anything on its own.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  API_CREATIVE_CAPABILITIES,
  IDEMPOTENCY_KEY_RE,
  createCreative,
  createVideo,
  getBalance,
  getCreativeJobFiles,
  listCreativeModels,
  quoteCreative,
  getDownload,
  getJob,
  getVideo,
  listAccounts,
  listChannels,
  listVideos,
  publishVideo,
  requestDownload,
  type ApiCaller,
} from "@/lib/api/operations";
import { apiError, toWire, type ApiResult } from "@/lib/api/http";
import { MODEL_ID_RE } from "@/lib/models-admin";
import { missingScope, OAUTH_TOOL_SCOPES, oauthRefusalText } from "@/lib/api/mcp-oauth";

export const MCP_SERVER_INFO = { name: "nightshift", version: "1.0.0" } as const;

/** An operation's result as a tool result: the JSON the REST API would send,
 *  flagged as an error when it is one (the model then sees code + message). */
export function toToolResult(result: ApiResult, requestId: string): CallToolResult {
  const wire = toWire(result, requestId);
  const text = JSON.stringify(wire.body, null, 2);
  if (!result.ok) return { isError: true, content: [{ type: "text", text }] };
  return { content: [{ type: "text", text }] };
}

/** What `youtube_connected` means, for the assistant: "unknown" must not be read as ready. */
const YOUTUBE_CONNECTED_NOTE =
  "youtube_connected is true, false or \"unknown\": unknown means a connection exists but nothing has confirmed Google still " +
  "accepts it (youtube_checked_at says when it last was). If a job fails with error_code channel_reconnect_required, the person " +
  "reconnects YouTube for that channel on the Channels page.";

const idempotency = z
  .string()
  .regex(IDEMPOTENCY_KEY_RE)
  .optional()
  .describe("Optional. Reuse the same value when retrying so the action happens once (24 hours).");

/** The tools, in the order a client lists them. */
export const TOOL_NAMES = [
  "list_channels",
  "create_video",
  "get_job_status",
  "list_videos",
  "get_video",
  "list_connected_accounts",
  "publish_video",
  "request_download",
  "get_download",
  "get_balance",
  // The Studio's generations (0062's creative API, 0162's list and files): API keys only, never a connected app.
  "list_models",
  "quote_generation",
  "create_generation",
  "get_generation",
] as const;

/** The Studio tools: offered to an API key with the creative scopes, never over OAuth (lib/api/mcp-oauth.ts does not list them). */
export const STUDIO_TOOL_NAMES = ["list_models", "quote_generation", "create_generation", "get_generation"] as const;

/** An AI app connected with OAuth (migration 0093): what it was allowed, and where its links point. */
export interface OauthMode {
  scopes: readonly string[];
  origin: string;
}

const KEY_INSTRUCTIONS =
  "Nightshift makes faceless YouTube videos. Start with list_channels, then create_video (it costs money from the " +
  "organization's prepaid API balance, priced per minute of requested length with a minimum per video, from " +
  "the live price list at /docs/api#pricing — say so before calling it). Poll get_job_status until the job succeeds, then list_videos to find the video. publish_video " +
  "cross-posts a finished video that passed review; YouTube uploads are private. " +
  "For a single picture, clip or voice-over from the Studio's models: list_models, then quote_generation (free), tell the person " +
  "the price in credits, and only then create_generation with that price as max_credits and a fresh idempotency_key. Generations " +
  "are paid in the organization's CREDITS, not the API balance; poll get_generation until it is completed for its file links.";

/**
 * The instructions of a connection, from the tools its grant is offered. One
 * fixed text told a create-only connection to "start with list_channels" and
 * "poll get_job_status", tools it does not have; an assistant that cannot find
 * them tells the person the server is broken. So every tool named here is one
 * this grant is offered, and what the grant lacks is said as a permission the
 * person can give.
 */
function oauthInstructions(has: (tool: string) => boolean): string {
  const s = ["Nightshift makes faceless YouTube videos."];
  if (has("list_channels")) s.push(has("create_video") ? "Start with list_channels, then create_video." : "Start with list_channels.");
  if (has("create_video")) {
    s.push(
      "A video costs CREDITS from the person's Nightshift workspace, priced per minute of requested length with a minimum per " +
        "video, and this connection has its own monthly spending limit" +
        (has("get_balance") ? ": call get_balance first to see the credits available and what is left of the limit." : "."),
      "Tell the person the price and the length before you create a video, and pass a fresh idempotency_key so that a retry " +
        "can never create a second video.",
    );
    if (!has("list_channels")) s.push("Ask the person for the channel id.");
  }
  if (has("get_job_status")) s.push(has("list_videos") ? "Poll get_job_status until a job succeeds, then list_videos to find the video." : "Poll get_job_status until a job succeeds.");
  else if (has("list_videos")) s.push("list_videos and get_video show the workspace's videos.");
  if (has("publish_video"))
    s.push(
      "publish_video sends a finished video that passed review to connected accounts" +
        (has("list_connected_accounts") ? " (list_connected_accounts names them)" : "") +
        "; YouTube uploads are private. It takes no idempotency key: never repeat a publish that went through.",
    );
  const cannot = [
    ...(has("list_channels") ? [] : ["read the workspace's channels, videos and jobs"]),
    ...(has("create_video") ? [] : ["create videos"]),
    ...(has("publish_video") ? [] : ["publish videos"]),
  ];
  if (cannot.length)
    s.push(`This connection was not given permission to ${cannot.join(" or to ")}; the person can disconnect it and connect it again, allowing that.`);
  s.push(
    "If a call is refused, the message says what is missing and what the person can do (add credits, choose a plan, raise " +
      "this connection's limit); you cannot change any of those yourself.",
  );
  return s.join(" ");
}

/**
 * What to do about a Studio tool's refusal, by its code (CLAUDE.md #6: name the remedy, not the symptom). The refusals that need
 * opposite answers are kept apart: no credits (the person tops up) is not a model that is not offered (pick another from
 * list_models), and neither is a setting the model does not take (change the request). Only words the caller can act on; the
 * database's own code and message stay as they are.
 */
export const STUDIO_REMEDIES: Readonly<Record<string, string>> = {
  insufficient_credits: "The organization does not have enough credits. The person can add credits or choose a plan in the app (Credits); nothing was held.",
  key_credit_limit_reached: "This API key's own monthly credit limit is reached. An owner or admin can raise it in the Developer console; nothing was held.",
  price_changed: "The price is now above max_credits. Call quote_generation again, tell the person the new price, and create with it only if they agree.",
  route_changed: "The automatic model choice changed. Call quote_generation again and confirm the new choice with the person.",
  model_not_sellable: "That model is not offered to this organization through the API. Call list_models and pick one it lists.",
  entitlement_required: "That model needs a purchase or a plan this organization does not have. Pick another model from list_models.",
  unpriced: "That model, or that setting of it, has no price yet, so it cannot be sold. Pick another model or setting from list_models.",
  model_temporarily_off: "That model is switched off for now. Pick another model from list_models, or try again later.",
  no_model_available: "No model can make this right now. Try again later, or change the request.",
  capability_not_supported: "That capability cannot be generated here. Call list_models to see what can.",
  invalid_params: "A setting is missing or not accepted by this model. Check list_models for what the model takes, then quote again.",
  max_credits_required: "Send max_credits: the price from quote_generation that the person agreed to.",
  idempotency_key_reused: "That idempotency_key was already used for a different generation. Use a fresh one for a new generation.",
  idempotency_in_progress:
    "The same generation is still being started. Call create_generation again in a few seconds with the SAME idempotency_key, never a new one.",
  insufficient_scope: "This API key lacks the permission for this tool. An owner or admin can create a key with the Studio permissions (creative) in the Developer console.",
  run_limit_reached: "All of the plan's parallel runs are busy. Wait a minute for one to finish, then try again.",
  api_not_activated: "The API is not activated for this organization. An owner or admin can activate it in the Developer console.",
};

/**
 * create_generation's own remedies, where its answer differs from a read's: when the database did not answer, whether a
 * generation was started is unknown, so the only safe retry is the same request with the same idempotency_key (it can never
 * start twice); a fresh key could pay twice.
 */
export const CREATE_REMEDIES: Readonly<Record<string, string>> = {
  upstream_error: "Whether it started is not known. Call create_generation again with the SAME idempotency_key, never a new one: it starts at most once.",
  internal_error: "Whether it started is not known. Call create_generation again with the SAME idempotency_key, never a new one: it starts at most once.",
};

/** A Studio tool's result: the API's answer, plus `remedy` on a refusal the caller can act on. */
function withRemedy(result: ApiResult, own: Readonly<Record<string, string>> = {}): ApiResult {
  if (result.ok) return result;
  const remedy = Object.hasOwn(own, result.code) ? own[result.code] : Object.hasOwn(STUDIO_REMEDIES, result.code) ? STUDIO_REMEDIES[result.code] : null;
  return remedy === null ? result : { ...result, details: { ...(result.details ?? {}), remedy } };
}

/** A log line's name for a thrown value: the class name when it is a plain identifier, never the message. */
function thrownName(e: unknown): string {
  // The class (constructor.name), not e.name: `name` is an ordinary writable property that any thrower can fill with
  // anything, message text included, while the constructor's name is the class that was thrown. Still allow-listed to a
  // plain identifier, and read defensively (a Proxy or a getter can throw on the way).
  let name: unknown;
  try {
    name = e !== null && typeof e === "object" ? (e as { constructor?: { name?: unknown } }).constructor?.name : typeof e;
  } catch {
    name = undefined;
  }
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name) ? name : "error";
}

export function buildMcpServer(caller: ApiCaller, oauth?: OauthMode): McpServer {
  // An OAuth caller gets only what its permissions allow; the two paid-download
  // tools (USD API balance, API-key file route) are for keys only.
  const offered = (tool: string): boolean =>
    !oauth || (Object.hasOwn(OAUTH_TOOL_SCOPES, tool) && missingScope(tool, oauth.scopes) === null);
  const server = new McpServer(MCP_SERVER_INFO, { instructions: oauth ? oauthInstructions(offered) : KEY_INSTRUCTIONS });
  const refusal = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });
  const done = oauth
    ? (r: ApiResult): CallToolResult => (r.ok ? toToolResult(r, caller.requestId) : refusal(oauthRefusalText(r, oauth.origin)))
    : (r: ApiResult) => toToolResult(r, caller.requestId);

  // A callback that throws (a dropped socket, a driver bug) would reach the
  // assistant as the exception's own message: the SDK turns a throw into a tool
  // result with error.message as its text, and that message can carry a host,
  // a port or a connection string. The route's own catch never sees it. So a
  // throw is answered here with the generic text and the request id, and only
  // the error's class name is logged. It is not known whether the call took
  // effect before the throw, so the text does not say that nothing happened.
  const thrown = (tool: string, e: unknown): CallToolResult => {
    console.error(`[mcp] ${caller.requestId} tool ${tool} threw ${thrownName(e)}`);
    if (oauth)
      return refusal(
        `Nightshift could not complete this request (request id ${caller.requestId}). Whether it took effect is not known: ` +
          "check before repeating a call that creates or publishes something.",
      );
    const sentence =
      "The MCP endpoint could not complete this request. Whether it took effect is not known: check before repeating a call " +
      "that creates, publishes or orders something.";
    return toToolResult(apiError(500, "internal_error", sentence), caller.requestId);
  };
  const register: McpServer["registerTool"] = (name, config, cb) => {
    if (!offered(name)) return undefined as never;
    const run = cb as unknown as (...a: unknown[]) => CallToolResult | Promise<CallToolResult>;
    const guarded = async (...a: unknown[]): Promise<CallToolResult> => {
      try {
        return await run(...a);
      } catch (e) {
        return thrown(name, e);
      }
    };
    return server.registerTool(name, config, guarded as unknown as typeof cb);
  };

  // A tool this grant lacks is not listed, but a call to it is answered with
  // the permission it needs and how the person gives it, instead of the SDK's
  // "Tool create_video not found", which reads as a broken server. The SDK has
  // no hook for an unregistered tool's call, so the tools/call handler it
  // installs (on the first registerTool below) is wrapped as it is installed;
  // everything else, and every granted tool, goes to the SDK unchanged.
  // Checked against @modelcontextprotocol/sdk 1.32.0 (package-lock.json): McpServer.registerTool calls
  // setToolRequestHandlers(), which installs the tools/call handler once, through this.server.setRequestHandler
  // (dist/esm/server/mcp.js). A later SDK that installs it some other way would bypass this wrapper silently, so
  // re-check this on every SDK upgrade; tests/mcp-assistant-session.test.ts ("a tool the grant lacks") fails if it does.
  if (oauth) {
    const low = server.server;
    const install = low.setRequestHandler.bind(low) as (schema: unknown, handler: (req: unknown, extra: unknown) => unknown) => void;
    (low as unknown as { setRequestHandler: typeof install }).setRequestHandler = (schema, handler) =>
      install(schema, async (req, extra) => {
        const r = req as { method?: unknown; params?: { name?: unknown } };
        const need = r.method === "tools/call" && typeof r.params?.name === "string" ? missingScope(r.params.name, oauth.scopes) : null;
        if (need)
          return refusal(oauthRefusalText({ ok: false, status: 403, code: "insufficient_scope", message: "", details: { required_scope: need } }, oauth.origin));
        return handler(req, extra);
      });
  }

  register(
    "list_channels",
    {
      title: "List channels",
      description: offered("create_video")
        ? "The organization's channels. Use a channel's id with create_video; only active channels can make videos. " +
          YOUTUBE_CONNECTED_NOTE
        : "The organization's channels, each with whether it is active. " + YOUTUBE_CONNECTED_NOTE,
      // youtube_connected is true | false | "unknown" (lib/api/operations.ts honestYoutubeConnected): an assistant that read
      // `true` from a token row told the person the channel was ready while Google had revoked it.
      annotations: { readOnlyHint: true },
    },
    async () => done(await listChannels(caller)),
  );

  register(
    "create_video",
    {
      title: "Create a video",
      description: oauth
        ? "Queue a new video on a channel. It costs credits from the person's workspace: the price for the requested length " +
          "is set aside now, charged when the job succeeds and returned if it fails, and it can never take this connection past " +
          `its monthly spending limit. Returns a job_id${offered("get_job_status") ? " for get_job_status" : ""} and the price in credits. ` +
          "The video is rendered private; the channel's own publish rules and review apply."
        : "Queue a new video on a channel. Charges the prepaid API balance: the price for the requested length is held now, " +
          "charged when the job succeeds and released if it fails. Returns a job_id for get_job_status. The video is " +
          "rendered private; the channel's own publish rules and review apply.",
      // strict: a field this tool does not offer (video_provider, image_provider: the platform chooses
      // the providers) is refused, never silently dropped.
      inputSchema: z.object({
        channel_id: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
          .describe(offered("list_channels") ? "A channel id from list_channels." : "A channel id (ask the person for it)."),
        topic: z.string().max(300).optional().describe("What the video is about. Omit to let the channel's AI pick."),
        niche: z.string().max(120).optional(),
        duration: z.number().int().min(30).max(3600).optional().describe("Length in seconds; defaults to the channel's target. The price is based on it."),
        language: z.string().max(40).optional(),
        visual_style: z.string().max(300).optional(),
        idempotency_key: idempotency,
      }).strict(),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ idempotency_key, ...body }) => done(await createVideo(caller, body, idempotency_key ?? null)),
  );

  register(
    "get_job_status",
    {
      title: "Get job status",
      description: oauth
        ? "A video job's status (queued, running, succeeded, failed, cancelled), a plain error sentence with a stable error_code if it failed, and the credits it holds or was charged."
        : "A video job's status (queued, running, succeeded, failed, cancelled), a plain error sentence with a stable error_code if it failed, and what it was charged.",
      // strict, like every tool with arguments: a misspelt argument is refused
      // and named, never silently dropped (list_videos({ channel }) used to list
      // every channel's videos as if no filter had been asked for).
      inputSchema: z.object({ job_id: z.number().int().positive() }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ job_id }) => done(await getJob(caller, String(job_id))),
  );

  register(
    "list_videos",
    {
      title: "List videos",
      description: "The organization's videos, optionally for one channel: newest upload first (private uploads included); runs that were held for review and never uploaded come last, in id order, not by age. A job's status does not name its video yet, so match a new video by its topic or title.",
      inputSchema: z
        .object({
          channel_id: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          offset: z.number().int().min(0).max(10000).optional(),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async (args) => done(await listVideos(caller, args)),
  );

  register(
    "get_video",
    {
      title: "Get a video",
      description: "One video: title, state, review and publish state, YouTube link when uploaded, and its publish requests.",
      inputSchema: z.object({ video_id: z.string().min(1).max(128) }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ video_id }) => done(await getVideo(caller, video_id)),
  );

  register(
    "list_connected_accounts",
    {
      title: "List publish targets",
      description:
        "Where a video can be cross-posted: the organization's YouTube channels (channel_id) and connected Instagram / TikTok accounts (account_id). " +
        "A YouTube entry's connected is true, false or \"unknown\" (a connection exists but nothing has confirmed Google still accepts it), with checked_at.",
      annotations: { readOnlyHint: true },
    },
    async () => done(await listAccounts(caller)),
  );

  register(
    "publish_video",
    {
      title: "Publish a video to platforms",
      description:
        "Cross-post a finished video to connected accounts and/or other YouTube channels of the organization. Free. The same " +
        "checks as the website apply: a video that has not passed the publish gate and its approvals is refused with a " +
        "reason. YouTube uploads are always private." +
        (oauth
          ? " A connected app has no idempotency key here: while a post to a target is still being sent, calling again for it " +
            "is refused as already being sent, but once that post has finished a new call posts the video again" +
            (offered("get_video") ? ", so check get_video's publish requests before repeating one." : ", so never repeat one that went through.")
          : ""),
      // The OAuth door has no idempotency_key at all: the database's idempotency
      // record is keyed by API key, so oauthRpc drops the key, and a schema that
      // offered it ("so the action happens once") told an assistant that
      // retrying a finished post with the same key was safe, when it posts
      // twice. Strict, so a client that still sends one is told the field does
      // not exist.
      inputSchema: oauth ? z.object(publishTargets(offered)).strict() : z.object({ ...publishTargets(offered), idempotency_key: idempotency }).strict(),
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const { video_id, account_ids, channel_ids } = args;
      // Only the API-key schema has the field; on the OAuth door it is always absent.
      const key = (args as { idempotency_key?: string }).idempotency_key;
      const targets = { ...(account_ids !== undefined ? { account_ids } : {}), ...(channel_ids !== undefined ? { channel_ids } : {}) };
      return done(await publishVideo(caller, video_id, targets, key ?? null));
    },
  );

  register(
    "request_download",
    {
      title: "Order an HD download",
      description:
        // No rate here: it is the api_prices row download_cents_per_credit, which
        // the operator can change, and a number in this text would then be a
        // price the backend does not charge. The answer carries the real one.
        "Prepare a 720p or 1080p MP4 of a video. Charged from the API balance when the file is ready, at the price this " +
        "call's answer names (price_cents, computed from the live price list); free again for 7 days. Poll get_download for the file URL.",
      inputSchema: z
        .object({ video_id: z.string().min(1).max(128), quality: z.enum(["720p", "1080p"]), idempotency_key: idempotency })
        .strict(),
      annotations: { destructiveHint: false },
    },
    async ({ video_id, quality, idempotency_key }) =>
      done(await requestDownload(caller, video_id, { quality }, idempotency_key ?? null)),
  );

  register(
    "get_download",
    {
      title: "Get a download",
      description: "An HD download's status; when ready, file_url (fetch it with the same API key as a Bearer header).",
      inputSchema: z.object({ download_id: z.number().int().positive() }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ download_id }) => done(await getDownload(caller, String(download_id))),
  );

  register(
    "get_balance",
    {
      // The OAuth door pays in site credits and never sees the USD API balance;
      // clients show the title in the tool picker and the approval prompt.
      title: oauth ? "Get credit balance" : "Get API balance",
      description: oauth
        ? "The workspace's credits (available and set aside for videos in progress), its plan, how many videos run at once, " +
          "and this connection's monthly spending limit with what is used and what is left."
        : "The prepaid API balance in US cents (available and on hold), this month's spend and limit, and the usage tier.",
      annotations: { readOnlyHint: true },
    },
    async () => done(await getBalance(caller)),
  );

  // ── The Studio's generations (API keys only) ─────────────────────────────
  // Each is one call to an existing database door: 0162's model list and files, 0062's quote and create. The price, the hold, the
  // capture and the refund stay in those functions (create_creative_job); nothing here computes or moves a credit. A connected app
  // is never offered them: they are not in OAUTH_TOOL_SCOPES, so `offered` is false and `register` skips them.
  const capability = z.enum(API_CREATIVE_CAPABILITIES).describe("What to make: t2i (a picture from words), edit, t2v (a clip from words), i2v (a clip from a picture), tts, sfx, and so on.");
  const generation = {
    capability,
    model: z.string().regex(MODEL_ID_RE).describe("A model id from list_models."),
    params: z
      .record(z.string(), z.unknown())
      .describe("The model's settings, e.g. { \"prompt\": \"…\", \"aspect_ratio\": \"16:9\", \"duration_s\": 5 }. list_models names what each model takes."),
  };

  register(
    "list_models",
    {
      title: "List Studio models",
      description:
        "The models this organization can generate with right now, each with what it makes and the shapes, durations and " +
        "resolutions it takes. No prices: quote_generation gives the price of one exact request.",
      inputSchema: z.object({ capability: capability.optional() }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ capability: cap }) => done(withRemedy(await listCreativeModels(caller, cap ?? null))),
  );

  register(
    "quote_generation",
    {
      title: "Quote a generation",
      description:
        "The price in credits of one picture, clip or voice-over with these exact settings. Free: nothing is held or charged. " +
        "Tell the person this price before calling create_generation.",
      inputSchema: z.object(generation).strict(),
      annotations: { readOnlyHint: true },
    },
    async (body) => done(withRemedy(await quoteCreative(caller, body))),
  );

  register(
    "create_generation",
    {
      title: "Create a generation",
      description:
        "Start one picture, clip or voice-over. It costs CREDITS from the organization (not the API balance): the price is set " +
        "aside now, charged when it succeeds and returned if it fails. max_credits is the most the person agreed to pay (use the " +
        "quote): a higher price is refused, never charged, and the key's own monthly credit limit also applies. idempotency_key " +
        "is required: send the same one on a retry so it can never start twice. Returns the generation's id for get_generation.",
      inputSchema: z
        .object({
          ...generation,
          max_credits: z.number().min(0).describe("The most credits the person agreed to pay for this generation: the quoted price."),
          idempotency_key: z.string().regex(IDEMPOTENCY_KEY_RE).describe("Required. A fresh value per generation; reuse it only to retry the same one."),
        })
        .strict(),
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ idempotency_key, ...body }) => done(withRemedy(await createCreative(caller, body, idempotency_key), CREATE_REMEDIES)),
  );

  register(
    "get_generation",
    {
      title: "Get a generation",
      description:
        "A generation this key started: its status (queued, running, completed, failed), what was held and charged, and once it " +
        "completed a link to each file: a path on this server (prefix it with the origin of the MCP address you connected to), which expires after a few minutes (ask again for a fresh one).",
      inputSchema: z.object({ generation_id: z.string().uuid() }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ generation_id }) => done(withRemedy(await getCreativeJobFiles(caller, generation_id))),
  );

  return server;
}

/** publish_video's targets; where their ids come from is named only when that tool is offered. */
function publishTargets(offered: (tool: string) => boolean) {
  const from = offered("list_connected_accounts") ? " from list_connected_accounts" : "";
  return {
    video_id: z.string().min(1).max(128),
    account_ids: z.array(z.string().uuid()).max(10).optional().describe(`Instagram / TikTok account ids${from}.`),
    channel_ids: z.array(z.string()).max(10).optional().describe(`YouTube channel ids${from}.`),
  };
}
