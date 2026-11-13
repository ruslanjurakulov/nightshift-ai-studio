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
  createVideo,
  getBalance,
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

const idempotency = z
  .string()
  .regex(/^[A-Za-z0-9_:.-]{1,255}$/)
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
] as const;

/** An AI app connected with OAuth (migration 0093): what it was allowed, and where its links point. */
export interface OauthMode {
  scopes: readonly string[];
  origin: string;
}

const KEY_INSTRUCTIONS =
  "Nightshift makes faceless YouTube videos. Start with list_channels, then create_video (it costs money from the " +
  "organization's prepaid API balance, priced per minute of requested length with a minimum per video, from " +
  "the live price list at /docs/api#pricing — say so before calling it). Poll get_job_status until the job succeeds, then list_videos to find the video. publish_video " +
  "cross-posts a finished video that passed review; YouTube uploads are private.";

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
        ? "The organization's channels. Use a channel's id with create_video; only active channels can make videos."
        : "The organization's channels, each with whether it is active.",
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
      description: "The organization's videos, newest first, optionally for one channel.",
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
      description: "Where a video can be cross-posted: the organization's YouTube channels (channel_id) and connected Instagram / TikTok accounts (account_id).",
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
