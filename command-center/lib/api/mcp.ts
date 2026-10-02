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
import { IMAGE_PROVIDERS, VIDEO_PROVIDERS } from "@/lib/runBackend";
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
import { toWire, type ApiResult } from "@/lib/api/http";

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

export function buildMcpServer(caller: ApiCaller): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions:
      "Nightshift makes faceless YouTube videos. Start with list_channels, then create_video (it costs money from the " +
      "organization's prepaid API balance, priced per minute of requested length with a minimum per video, from " +
      "the live price list at /docs/api#pricing — say so before calling it). Poll get_job_status until the job succeeds, then list_videos to find the video. publish_video " +
      "cross-posts a finished video that passed review; YouTube uploads are private.",
  });
  const done = (r: ApiResult) => toToolResult(r, caller.requestId);

  server.registerTool(
    "list_channels",
    {
      title: "List channels",
      description: "The organization's channels. Use a channel's id with create_video; only active channels can make videos.",
      annotations: { readOnlyHint: true },
    },
    async () => done(await listChannels(caller)),
  );

  server.registerTool(
    "create_video",
    {
      title: "Create a video",
      description:
        "Queue a new video on a channel. Charges the prepaid API balance: the price for the requested length is held now, " +
        "charged when the job succeeds and released if it fails. Returns a job_id for get_job_status. The video is " +
        "rendered private; the channel's own publish rules and review apply.",
      inputSchema: {
        channel_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).describe("A channel id from list_channels."),
        topic: z.string().max(300).optional().describe("What the video is about. Omit to let the channel's AI pick."),
        niche: z.string().max(120).optional(),
        duration: z.number().int().min(30).max(3600).optional().describe("Length in seconds; defaults to the channel's target. The price is based on it."),
        language: z.string().max(40).optional(),
        visual_style: z.string().max(300).optional(),
        video_provider: z.enum(VIDEO_PROVIDERS).optional(),
        image_provider: z.enum(IMAGE_PROVIDERS).optional(),
        idempotency_key: idempotency,
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ idempotency_key, ...body }) => done(await createVideo(caller, body, idempotency_key ?? null)),
  );

  server.registerTool(
    "get_job_status",
    {
      title: "Get job status",
      description: "A video job's status (queued, running, succeeded, failed, cancelled), its error if any, and what it was charged.",
      inputSchema: { job_id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    async ({ job_id }) => done(await getJob(caller, String(job_id))),
  );

  server.registerTool(
    "list_videos",
    {
      title: "List videos",
      description: "The organization's videos, newest first, optionally for one channel.",
      inputSchema: {
        channel_id: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).max(10000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => done(await listVideos(caller, args)),
  );

  server.registerTool(
    "get_video",
    {
      title: "Get a video",
      description: "One video: title, state, review and publish state, YouTube link when uploaded, and its publish requests.",
      inputSchema: { video_id: z.string().min(1).max(128) },
      annotations: { readOnlyHint: true },
    },
    async ({ video_id }) => done(await getVideo(caller, video_id)),
  );

  server.registerTool(
    "list_connected_accounts",
    {
      title: "List publish targets",
      description: "Where a video can be cross-posted: the organization's YouTube channels (channel_id) and connected Instagram / TikTok accounts (account_id).",
      annotations: { readOnlyHint: true },
    },
    async () => done(await listAccounts(caller)),
  );

  server.registerTool(
    "publish_video",
    {
      title: "Publish a video to platforms",
      description:
        "Cross-post a finished video to connected accounts and/or other YouTube channels of the organization. Free. The same " +
        "checks as the website apply: a video that has not passed the publish gate and its approvals is refused with a " +
        "reason. YouTube uploads are always private.",
      inputSchema: {
        video_id: z.string().min(1).max(128),
        account_ids: z.array(z.string().uuid()).max(10).optional().describe("Instagram / TikTok account ids from list_connected_accounts."),
        channel_ids: z.array(z.string()).max(10).optional().describe("YouTube channel ids from list_connected_accounts."),
        idempotency_key: idempotency,
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ video_id, idempotency_key, ...targets }) =>
      done(await publishVideo(caller, video_id, targets, idempotency_key ?? null)),
  );

  server.registerTool(
    "request_download",
    {
      title: "Order an HD download",
      description:
        "Prepare a 720p or 1080p MP4 of a video. Charged from the API balance (the site's download price in credits x 1.5 cents) " +
        "when the file is ready; free again for 7 days. Poll get_download for the file URL.",
      inputSchema: { video_id: z.string().min(1).max(128), quality: z.enum(["720p", "1080p"]), idempotency_key: idempotency },
      annotations: { destructiveHint: false },
    },
    async ({ video_id, quality, idempotency_key }) =>
      done(await requestDownload(caller, video_id, { quality }, idempotency_key ?? null)),
  );

  server.registerTool(
    "get_download",
    {
      title: "Get a download",
      description: "An HD download's status; when ready, file_url (fetch it with the same API key as a Bearer header).",
      inputSchema: { download_id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    async ({ download_id }) => done(await getDownload(caller, String(download_id))),
  );

  server.registerTool(
    "get_balance",
    {
      title: "Get API balance",
      description: "The prepaid API balance in US cents (available and on hold), this month's spend and limit, and the usage tier.",
      annotations: { readOnlyHint: true },
    },
    async () => done(await getBalance(caller)),
  );

  return server;
}
