import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CliError, EXIT, usageError } from "../errors.js";
import { chargeLine, parseDuration, rows, show, usd } from "../format.js";
import { pollUntil } from "../poll.js";
import { IDEMPOTENCY_OPTION, WAIT_OPTIONS, afterCreated, getClient, idempotencyKeyFor, intOption } from "./shared.js";

const JOB_DONE = new Set(["succeeded", "failed", "cancelled"]);
const DOWNLOAD_DONE = new Set(["ready", "failed", "expired"]);
const VIDEO_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const NUMERIC_ID_RE = /^[1-9]\d{0,14}$/;

function waitSeconds(ctx) {
  return intOption(ctx, "timeout", { min: 1, max: 86400 }) ?? 1800;
}

function numericId(raw, what) {
  if (!NUMERIC_ID_RE.test(raw)) throw usageError(`${what} must be the whole number the API returned.`);
  return raw;
}

function videoId(raw) {
  if (!VIDEO_ID_RE.test(raw)) throw usageError("The video id may only contain letters, digits . _ -");
  return raw;
}

function jobLines(j) {
  return rows([
    ["Job", show(j?.id)],
    ["Channel", show(j?.channel_id)],
    ["Status", show(j?.status)],
    ["Charge", chargeLine(j?.charge)],
    ...(j?.error ? [["Error", j.error]] : []),
    ["Created", show(j?.created_at)],
    ["Finished", show(j?.finished_at, "not yet")],
  ]);
}

/** Poll a video job to a final state. Failed and cancelled jobs exit 1. */
async function waitForJob(ctx, client, id) {
  let last = null;
  const job = await pollUntil({
    fetchOnce: async () => (await client.request("GET", `/jobs/${id}`)).body,
    isDone: (j) => JOB_DONE.has(j?.status),
    onUpdate: (j) => {
      if (j?.status !== last) {
        last = j?.status;
        ctx.note(`job ${id}: ${show(j?.status)}\n`);
      }
    },
    io: ctx.io,
    timeoutSeconds: waitSeconds(ctx),
    what: `job ${id}`,
  });
  return job;
}

function setExitFor(ctx, job) {
  if (job?.status !== "succeeded") ctx.exitCode = EXIT.ERROR;
}

