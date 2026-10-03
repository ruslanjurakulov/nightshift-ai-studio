import { EXIT, usageError } from "../errors.js";
import { credits, rows, show } from "../format.js";
import { pollUntil } from "../poll.js";
import { IDEMPOTENCY_OPTION, WAIT_OPTIONS, afterCreated, getClient, idempotencyKeyFor, intOption } from "./shared.js";

const GEN_DONE = new Set(["completed", "failed", "cancelled", "expired"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = ["exact", "auto", "cheap", "fast", "quality"];
const NUMERIC_PARAMS = new Set(["duration_s", "seed", "factor"]);
const BOOLEAN_PARAMS = new Set(["audio"]);

/** The generation options shared by `quote` and `generate`. */
const GENERATION_OPTIONS = {
  capability: { type: "string", arg: "NAME", help: "What to make: t2i, t2v, tts, sfx, music, edit, i2v, upscale, remove_bg, voice_change, dub, video_upscale, describe, captions." },
  model: { type: "string", arg: "ID", help: "A model id the API sells for this capability. Required for mode exact; for other modes, the routed_model the quote named." },
  mode: { type: "string", arg: "MODE", help: `${MODES.join(" | ")} (default exact). Non-exact modes let the API pick among models it sells.` },
  prompt: { type: "string", arg: "TEXT", help: "params.prompt" },
  "aspect-ratio": { type: "string", arg: "W:H", help: "params.aspect_ratio" },
  resolution: { type: "string", arg: "TEXT", help: "params.resolution" },
  "duration-s": { type: "string", arg: "SECONDS", help: "params.duration_s" },
  "source-asset": { type: "string", arg: "UUID", help: "params.source_asset_id: a media-library asset of the organization." },
  param: { type: "string", multiple: true, arg: "KEY=VALUE", help: "Any other param (repeatable): duration_s, seed, factor and audio are typed; the rest are strings." },
  params: { type: "string", arg: "JSON", help: "A whole params object as JSON (flags above override its keys)." },
};

function buildRequest(ctx) {
  const v = ctx.values;
  if (!v.capability) throw usageError("--capability is required.");
  const mode = v.mode ?? "exact";
  if (!MODES.includes(mode)) throw usageError(`--mode must be one of ${MODES.join(", ")}.`);
  let params = {};
  if (v.params != null) {
    try {
      params = JSON.parse(v.params);
    } catch {
      throw usageError("--params is not valid JSON.");
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) throw usageError("--params must be a JSON object.");
  }
  for (const kv of v.param ?? []) {
    const i = kv.indexOf("=");
    if (i < 1) throw usageError(`--param expects KEY=VALUE, got "${kv.slice(0, 40)}".`);
    const k = kv.slice(0, i);
    const raw = kv.slice(i + 1);
    if (NUMERIC_PARAMS.has(k)) {
      if (!Number.isFinite(Number(raw)) || raw.trim() === "") throw usageError(`--param ${k} must be a number.`);
      params[k] = Number(raw);
    } else if (BOOLEAN_PARAMS.has(k)) {
      if (raw !== "true" && raw !== "false") throw usageError(`--param ${k} must be true or false.`);
      params[k] = raw === "true";
    } else params[k] = raw;
  }
  for (const [flag, key] of [["prompt", "prompt"], ["aspect-ratio", "aspect_ratio"], ["resolution", "resolution"], ["source-asset", "source_asset_id"]])
    if (v[flag] != null) params[key] = v[flag];
  if (v["duration-s"] != null) {
    if (!Number.isFinite(Number(v["duration-s"]))) throw usageError("--duration-s must be a number.");
    params.duration_s = Number(v["duration-s"]);
  }
  const body = { capability: v.capability, params };
  if (v.model != null) body.model = v.model;
  if (v.mode != null) body.mode = mode;
  return { body, mode };
}

function genLines(j) {
  return rows([
    ["Generation", show(j?.id)],
    ["Capability", show(j?.capability)],
    ["Model", show(j?.routed_model ?? j?.model)],
    ["Status", show(j?.status)],
    ["Held (quoted)", credits(j?.quoted_credits)],
    ["Charged", j?.charged_credits == null ? "not yet" : credits(j.charged_credits)],
    ...(j?.error ? [["Error", `${show(j.error_code, "")} ${j.error}`.trim()]] : []),
    ...(Array.isArray(j?.result_asset_ids) && j.result_asset_ids.length ? [["Result assets", j.result_asset_ids.join(", ") + "  (in the organization's media library)"]] : []),
  ]);
}

async function waitForGeneration(ctx, client, id) {
  let last = null;
  return pollUntil({
    fetchOnce: async () => (await client.request("GET", `/creative/jobs/${id}`)).body,
    isDone: (j) => GEN_DONE.has(j?.status),
    onUpdate: (j) => {
      if (j?.status !== last) {
        last = j?.status;
        ctx.note(`generation ${id}: ${show(j?.status)}\n`);
      }
    },
    io: ctx.io,
    timeoutSeconds: intOption(ctx, "timeout", { min: 1, max: 86400 }) ?? 1800,
    what: `generation ${id}`,
  });
}

export const creativeCommands = [
  {
    path: "quote",
    summary: "The price of one generation, in credits. Nothing is held or charged.",
    usage: "nightshift quote --capability NAME [--model ID | --mode auto] --prompt TEXT [--json]",
    options: { ...GENERATION_OPTIONS },
    positionals: { names: [], min: 0, max: 0 },
    examples: [
      'nightshift quote --capability t2i --model MODEL_ID --prompt "a lighthouse at dusk"',
      'nightshift quote --capability t2i --mode cheap --prompt "a lighthouse at dusk"   # the API picks and names routed_model',
    ],
    notes: ["Needs a key with the creative:quote scope. The API has no model list: use a model id your organization already knows, or a non-exact --mode."],
    async run(ctx) {
      const { body } = buildRequest(ctx);
      const client = await getClient(ctx);
      const { body: out } = await client.request("POST", "/creative/quote", { body });
      const q = out?.quote ?? {};
      ctx.result(out, () =>
        rows([
          ["Price", `${credits(q.credits)}${q.exempt ? " (this organization is exempt: nothing is charged)" : ""}`],
          ["Capability", show(q.capability)],
          ["Model", show(q.routed_model ?? q.model)],
          ...(q.routed_model ? [["Picked because", show(q.route_reason)]] : []),
          ["Unit", `${show(q.quantity)} x ${show(q.unit)} at ${show(q.credits_per_unit)} credits each (minimum ${show(q.minimum)})`],
        ]) + "Start it with the same flags plus --max-credits N, where N is at least this price: nightshift generate ...\n",
      );
    },
  },
  {
    path: "generate",
    summary: "Start one generation. Credits are HELD at the quote; --max-credits is required.",
    usage: "nightshift generate --capability NAME --model ID --max-credits N --prompt TEXT [--wait] [--json]",
    options: {
      ...GENERATION_OPTIONS,
      "max-credits": { type: "string", arg: "N", help: "Required. The most credits you accept to be charged. A higher price is refused with 409 price_changed and nothing is held." },
      ...IDEMPOTENCY_OPTION,
      ...WAIT_OPTIONS,
    },
    positionals: { names: [], min: 0, max: 0 },
    examples: [
      "nightshift quote --capability t2i --model MODEL_ID --prompt 'a lighthouse'      # note the price",
      "nightshift generate --capability t2i --model MODEL_ID --prompt 'a lighthouse' --max-credits 5 --wait",
    ],
    notes: [
      "Paid in the organization's credits (not the USD API balance). Held now, captured when it succeeds, released if it fails.",
      "Needs a key with the creative:create scope. The files appear in the organization's media library; the API has no file download for generations yet.",
    ],
    async run(ctx) {
      const raw = ctx.values["max-credits"];
      if (raw == null) throw usageError("--max-credits is required: the most credits you accept to be charged (see `nightshift quote`).");
      const max = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(max) || max < 0) throw usageError("--max-credits must be a number of credits, 0 or more.");
      const { body } = buildRequest(ctx);
      if (!body.model) throw usageError("--model is required (for a non-exact mode, the routed_model the quote named).");
      body.max_credits = max;
      intOption(ctx, "timeout", { min: 1, max: 86400 });
      const { key, generated } = idempotencyKeyFor(ctx);
      const client = await getClient(ctx);
      if (generated) ctx.note(`Idempotency-Key: ${key}  (pass --idempotency-key ${key} to retry this exact request safely)\n`);
      const { body: job, replayed, status } = await client.request("POST", "/creative/jobs", { body, idempotencyKey: key });
      const held = `Held from your credits: ${credits(job?.quoted_credits)} (you allowed up to ${max}). Captured only if it succeeds; released if it fails.`;
      const same = replayed || status === 200 ? "Same job as the earlier request (same Idempotency-Key); nothing more was held.\n" : "";
      if (!ctx.values.wait) {
        ctx.result(job, () => `${same}Started generation ${show(job?.id)}.\n${held}\nFollow it: nightshift generations get ${show(job?.id)} --wait\n`);
        return;
      }
      ctx.note(`${same}Started generation ${show(job?.id)}. ${held}\n`);
      const done = await afterCreated(waitForGeneration(ctx, client, job?.id), {
        text: `generation ${job?.id} was already started and its credits held; follow it with: nightshift generations get ${job?.id} --wait`,
        details: { created_generation_id: job?.id ?? null },
      });
      if (done?.status !== "completed") ctx.exitCode = EXIT.ERROR;
      ctx.result(done, () => `Generation ${show(done?.id)} ${show(done?.status)}.\n${genLines(done)}`);
    },
  },
  {
    path: "generations get",
    summary: "Show a generation this key started: status, held and charged credits, result assets.",
    usage: "nightshift generations get ID [--wait] [--json]",
    options: { ...WAIT_OPTIONS },
    positionals: { names: ["ID"], min: 1, max: 1 },
    examples: ["nightshift generations get 0b1c2d3e-0000-4000-8000-000000000000 --wait"],
    notes: ["Needs the creative:read scope. Another key's generation answers 404 job_not_found."],
    async run(ctx) {
      const id = ctx.positionals[0];
      if (!UUID_RE.test(id)) throw usageError("ID must be the generation id (a UUID) that `generate` printed.");
      const client = await getClient(ctx);
      const j = ctx.values.wait ? await waitForGeneration(ctx, client, id) : (await client.request("GET", `/creative/jobs/${id}`)).body;
      if (ctx.values.wait && j?.status !== "completed") ctx.exitCode = EXIT.ERROR;
      ctx.result(j, () => genLines(j));
    },
  },
];