export const videoCommands = [
  {
    path: "create",
    summary: "Make a video. Money is HELD now, charged only if the job succeeds.",
    usage: "nightshift create --channel ID [--topic TEXT] [--duration 90s] [--wait] [--json]",
    options: {
      channel: { type: "string", arg: "ID", help: "Channel id (required; see `nightshift channels`)." },
      topic: { type: "string", arg: "TEXT", help: "What the video is about (max 300). Omit to let the channel's AI pick." },
      niche: { type: "string", arg: "TEXT", help: "Niche (max 120)." },
      duration: { type: "string", arg: "LENGTH", help: "Length: seconds (90), 90s, 2m, 1m30s. 30s to 1h. The price is based on it. Default: the channel's target." },
      language: { type: "string", arg: "TEXT", help: "Language (max 40)." },
      "visual-style": { type: "string", arg: "TEXT", help: "Visual style (max 300)." },
      "video-provider": { type: "string", arg: "ID", help: "A video provider this deployment supports (else 400 invalid_params)." },
      "image-provider": { type: "string", arg: "ID", help: "An image provider this deployment supports (else 400 invalid_params)." },
      ...IDEMPOTENCY_OPTION,
      ...WAIT_OPTIONS,
    },
    positionals: { names: [], min: 0, max: 0 },
    examples: [
      'nightshift create --channel my-channel --topic "How tides work" --duration 90s',
      'nightshift create --channel my-channel --topic "How tides work" --duration 2m --wait',
      "# Retry after a network error WITHOUT paying twice (use the key printed by the first attempt):",
      "nightshift create --channel my-channel --topic ... --duration 90s --idempotency-key cli-...",
    ],
    notes: [
      "The price is not chosen by you and has no ceiling flag: the API holds the live price for the requested length and reports it (price_cents). It is printed here.",
      "The video is private; the channel's own publish rules and review apply. Nothing here publishes.",
      "A job is not linked to the video it made; after success, find it with `nightshift videos list --channel ID`.",
    ],
    async run(ctx) {
      const v = ctx.values;
      if (!v.channel) throw usageError("--channel is required (see `nightshift channels`).");
      const body = { channel_id: v.channel };
      for (const [flag, field] of [["topic", "topic"], ["niche", "niche"], ["language", "language"], ["visual-style", "visual_style"], ["video-provider", "video_provider"], ["image-provider", "image_provider"]])
        if (v[flag] != null) body[field] = v[flag];
      if (v.duration != null) {
        const seconds = parseDuration(v.duration);
        if (seconds == null || seconds < 30 || seconds > 3600) throw usageError("--duration must be between 30 seconds and 1 hour, e.g. 90, 90s, 2m, 1m30s.");
        body.duration = seconds;
      }
      waitSeconds(ctx); // validates --timeout before anything is sent
      const { key, generated } = idempotencyKeyFor(ctx);
      const client = await getClient(ctx);
      if (generated) ctx.note(`Idempotency-Key: ${key}  (pass --idempotency-key ${key} to retry this exact request safely)\n`);
      const { body: created, replayed } = await client.request("POST", "/videos", { body, idempotencyKey: key });
      const id = created?.job_id;
      const held = `Held from your API balance: ${usd(created?.price_cents)} (charged only if the job succeeds; released in full if it fails).`;
      if (!v.wait) {
        ctx.result(created, () =>
          `${replayed ? "Replayed the earlier request (same Idempotency-Key): " : ""}Queued job ${show(id)} on channel ${show(created?.channel_id)}.\n${
            created?.price_cents == null ? "Held: the API did not report a price; check `nightshift balance`.\n" : held + "\n"
          }Follow it: nightshift jobs get ${show(id)} --wait\n`,
        );
        return;
      }
      ctx.note(`Queued job ${show(id)}. ${created?.price_cents == null ? "Price not reported." : held}\n`);
      const job = await afterCreated(waitForJob(ctx, client, numericId(String(id), "job id")), {
        text: `job ${id} was already queued and its price held; follow it with: nightshift jobs get ${id} --wait`,
        details: { created_job_id: id, price_cents: created?.price_cents ?? null },
      });
      setExitFor(ctx, job);
      ctx.result({ ...job, price_cents: created?.price_cents ?? null }, () =>
        `Job ${show(job.id)} ${show(job.status)}.\n${jobLines(job)}${
          job.status === "succeeded" ? `Find the video: nightshift videos list --channel ${show(job.channel_id)} --limit 5\n` : ""
        }`,
      );
    },
  },
  {
    path: "jobs get",
    summary: "Show a video job's status and what it was charged.",
    usage: "nightshift jobs get ID [--wait] [--json]",
    options: { ...WAIT_OPTIONS },
    positionals: { names: ["ID"], min: 1, max: 1 },
    examples: ["nightshift jobs get 123", "nightshift jobs get 123 --wait --timeout 3600"],
    async run(ctx) {
      const id = numericId(ctx.positionals[0], "ID");
      const client = await getClient(ctx);
      const job = ctx.values.wait ? await waitForJob(ctx, client, id) : (await client.request("GET", `/jobs/${id}`)).body;
      if (ctx.values.wait) setExitFor(ctx, job);
      ctx.result(job, () => jobLines(job));
    },
  },
  {
    path: "videos list",
    summary: "List videos, newest first.",
    usage: "nightshift videos list [--channel ID] [--limit N] [--offset N] [--json]",
    options: {
      channel: { type: "string", arg: "ID", help: "Only this channel." },
      limit: { type: "string", arg: "N", help: "1-100 (default 20)." },
      offset: { type: "string", arg: "N", help: "0-10000 (default 0)." },
    },
    positionals: { names: [], min: 0, max: 0 },
    examples: ["nightshift videos list", "nightshift videos list --channel my-channel --limit 5"],
    async run(ctx) {
      const limit = intOption(ctx, "limit", { min: 1, max: 100 });
      const offset = intOption(ctx, "offset", { min: 0, max: 10000 });
      const client = await getClient(ctx);
      const { body } = await client.request("GET", "/videos", { query: { channel_id: ctx.values.channel, limit, offset } });
      const list = Array.isArray(body?.videos) ? body.videos : [];
      ctx.result(body, () =>
        list.length === 0
          ? "No videos.\n"
          : list
              .map((x) => `${x.id}  ${show(x.channel_id)}  ${show(x.title, "(untitled)")}  review:${show(x.review_state, "unknown")}  publish:${show(x.publish_state, "unknown")}  privacy:${show(x.privacy, "unknown")}`)
              .join("\n") + "\n",
      );
    },
  },
  {
    path: "videos get",
    summary: "Show one video with its publish requests.",
    usage: "nightshift videos get VIDEO_ID [--json]",
    options: {},
    positionals: { names: ["VIDEO_ID"], min: 1, max: 1 },
    examples: ["nightshift videos get abc123"],
    async run(ctx) {
      const id = videoId(ctx.positionals[0]);
      const client = await getClient(ctx);
      const { body: x } = await client.request("GET", `/videos/${encodeURIComponent(id)}`);
      const reqs = Array.isArray(x?.publish_requests) ? x.publish_requests : [];
      ctx.result(x, () =>
        rows([
          ["Video", show(x?.id)],
          ["Channel", show(x?.channel_id)],
          ["Title", show(x?.title, "(untitled)")],
          ["Review", show(x?.review_state, "unknown")],
          ["Publish state", show(x?.publish_state, "unknown")],
          ["Privacy", show(x?.privacy, "unknown")],
          ["YouTube", show(x?.youtube_url, "not uploaded")],
        ]) +
        (reqs.length
          ? "Publish requests:\n" + reqs.map((r) => `  ${show(r.platform)} -> ${show(r.target_channel_id ?? r.account_id)}  ${show(r.status)}${r.reason ? `  (${r.reason})` : ""}${r.result_url ? `  ${r.result_url}` : ""}`).join("\n") + "\n"
          : ""),
      );
    },
  },
  {
    path: "download request",
    summary: "Order a 720p or 1080p MP4 of a video. Charged when the file is ready.",
    usage: "nightshift download request VIDEO_ID --quality 720p|1080p [--wait] [--json]",
    options: {
      quality: { type: "string", arg: "720p|1080p", help: "Required." },
      ...IDEMPOTENCY_OPTION,
      ...WAIT_OPTIONS,
    },
    positionals: { names: ["VIDEO_ID"], min: 1, max: 1 },
    examples: ["nightshift download request abc123 --quality 1080p --wait", "nightshift download request abc123 --quality 720p"],
    notes: ["The price is reported by the API (price_cents) and printed. Ordering the same video and quality again within 7 days is free."],
    async run(ctx) {
      const id = videoId(ctx.positionals[0]);
      const q = ctx.values.quality;
      if (q !== "720p" && q !== "1080p") throw usageError("--quality must be 720p or 1080p.");
      const { key, generated } = idempotencyKeyFor(ctx);
      const client = await getClient(ctx);
      if (generated) ctx.note(`Idempotency-Key: ${key}  (pass --idempotency-key ${key} to retry this exact request safely)\n`);
      const { body: d } = await client.request("POST", `/videos/${encodeURIComponent(id)}/downloads`, { body: { quality: q }, idempotencyKey: key });
      const price = `${d?.reused ? "Reusing an existing download (free). " : ""}Price: ${usd(d?.price_cents)}${d?.free_reason ? ` (free: ${d.free_reason})` : ""}; charged when the file is ready.`;
      if (!ctx.values.wait) {
        ctx.result(d, () => `Download ${show(d?.id)} (${show(d?.quality)}) ${show(d?.status)}.\n${price}\nFollow it: nightshift download get ${show(d?.id)} --wait\n`);
        return;
      }
      ctx.note(`Download ${show(d?.id)} ${show(d?.status)}. ${price}\n`);
      const done = await afterCreated(waitForDownload(ctx, client, numericId(String(d?.id), "download id")), {
        text: `download ${d?.id} was already ordered; follow it with: nightshift download get ${d?.id} --wait`,
        details: { created_download_id: d?.id ?? null },
      });
      if (done?.status !== "ready") ctx.exitCode = EXIT.ERROR;
      ctx.result(done, () => `Download ${show(done?.id)} ${show(done?.status)}.\n${done?.status === "ready" ? `Save it: nightshift download save ${show(done?.id)}\n` : ""}`);
    },
  },
  {
    path: "download get",
    summary: "Show a download's status.",
    usage: "nightshift download get ID [--wait] [--json]",
    options: { ...WAIT_OPTIONS },
    positionals: { names: ["ID"], min: 1, max: 1 },
    examples: ["nightshift download get 45", "nightshift download get 45 --wait"],
    async run(ctx) {
      const id = numericId(ctx.positionals[0], "ID");
      const client = await getClient(ctx);
      const d = ctx.values.wait ? await waitForDownload(ctx, client, id) : (await client.request("GET", `/downloads/${id}`)).body;
      if (ctx.values.wait && d?.status !== "ready") ctx.exitCode = EXIT.ERROR;
      ctx.result(d, () =>
        rows([
          ["Download", show(d?.id)],
          ["Video", show(d?.video_id)],
          ["Quality", show(d?.quality)],
          ["Status", show(d?.status)],
          ["Expires", show(d?.expires_at, "not set")],
        ]),
      );
    },
  },
  {
    path: "download save",
    summary: "Save a ready download's MP4 to a file.",
    usage: "nightshift download save ID [--out FILE] [--force] [--json]",
    options: {
      out: { type: "string", arg: "FILE", help: "Where to write (default ./nightshift-download-ID.mp4)." },
      force: { type: "boolean", help: "Overwrite an existing file." },
    },
    positionals: { names: ["ID"], min: 1, max: 1 },
    examples: ["nightshift download save 45", "nightshift download save 45 --out ./tides.mp4"],
    notes: ["Saving costs nothing: the charge was made when the file became ready."],
    async run(ctx) {
      const id = numericId(ctx.positionals[0], "ID");
      const target = resolve(ctx.io.cwd, ctx.values.out ?? `nightshift-download-${id}.mp4`);
      if (!ctx.values.force && (await stat(target).then(() => true, () => false)))
        throw new CliError("file_exists", `${target} already exists. Use --force to overwrite or --out to choose another file.`, { exit: EXIT.USAGE });
      const client = await getClient(ctx);
      const { res } = await client.stream(`/downloads/${id}/file`);
      if (!res.body) throw new CliError("bad_response", "The server sent no file.");
      const tmp = `${target}.part`;
      try {
        await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
        await rename(tmp, target);
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => {});
        throw new CliError("download_failed", `The download was interrupted (${(e && e.code) || (e && e.name) || "error"}). Run the command again; it costs nothing.`);
      }
      const { size } = await stat(target);
      ctx.result({ ok: true, file: target, bytes: size }, () => `Saved ${target} (${size} bytes).\n`);
    },
  },
  {
    path: "publish",
    summary: "Cross-post a finished video. Free. The site's publish gate and approvals apply; YouTube uploads are private.",
    usage: "nightshift publish VIDEO_ID (--youtube CHANNEL_ID | --account ACCOUNT_ID)... [--json]",
    options: {
      youtube: { type: "string", multiple: true, arg: "CHANNEL_ID", help: "A YouTube channel of the organization (repeatable). Uploaded private." },
      account: { type: "string", multiple: true, arg: "ACCOUNT_ID", help: "A connected Instagram or TikTok account id (repeatable)." },
      ...IDEMPOTENCY_OPTION,
    },
    positionals: { names: ["VIDEO_ID"], min: 1, max: 1 },
    examples: ["nightshift accounts", "nightshift publish abc123 --youtube my-channel", "nightshift publish abc123 --account 0b1c2d3e-0000-4000-8000-000000000000"],
    notes: [
      "A video that has not passed the publish gate and its approvals is refused with a reason; this command cannot override that.",
      "A request recorded here is not proof of a public post: YouTube uploads stay private, and some requests wait for a person's approval. Check `nightshift videos get VIDEO_ID`.",
    ],
    async run(ctx) {
      const id = videoId(ctx.positionals[0]);
      const channelIds = ctx.values.youtube ?? [];
      const accountIds = ctx.values.account ?? [];
      if (channelIds.length + accountIds.length === 0) throw usageError("Name at least one --youtube CHANNEL_ID or --account ACCOUNT_ID (see `nightshift accounts`).");
      const body = {};
      if (channelIds.length) body.channel_ids = channelIds;
      if (accountIds.length) body.account_ids = accountIds;
      const { key } = idempotencyKeyFor(ctx);
      const client = await getClient(ctx);
      const { body: out } = await client.request("POST", `/videos/${encodeURIComponent(id)}/publish`, { body, idempotencyKey: key });
      const reqs = Array.isArray(out?.requests) ? out.requests : [];
      const errs = Array.isArray(out?.errors) ? out.errors : [];
      if (errs.length) ctx.exitCode = EXIT.ERROR;
      ctx.result(out, () =>
        reqs.map((r) => `${show(r.platform)} -> ${show(r.target_channel_id ?? r.account_id)}: ${show(r.status)}${r.reason ? ` (${r.reason})` : ""}`).join("\n") +
        (reqs.length ? "\n" : "") +
        errs.map((e) => `refused ${show(e.channel_id ?? e.account_id)}: ${show(e.error)}`).join("\n") +
        (errs.length ? "\n" : "") +
        "Requests are recorded, not proof of a post: YouTube uploads are private and some wait for approval.\n",
      );
    },
  },
];

async function waitForDownload(ctx, client, id) {
  let last = null;
  return pollUntil({
    fetchOnce: async () => (await client.request("GET", `/downloads/${id}`)).body,
    isDone: (d) => DOWNLOAD_DONE.has(d?.status),
    onUpdate: (d) => {
      if (d?.status !== last) {
        last = d?.status;
        ctx.note(`download ${id}: ${show(d?.status)}\n`);
      }
    },
    io: ctx.io,
    timeoutSeconds: waitSeconds(ctx),
    what: `download ${id}`,
  });
}
