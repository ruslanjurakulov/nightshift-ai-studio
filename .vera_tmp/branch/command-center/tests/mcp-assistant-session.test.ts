import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { ApiCaller, Rpc } from "@/lib/api/operations";
import { apiError, type ApiResult } from "@/lib/api/http";
import { oauthRpc } from "@/lib/api/mcp-oauth";
import { oauthEndpoints } from "@/lib/oauth/config";

/**
 * The MCP server driven the way a real assistant drives it: the official SDK
 * Client, over the Streamable HTTP client transport, whose fetch is the real
 * POST/GET/DELETE handler of app/api/mcp/route.ts. Everything below the route
 * is real (the tool registry, zod schemas, operations, the OAuth routing and
 * refusal texts); only the database is a fake, whose answers copy the shapes
 * and refusal texts of the SQL functions (0042, 0093, 0094, 0111).
 *
 * Both doors: an API key (prepaid USD, cents) and an OAuth connection (site
 * credits), the latter with each scope combination docs/MCP.md describes.
 *
 * Tests marked `it.fails` demonstrate a confirmed product bug (named in the
 * comment above each); they flip to failing-as-passing when the bug is fixed,
 * which is the cue to turn them into plain `it`. A comment that starts "Was a
 * bug" marks a test that was `it.fails` until the fix it names.
 */

// ── the fake database ──────────────────────────────────────────────────────

const ORIGIN = "https://nightshift-ai.studio";
const KEY = "Bearer nsk_live_" + "k".repeat(43);
const TOKEN = "Bearer nso_at_" + "t".repeat(43);
const ACCOUNT_IG = "3f1c2a4e-9b7d-4c1e-8a2f-0d5e6b7c8a91";

const db = vi.hoisted(() => {
  const s = {
    calls: [] as { fn: string; args: Record<string, unknown> }[],
    /** fn -> a forced refusal (what the SQL would answer in that state). */
    refuse: {} as Record<string, { status: number; error: Record<string, unknown> }>,
    /** fn -> a PostgREST-level error (the call did not reach the function's body). */
    pgError: {} as Record<string, { code?: string; message?: string }>,
    /** fn -> the rpc itself throws (a client library bug, a dropped socket). */
    throwOn: {} as Record<string, string | Error>,
    oauth: { scopes: ["videos:read", "videos:create", "videos:publish"] as string[], checkAnswer: null as unknown, resource: "" },
    apiCents: { balance: 1000, reserved: 0, monthSpend: 0, cap: 10000 },
    credits: { balance: 400, reserved: 0, limit: 500, spent: 0, runLimit: 2 },
    jobs: new Map<number, Record<string, unknown>>(),
    nextJob: 101,
    idem: new Map<string, { fp: string; data: Record<string, unknown> }>(),
    sending: new Set<string>(),
    nextPublish: 9001,
  };
  return s;
});

function reset() {
  db.calls = [];
  db.refuse = {};
  db.pgError = {};
  db.throwOn = {};
  db.oauth = { scopes: ["videos:read", "videos:create", "videos:publish"], checkAnswer: null, resource: oauthEndpoints(ORIGIN).resource };
  db.apiCents = { balance: 1000, reserved: 0, monthSpend: 0, cap: 10000 };
  db.credits = { balance: 400, reserved: 0, limit: 500, spent: 0, runLimit: 2 };
  db.jobs = new Map();
  db.nextJob = 101;
  db.idem = new Map();
  db.sending = new Set();
  db.nextPublish = 9001;
}

const CHANNELS = [
  { id: "history-uz", name: "Tarix", niche: "history", active: true, youtube_connected: true, target_duration_seconds: 480 },
  { id: "space-facts", name: "Space Facts", niche: "space", active: true, youtube_connected: true, target_duration_seconds: null },
  { id: "draft-one", name: "Draft", niche: null, active: false, youtube_connected: false, target_duration_seconds: null },
];
const VIDEOS = [
  { id: "vid-abc123", channel_id: "history-uz", title: "Amir Temur", state: "uploaded", privacy: "private", youtube_url: "https://youtu.be/abc123" },
];

const ok = (data: unknown, status = 200, extra: Record<string, unknown> = {}) => ({ ok: true, status, data, ...extra });
const err = (status: number, code: string, message: string, details: Record<string, unknown> = {}) => ({
  ok: false,
  status,
  error: { code, message, ...details },
});

/** The scope each OAuth endpoint needs (0093 oauth_endpoint_scope). */
const OAUTH_SCOPE_OF: Record<string, string> = {
  api_list_channels: "videos:read",
  api_list_videos: "videos:read",
  api_get_video: "videos:read",
  api_list_connected_accounts: "videos:read",
  oauth_get_job: "videos:read",
  oauth_get_balance: "videos:read",
  oauth_create_video: "videos:create",
  api_request_publish: "videos:publish",
};

const fakeRpc: Rpc = async (fn, args) => {
  db.calls.push({ fn, args });
  const toThrow = db.throwOn[fn];
  if (toThrow) throw typeof toThrow === "string" ? new Error(toThrow) : toThrow;
  if (db.pgError[fn]) return { data: null, error: db.pgError[fn] };
  const viaToken = "p_token_hash" in args || ("p_key_hash" in args && args.p_key_hash === TOKEN_HASH);
  if (viaToken && fn !== "oauth_check") {
    // oauth_ctx: an endpoint not on the allow-list, then the scope.
    const need = OAUTH_SCOPE_OF[fn];
    if (!need) return { data: err(403, "not_available_for_connected_apps", "This action is not available to connected apps. It needs an API key."), error: null };
    if (!db.oauth.scopes.includes(need))
      return { data: err(403, "insufficient_scope", `This connection was not given the ${need} permission.`, { required_scope: need }), error: null };
  }
  const forced = db.refuse[fn];
  if (forced) return { data: { ok: false, status: forced.status, error: forced.error }, error: null };
  return { data: answer(fn, args), error: null };
};

const KEY_HASH = "b".repeat(64);
const TOKEN_HASH = "c".repeat(64);

function secsFor(channelId: string, params: Record<string, unknown>): number | null {
  const ch = CHANNELS.find((c) => c.id === channelId);
  const d = typeof params.duration === "number" ? params.duration : ch?.target_duration_seconds ?? null;
  return d == null ? null : Math.min(Math.max(Math.round(d), 30), 3600);
}

function answer(fn: string, a: Record<string, unknown>): unknown {
  switch (fn) {
    case "api_auth":
      return ok({ organization: { id: "org-1" }, tier: 1, activated: true });
    case "api_list_channels":
      return ok({ channels: CHANNELS });
    case "api_list_videos":
      return ok({ videos: a.p_channel_id ? VIDEOS.filter((v) => v.channel_id === a.p_channel_id) : VIDEOS, limit: a.p_limit, offset: a.p_offset });
    case "api_get_video": {
      const v = VIDEOS.find((x) => x.id === a.p_video_id);
      return v ? ok({ ...v, publish_requests: [] }) : err(404, "video_not_found", "No video with that id in this key's organization.");
    }
    case "api_list_connected_accounts":
      return ok({ accounts: [{ platform: "youtube", channel_id: "history-uz", name: "Tarix" }, { platform: "instagram", account_id: ACCOUNT_IG, name: "@tarix" }] });
    case "api_create_video":
    case "oauth_create_video":
      return createVideo(fn === "oauth_create_video", a);
    case "api_get_job":
    case "oauth_get_job": {
      const j = db.jobs.get(Number(a.p_job_id));
      if (!j) return err(404, "job_not_found", fn === "api_get_job" ? "No job with that id in this key's organization." : "No job with that id in this workspace.");
      const credits = fn === "oauth_get_job";
      return ok({
        id: j.id, channel_id: j.channel_id, status: j.status, params: j.params, created_at: "2026-11-13T10:00:00Z",
        started_at: null, finished_at: null, error: null, error_code: null,
        charge: credits ? { status: "open", held_credits: j.price, charged_credits: null } : { status: "held", held_cents: j.price, captured_cents: null },
      });
    }
    case "api_request_publish": {
      const targets = [...((a.p_account_ids as string[]) ?? []).map((x) => ["account_id", x]), ...((a.p_channel_ids as string[]) ?? []).map((x) => ["channel_id", x])];
      const rows: unknown[] = [];
      const errors: unknown[] = [];
      for (const [kind, id] of targets) {
        const k = `${a.p_video_id}:${id}`;
        if (db.sending.has(k)) errors.push({ [kind]: id, error: "already_sending" });
        else {
          db.sending.add(k);
          rows.push({ id: db.nextPublish++, platform: kind === "account_id" ? "instagram" : "youtube", [kind]: id, status: "queued", reason: null });
        }
      }
      if (rows.length) return ok({ requests: rows, errors });
      return err(409, "publish_refused", "No publish request could be recorded.", { errors });
    }
    case "api_balance":
      return ok({
        currency: "usd", exempt: false, balance_cents: db.apiCents.balance, reserved_cents: db.apiCents.reserved,
        available_cents: db.apiCents.balance - db.apiCents.reserved, month_spend_cents: db.apiCents.monthSpend,
        monthly_limit_cents: db.apiCents.cap, tier: 1,
      });
    case "oauth_get_balance":
      return ok({
        credits: { available: Math.max(db.credits.balance - db.credits.reserved, 0), held: db.credits.reserved },
        plan: "plus", videos_in_progress: [...db.jobs.values()].filter((j) => j.status === "queued").length, videos_at_once_limit: db.credits.runLimit,
        this_connection: { monthly_limit_credits: db.credits.limit, spent_this_month_credits: db.credits.spent, left_this_month_credits: Math.max(db.credits.limit - db.credits.spent, 0) },
      });
    case "api_request_download":
      return ok({ download_id: 55, quality: a.p_quality, status: "pending", price_cents: 27, free_reason: null }, 201);
    case "api_get_download":
      return ok({ id: a.p_id, status: "ready" });
    default:
      return null as unknown;
  }
}

function createVideo(viaToken: boolean, a: Record<string, unknown>): unknown {
  const params = { ...(a.p_params as Record<string, unknown>) };
  const idem = a.p_idem_key as string | null;
  const fp = JSON.stringify([a.p_channel_id, params]);
  const idemKey = `${viaToken ? "grant" : "key"}:${idem}`;
  if (idem) {
    const prior = db.idem.get(idemKey);
    if (prior && prior.fp !== fp)
      return viaToken
        ? err(422, "idempotency_key_reused", "This idempotency_key was already used with a different request.")
        : err(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request.");
    if (prior) return ok(prior.data, 200, { replayed: true });
  }
  const ch = CHANNELS.find((c) => c.id === a.p_channel_id);
  if (!ch) return err(404, "channel_not_found", viaToken ? "No channel with that id in this workspace." : "No channel with that id in this key's organization.");
  if (!ch.active) return err(409, "channel_not_active", "That channel is not active. Connect it to YouTube and activate it in the Command Center first.");
  const secs = secsFor(ch.id, params);
  if (secs == null) return err(400, "duration_required", "Pass duration (seconds): this channel has no target length to price the video by.");
  params.duration = secs;
  let data: Record<string, unknown>;
  if (viaToken) {
    // The app's own price (credit_prices video_minute, job_minimum): 20 credits/min, 10 minimum, in this fake.
    const price = Math.max(10, Math.ceil((secs * 20) / 60));
    if (db.credits.spent + price > db.credits.limit)
      return err(402, "connection_limit_reached", "This video would take this connection past its monthly spending limit.", {
        limit_credits: db.credits.limit, spent_credits: db.credits.spent, price_credits: price,
      });
    const active = [...db.jobs.values()].filter((j) => j.status === "queued").length;
    if (db.credits.balance - db.credits.reserved < price)
      return err(402, "insufficient_credits", "The workspace does not have enough credits for this video.", {
        available_credits: Math.max(db.credits.balance - db.credits.reserved, 0), held_credits: db.credits.reserved, price_credits: price,
      });
    if (active >= db.credits.runLimit)
      return err(429, "run_limit_reached", "The plan's limit of videos in progress at once is reached.", { retry_after: 60, active_runs: active, run_limit: db.credits.runLimit });
    db.credits.reserved += price;
    db.credits.spent += price;
    const id = db.nextJob++;
    db.jobs.set(id, { id, channel_id: ch.id, status: "queued", params, price });
    data = { job_id: id, channel_id: ch.id, status: "queued", price_credits: price };
  } else {
    // api_video_price: $1.20 a minute, $0.60 minimum (0031 seed).
    const price = Math.max(60, Math.ceil((secs * 120) / 60));
    if (db.apiCents.monthSpend + price > db.apiCents.cap)
      return err(402, "monthly_limit_reached", "This video would take the organization past its monthly API spend limit. An owner or admin can raise it in the Developer console: Developers → Usage and billing → Monthly spend limit (up to the usage tier's cap; paying more into the API balance raises the tier).", {
        limit_cents: db.apiCents.cap, month_spend_cents: db.apiCents.monthSpend, price_cents: price,
      });
    if (db.apiCents.balance - db.apiCents.reserved < price)
      return err(402, "insufficient_balance", "Your API balance does not cover this video. Top up in the Developer console.", {
        price_cents: price, available_cents: db.apiCents.balance - db.apiCents.reserved,
      });
    db.apiCents.reserved += price;
    const id = db.nextJob++;
    db.jobs.set(id, { id, channel_id: ch.id, status: "queued", params, price });
    data = { job_id: id, channel_id: ch.id, status: "queued", price_cents: price };
  }
  if (idem) db.idem.set(idemKey, { fp, data });
  return ok(data, 201);
}

vi.mock("@/lib/server/public-api", () => ({
  isCaller: (v: object) => "keyHash" in v,
  apiCaller: async (request: Request, requestId: string): Promise<ApiCaller | ApiResult> => {
    const auth = request.headers.get("authorization") ?? "";
    if (!/^Bearer nsk_live_/.test(auth)) return apiError(401, "invalid_api_key", 'Send your API key as "Authorization: Bearer nsk_live_…".');
    return { keyHash: KEY_HASH, requestId, rpc: fakeRpc, backend: "queue", downloads: true };
  },
  oauthCheck: async (_hash: string, requestId: string) => {
    db.calls.push({ fn: "oauth_check", args: { p_request_id: requestId } });
    if (db.oauth.checkAnswer) return { data: db.oauth.checkAnswer, error: null };
    return { data: ok({ resource: db.oauth.resource, scopes: db.oauth.scopes, entitled: true }), error: null };
  },
  oauthApiCaller: (_hash: string, requestId: string): ApiCaller => ({ keyHash: TOKEN_HASH, requestId, rpc: oauthRpc(fakeRpc), backend: "queue", downloads: false }),
}));

const route = await import("@/app/api/mcp/route");

// ── the assistant's side ───────────────────────────────────────────────────

const MCP_URL = `${ORIGIN}/api/mcp`;

/** A fetch that hands the SDK client's HTTP requests to the route handlers, with the caller's credential. */
function routeFetch(auth: string | null, log?: { method: string; status: number }[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const headers = new Headers(req.headers);
    if (auth) headers.set("authorization", auth);
    const body = req.method === "POST" ? await req.text() : undefined;
    const r = new Request(req.url, { method: req.method, headers, body });
    const handler = (req.method === "POST" ? route.POST : req.method === "GET" ? route.GET : route.DELETE) as (r: Request) => Promise<Response> | Response;
    const res = await handler(r);
    log?.push({ method: req.method, status: res.status });
    return res;
  }) as typeof fetch;
}

async function connect(auth: string, log?: { method: string; status: number }[]) {
  const client = new Client({ name: "probe-assistant", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: routeFetch(auth, log) }));
  return client;
}

type ToolOut = { isError?: boolean; content: { type: string; text: string }[] };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolOut> {
  return (await client.callTool({ name, arguments: args })) as ToolOut;
}

const text = (r: ToolOut) => r.content.map((c) => c.text).join("\n");
const json = (r: ToolOut) => JSON.parse(text(r)) as Record<string, unknown>;

/** A raw JSON-RPC POST, for what the SDK client would never send. */
async function raw(body: unknown, auth: string | null = KEY, headers: Record<string, string> = {}): Promise<Response> {
  return route.POST(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(auth ? { authorization: auth } : {}),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const initialize = (protocolVersion: string, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name: "probe", version: "0" } },
});

const toolCall = (name: string, args: unknown, id: number | string = 7) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

// What the documents promise each door (docs/MCP.md "Tools").
const KEY_TOOLS = [
  "list_channels", "create_video", "get_job_status", "list_videos", "get_video",
  "list_connected_accounts", "publish_video", "request_download", "get_download", "get_balance",
  // The Studio tools (0162): an API key only, never a connected app (the OAuth sets below never list them).
  "list_models", "quote_generation", "create_generation", "get_generation",
];
const READ_TOOLS = ["list_channels", "get_job_status", "list_videos", "get_video", "list_connected_accounts", "get_balance"];

const SCOPE_SETS: [string, string[], string[]][] = [
  ["videos:read", ["videos:read"], READ_TOOLS],
  ["videos:read + videos:create", ["videos:read", "videos:create"], [...READ_TOOLS, "create_video"]],
  ["videos:read + videos:create + videos:publish", ["videos:read", "videos:create", "videos:publish"], [...READ_TOOLS, "create_video", "publish_video"]],
];

// Vendor, model and provider names that must never reach the assistant (CLAUDE.md: nothing shown as
// available that is not; the platform chooses providers). Platforms a video is POSTED to are not providers.
const VENDORS =
  /\b(eleven ?labs|openai|gpt|chatgpt|claude|anthropic|gemini|veo|kling|runway|pika|sora|midjourney|stable diffusion|sdxl|flux|suno|whisper|deepgram|pexels|pixabay|replicate|fal\.ai|luma|heygen|hailuo|minimax|seedance|ideogram|imagen|dall-?e|azure|polly|cartesia|play\.ht|moviepy|ffmpeg|supabase|postgres)\b/i;
// A price written into a description is a price the backend did not compute for this call.
const PRICE = /\$\s?\d|\d+(\.\d+)?\s?(¢|cents?\b|usd\b)|\b\d+(\.\d+)?\s?credits?\b/i;
// What must never reach the assistant from inside: SQL, hashes, holds' refs, stack traces.
const INTERNAL = /PGRST|sqlstate|NS40|42883|relation "|stack|at .*\.ts:\d|password|p_key_hash|p_token_hash|rj-oa-|ah-[0-9a-f]{8}|oauth_ctx|api_begin|select |insert into/i;

beforeEach(() => {
  reset();
  delete process.env.APP_ORIGIN;
});

// ── initialize ─────────────────────────────────────────────────────────────

describe("initialize: what an assistant's client negotiates", () => {
  for (const [door, auth] of [["API key", KEY], ["OAuth", TOKEN]] as const) {
    it.each(["2025-06-18", "2025-03-26"])(`${door}: a client asking for %s gets exactly that version back, the server's name and the tools capability`, async (v) => {
      const res = await raw(initialize(v), auth);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-request-id")).toMatch(/^req_/);
      const body = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string; version: string }; capabilities: Record<string, unknown>; instructions?: string } };
      expect(body.result.protocolVersion).toBe(v);
      expect(body.result.serverInfo).toEqual({ name: "nightshift", version: "1.0.0" });
      expect(body.result.capabilities).toHaveProperty("tools");
      // A stateless server: no session id the client would have to send back.
      expect(res.headers.get("mcp-session-id")).toBeNull();
      expect(body.result.instructions).toMatch(/list_channels/);
    });

    it(`${door}: an unknown future version is answered with a version the server does speak`, async () => {
      const res = await raw(initialize("2099-01-01"), auth);
      const body = (await res.json()) as { result: { protocolVersion: string } };
      expect(body.result.protocolVersion).toMatch(/^20\d\d-\d\d-\d\d$/);
      expect(body.result.protocolVersion).not.toBe("2099-01-01");
    });
  }

  it("the official SDK client connects through the API-key door (initialize, initialized, the optional GET answered 405)", async () => {
    const log: { method: string; status: number }[] = [];
    const client = await connect(KEY, log);
    expect(client.getServerVersion()).toEqual({ name: "nightshift", version: "1.0.0" });
    expect(client.getServerCapabilities()).toHaveProperty("tools");
    expect(client.getInstructions()).toMatch(/prepaid API balance/);
    expect(log.filter((l) => l.method === "POST").map((l) => l.status)).toEqual([200, 202]);
    expect(log.filter((l) => l.method !== "POST").every((l) => l.status === 405)).toBe(true);
    // The handshake was checked against the key: initialize and the notification, once each.
    expect(db.calls.map((c) => c.fn)).toEqual(["api_auth", "api_auth"]);
    await client.close();
  });

  it("the official SDK client connects through the OAuth door and is told it spends CREDITS", async () => {
    const client = await connect(TOKEN);
    expect(client.getInstructions()).toMatch(/CREDITS/);
    expect(client.getInstructions()).not.toMatch(/prepaid API balance/);
    expect(db.calls.map((c) => c.fn)).toEqual(["oauth_check", "oauth_check"]);
    await client.close();
  });

  it("a later request carrying an unsupported MCP-Protocol-Version header is a 400, not a 500", async () => {
    const res = await raw({ jsonrpc: "2.0", id: 2, method: "tools/list" }, KEY, { "mcp-protocol-version": "1999-01-01" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/Unsupported protocol version/);
  });
});

// ── tools/list ─────────────────────────────────────────────────────────────

type ListedTool = { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> };

async function listTools(auth: string): Promise<ListedTool[]> {
  const client = await connect(auth);
  const { tools } = await client.listTools();
  await client.close();
  return tools as ListedTool[];
}

function checkSchemas(tools: ListedTool[]) {
  const ajv = new AjvJsonSchemaValidator();
  for (const t of tools) {
    expect(t.description, t.name).toBeTruthy();
    expect(t.description!.length, t.name).toBeGreaterThan(20);
    expect(t.inputSchema.type, t.name).toBe("object");
    // The schema compiles in the validator the SDK client itself uses, and accepts an empty or minimal call.
    expect(() => ajv.getValidator(t.inputSchema), t.name).not.toThrow();
  }
}

describe("tools/list: exactly the documented tools for each door and permission", () => {
  it("API key: all fourteen tools, in order, each with a description and a JSON schema that compiles", async () => {
    const tools = await listTools(KEY);
    expect(tools.map((t) => t.name)).toEqual(KEY_TOOLS);
    checkSchemas(tools);
  });

  it.each(SCOPE_SETS)("OAuth %s: only the tools those permissions allow, never the paid downloads", async (_label, scopes, expected) => {
    db.oauth.scopes = scopes;
    const tools = await listTools(TOKEN);
    expect(tools.map((t) => t.name).sort()).toEqual([...expected].sort());
    expect(tools.map((t) => t.name)).not.toContain("request_download");
    expect(tools.map((t) => t.name)).not.toContain("get_download");
    checkSchemas(tools);
  });

  it("create_video's schema: channel_id required, providers not offered, extra fields refused, duration bounded", async () => {
    const tools = await listTools(KEY);
    const s = tools.find((t) => t.name === "create_video")!.inputSchema as {
      required: string[];
      properties: Record<string, { minimum?: number; maximum?: number; maxLength?: number; type?: string }>;
      additionalProperties?: boolean;
    };
    expect(s.required).toEqual(["channel_id"]);
    expect(Object.keys(s.properties)).not.toContain("video_provider");
    expect(Object.keys(s.properties)).not.toContain("image_provider");
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.duration).toMatchObject({ minimum: 30, maximum: 3600 });
    expect(s.properties.topic.maxLength).toBe(300);
    const v = new AjvJsonSchemaValidator().getValidator(s);
    expect(v({ channel_id: "history-uz", topic: "Oʻzbekiston tarixi" }).valid).toBe(true);
    expect(v({ channel_id: "history-uz", duration: 99999 }).valid).toBe(false);
    expect(v({ channel_id: "history-uz", video_provider: "kling" }).valid).toBe(false);
  });

  for (const [door, auth] of [["API key", KEY], ["OAuth", TOKEN]] as const) {
    it(`${door}: no description, title or instruction names a vendor, model or provider`, async () => {
      const client = await connect(auth);
      const { tools } = await client.listTools();
      const words = [client.getInstructions() ?? "", ...tools.flatMap((t) => [t.title ?? "", t.description ?? "", JSON.stringify(t.inputSchema)])].join("\n");
      await client.close();
      expect(words).not.toMatch(VENDORS);
    });
  }

  it("OAuth: no description or instruction states a price; the backend's price arrives with the call", async () => {
    const client = await connect(TOKEN);
    const { tools } = await client.listTools();
    const words = [client.getInstructions() ?? "", ...tools.flatMap((t) => [t.title ?? "", t.description ?? "", JSON.stringify(t.inputSchema)])].join("\n");
    await client.close();
    expect(words).not.toMatch(PRICE);
  });

  // Was a bug: request_download's description hard-coded "x 1.5 cents". The rate is the api_prices row
  // 'download_cents_per_credit' (0031:179, read at 0042:881), which the operator can change; the
  // description then stated a price the backend does not charge. It now names where the price comes
  // from: the order's own answer (price_cents).
  it("API key: no description or instruction states a fixed price", async () => {
    const tools = await listTools(KEY);
    const words = tools.flatMap((t) => [t.title ?? "", t.description ?? ""]).join("\n");
    expect(words).not.toMatch(PRICE);
    expect(tools.find((t) => t.name === "request_download")!.description).toMatch(/price_cents/);
  });

  // Was a bug: get_balance was titled "Get API balance" on the OAuth door too. A connected app has no API
  // balance (docs/MCP.md: it pays with site credits); clients show the title in the tool picker and the
  // approval prompt, so the person was told the app reads a USD balance it never sees.
  it("OAuth: get_balance is titled as the credit balance; the API key keeps its API balance title", async () => {
    expect((await listTools(TOKEN)).find((t) => t.name === "get_balance")!.title).toBe("Get credit balance");
    expect((await listTools(KEY)).find((t) => t.name === "get_balance")!.title).toBe("Get API balance");
  });

  // Was a bug (medium): OAuth publish_video advertised idempotency_key as "Reuse the same value when
  // retrying so the action happens once (24 hours)", but for a connection the key is dropped before the
  // database (oauthRpc: the idempotency record is keyed by API key) and, once a post has finished, a new
  // call posts again. An assistant that retried with the same key, as the schema told it to, would
  // cross-post the video a second time. The OAuth schema now has no such field, and the description says
  // what a repeat does.
  it("OAuth: publish_video does not promise once-only for an idempotency key it ignores", async () => {
    const tools = await listTools(TOKEN);
    const t = tools.find((x) => x.name === "publish_video")!;
    const s = t.inputSchema as { properties: Record<string, { description?: string }>; additionalProperties?: boolean };
    expect(Object.keys(s.properties)).not.toContain("idempotency_key");
    expect(s.additionalProperties).toBe(false);
    expect(JSON.stringify(t)).not.toMatch(/happens once/i);
    expect(t.description).toMatch(/once that post has finished a new call posts the video again/);
  });

  it("OAuth: a publish_video that still sends an idempotency_key is refused with the field named, and nothing is posted", async () => {
    const client = await connect(TOKEN);
    db.calls = [];
    const r = await call(client, "publish_video", { video_id: "vid-abc123", account_ids: [ACCOUNT_IG], idempotency_key: "retry-1" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("idempotency_key");
    expect(db.calls.filter((c) => c.fn !== "oauth_check")).toEqual([]);
    await client.close();
  });

  it("API key: publish_video keeps its idempotency_key, and it reaches the database", async () => {
    const tools = await listTools(KEY);
    const s = tools.find((t) => t.name === "publish_video")!.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(s.properties)).toContain("idempotency_key");
    const client = await connect(KEY);
    await call(client, "publish_video", { video_id: "vid-abc123", account_ids: [ACCOUNT_IG], idempotency_key: "p-1" });
    expect(db.calls.find((c) => c.fn === "api_request_publish")!.args).toMatchObject({ p_idem_key: "p-1", p_account_ids: [ACCOUNT_IG] });
    await client.close();
  });
});

describe("OAuth with a partial grant (a client may ask for one scope; docs/MCP.md: unknown words ignored)", () => {
  // Was a bug: the OAuth instructions were the same text for every grant. A connection granted only
  // videos:create (0093:712-716 lets a client ask for just that) was told to "Start with list_channels",
  // "call get_balance first" and "Poll get_job_status": tools it does not have; a read-only one was told
  // to create_video and publish_video. An assistant then cannot find a channel id or follow its job and
  // tells the person a tool is broken. The instructions are now built from the tools the grant is offered.
  it.each([
    [["videos:create"]], [["videos:publish"]], [["videos:read"]], [["videos:read", "videos:create"]],
    [["videos:create", "videos:publish"]], [["videos:read", "videos:create", "videos:publish"]],
  ])("scopes %j: the instructions name only tools that are offered", async (scopes) => {
    db.oauth.scopes = scopes;
    const client = await connect(TOKEN);
    const offered = new Set((await client.listTools()).tools.map((t) => t.name));
    const named = KEY_TOOLS.filter((t) => (client.getInstructions() ?? "").includes(t));
    await client.close();
    expect(named.filter((t) => !offered.has(t))).toEqual([]);
  });

  it("a read-only grant is told it cannot create or publish, and that the person can allow it", async () => {
    db.oauth.scopes = ["videos:read"];
    const client = await connect(TOKEN);
    const i = client.getInstructions() ?? "";
    await client.close();
    expect(i).toMatch(/not given permission to create videos or to publish videos/);
    expect(i).toMatch(/connect it again/);
  });
});

// ── a realistic session ────────────────────────────────────────────────────

describe("a realistic assistant session", () => {
  it("API key: channels -> create -> job -> videos -> video -> accounts -> publish -> balance, money in USD cents", async () => {
    const client = await connect(KEY);

    const channels = json(await call(client, "list_channels"));
    const list = channels.channels as { id: string; active: boolean }[];
    expect(list[0].id).toBe("history-uz");

    const created = await call(client, "create_video", { channel_id: list[0].id, topic: "How the Silk Road made Samarkand", duration: 120, idempotency_key: "conv-42-video-1" });
    expect(created.isError).toBeFalsy();
    const job = json(created);
    expect(job).toMatchObject({ job_id: 101, channel_id: "history-uz", status: "queued", price_cents: 240 });
    expect(job).not.toHaveProperty("price_credits");
    const createCall = db.calls.find((c) => c.fn === "api_create_video")!;
    expect(createCall.args).toMatchObject({ p_key_hash: KEY_HASH, p_channel_id: "history-uz", p_params: { topic: "How the Silk Road made Samarkand", duration: 120 }, p_idem_key: "conv-42-video-1" });
    expect(createCall.args.p_fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const status = json(await call(client, "get_job_status", { job_id: job.job_id as number }));
    expect(status).toMatchObject({ id: 101, status: "queued", error: null, error_code: null, charge: { held_cents: 240 } });

    const videos = json(await call(client, "list_videos", { channel_id: "history-uz", limit: 5 }));
    expect((videos.videos as { id: string }[])[0].id).toBe("vid-abc123");

    const video = json(await call(client, "get_video", { video_id: "vid-abc123" }));
    expect(video).toMatchObject({ id: "vid-abc123", privacy: "private", publish_requests: [] });

    const accounts = json(await call(client, "list_connected_accounts"));
    expect(accounts.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ account_id: ACCOUNT_IG })]));

    const published = await call(client, "publish_video", { video_id: "vid-abc123", account_ids: [ACCOUNT_IG], idempotency_key: "conv-42-publish-1" });
    expect(published.isError).toBeFalsy();
    expect(json(published)).toMatchObject({ requests: [{ id: 9001, platform: "instagram", status: "queued" }] });

    const balance = json(await call(client, "get_balance"));
    expect(balance).toMatchObject({ currency: "usd", available_cents: 760, reserved_cents: 240 });

    // One counted database call per tool call, and the handshake's two key checks.
    expect(db.calls.map((c) => c.fn)).toEqual([
      "api_auth", "api_auth",
      "api_list_channels", "api_create_video", "api_get_job", "api_list_videos", "api_get_video",
      "api_list_connected_accounts", "api_request_publish", "api_balance",
    ]);
    await client.close();
  });

  it("OAuth (all three permissions): the same session in CREDITS, never cents or USD", async () => {
    const client = await connect(TOKEN);
    const outputs: string[] = [];
    const go = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await call(client, name, args);
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy();
      outputs.push(text(r));
      return json(r);
    };

    const before = await go("get_balance");
    expect(before).toMatchObject({ credits: { available: 400, held: 0 }, plan: "plus", this_connection: { monthly_limit_credits: 500, left_this_month_credits: 500 } });

    const channels = await go("list_channels");
    const first = (channels.channels as { id: string }[])[0].id;
    const job = await go("create_video", { channel_id: first, topic: "Amir Temur va Samarqand", duration: 180, idempotency_key: "c-1" });
    expect(job).toMatchObject({ job_id: 101, status: "queued", price_credits: 60 });

    const create = db.calls.find((c) => c.fn === "oauth_create_video")!;
    expect(create.args).toMatchObject({ p_token_hash: TOKEN_HASH, p_channel_id: "history-uz", p_params: { topic: "Amir Temur va Samarqand", duration: 180 }, p_idem_key: "c-1" });
    expect(create.args).not.toHaveProperty("p_key_hash");
    expect(create.args).not.toHaveProperty("p_fingerprint");

    expect(await go("get_job_status", { job_id: 101 })).toMatchObject({ id: 101, charge: { held_credits: 60 } });
    await go("list_videos", {});
    await go("get_video", { video_id: "vid-abc123" });
    await go("list_connected_accounts");
    expect(await go("publish_video", { video_id: "vid-abc123", channel_ids: ["space-facts"] })).toMatchObject({ requests: [{ platform: "youtube", status: "queued" }] });
    expect(await go("get_balance")).toMatchObject({ credits: { available: 340, held: 60 }, this_connection: { spent_this_month_credits: 60, left_this_month_credits: 440 } });

    for (const o of outputs) expect(o).not.toMatch(/cents|"usd"|currency/i);
    // No call of a connection ever reached a USD function.
    expect(db.calls.map((c) => c.fn).filter((f) => /^api_(balance|create_video|get_job|request_download|get_download|auth)$/.test(f))).toEqual([]);
    await client.close();
  });

  it("OAuth: a topic in Uzbek (Latin and Cyrillic, with the oʻ letter) reaches the job exactly as typed", async () => {
    const client = await connect(TOKEN);
    const topic = "Oʻzbekiston: Амир Темур ва Самарқанд — tarix 🏛";
    const r = await call(client, "create_video", { channel_id: "history-uz", topic, duration: 60 });
    expect(r.isError).toBeFalsy();
    expect(db.calls.find((c) => c.fn === "oauth_create_video")!.args.p_params).toEqual({ topic, duration: 60 });
    await client.close();
  });

  it("no topic is not an error: the channel picks one, priced on the channel's target length", async () => {
    const client = await connect(KEY);
    const r = await call(client, "create_video", { channel_id: "history-uz" });
    expect(r.isError).toBeFalsy();
    expect(db.calls.find((c) => c.fn === "api_create_video")!.args.p_params).toEqual({});
    expect(json(r)).toMatchObject({ price_cents: 960 });
    await client.close();
  });
});

// ── refusals ───────────────────────────────────────────────────────────────

function expectNoLeak(t: string) {
  expect(t).not.toMatch(INTERNAL);
}

describe("refusals as an assistant hits them (tool errors that name the next step)", () => {
  it("API key, balance $0: a billing tool error with the price and the balance in cents, and where to top up", async () => {
    db.apiCents.balance = 0;
    const client = await connect(KEY);
    const r = await call(client, "create_video", { channel_id: "history-uz", topic: "Rome", duration: 90 });
    expect(r.isError).toBe(true);
    const e = (json(r) as { error: Record<string, unknown> }).error;
    expect(e).toMatchObject({ type: "billing_error", code: "insufficient_balance", price_cents: 180, available_cents: 0 });
    expect(String(e.message)).toMatch(/Top up in the Developer console/);
    expect(db.jobs.size).toBe(0);
    await client.close();
  });

  it("OAuth, not enough credits: what it needs, what there is, what is held, both links, and no reconnecting", async () => {
    db.credits.balance = 70;
    db.credits.reserved = 30;
    const client = await connect(TOKEN);
    const r = await call(client, "create_video", { channel_id: "history-uz", duration: 180 });
    expect(r.isError).toBe(true);
    const t = text(r);
    expect(t).toContain("needs 60 credits");
    expect(t).toContain("40 available");
    expect(t).toContain("30 more are set aside");
    expect(t).toContain(`${ORIGIN}/credits`);
    expect(t).toContain(`${ORIGIN}/pricing`);
    expect(t).toMatch(/no need to connect the app again/);
    expect(t).not.toMatch(/cents|\$/);
    expectNoLeak(t);

    // The person buys credits; the very next call on the same connection works.
    db.credits.balance = 500;
    const again = await call(client, "create_video", { channel_id: "history-uz", duration: 180 });
    expect(again.isError).toBeFalsy();
    await client.close();
  });

  it("OAuth, the connection's monthly limit: its numbers, that only the person can raise it, and where", async () => {
    db.credits.limit = 100;
    db.credits.spent = 90;
    const client = await connect(TOKEN);
    const t = text(await call(client, "create_video", { channel_id: "history-uz", duration: 60 }));
    expect(t).toMatch(/limit 100 credits, 90 used this month, and this video needs 20/);
    expect(t).toContain(`${ORIGIN}/developers`);
    expect(t).toMatch(/You cannot change it/);
    expectNoLeak(t);
    await client.close();
  });

  it("OAuth, videos at once: wait about a minute or a bigger plan; a running job is untouched", async () => {
    db.credits.runLimit = 1;
    const client = await connect(TOKEN);
    expect((await call(client, "create_video", { channel_id: "history-uz", duration: 60 })).isError).toBeFalsy();
    const r = await call(client, "create_video", { channel_id: "history-uz", duration: 60 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/at most 1 video at once and 1 is in progress/);
    expect(text(r)).toMatch(/about a minute/);
    expect(text(r)).toContain(`${ORIGIN}/pricing`);
    expect(db.jobs.get(101)!.status).toBe("queued");
    await client.close();
  });

  it("API key, videos at once: a rate-limit tool error with retry_after", async () => {
    db.refuse.api_create_video = { status: 429, error: { code: "concurrency_limit_exceeded", message: "Usage tier 1 runs at most 1 videos at once. Wait for one to finish.", retry_after: 60 } };
    const client = await connect(KEY);
    const r = await call(client, "create_video", { channel_id: "history-uz" });
    expect(r.isError).toBe(true);
    expect((json(r) as { error: unknown }).error).toMatchObject({ type: "rate_limit_error", code: "concurrency_limit_exceeded", retry_after: 60 });
    await client.close();
  });

  // Since 0147 no plan pauses a connection; this is what an app still hears from a database without 0147 (or after its
  // rollback): the plan named as the reason, never as "a paid plan" by name, and the way back.
  it("OAuth, a database that still gates by plan: the handshake works, every tool says the connection is paused and how to resume", async () => {
    for (const fn of Object.keys(OAUTH_SCOPE_OF))
      db.refuse[fn] = { status: 403, error: { code: "subscription_required", message: "Connected apps need a paid plan. This connection is paused until the workspace has one." } };
    const client = await connect(TOKEN);
    expect((await client.listTools()).tools.length).toBe(8);
    for (const [name, args] of [["list_channels", {}], ["create_video", { channel_id: "history-uz" }], ["get_balance", {}]] as const) {
      const r = await call(client, name, args);
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toMatch(/not included in this workspace.s current plan.*paused.*\/pricing.*no need to connect the app again/s);
      expect(text(r), name).not.toMatch(/paid plan|Plus, Pro|Business/);
    }
    await client.close();
  });

  it.each([
    ["an unknown channel", { channel_id: "no-such-channel" }, /channel_not_found/],
    ["a channel that is a draft", { channel_id: "draft-one" }, /Connect it to YouTube and activate it/],
    ["a channel with no target length and no duration", { channel_id: "space-facts" }, /Pass duration/],
  ])("API key, %s: the database's refusal as a tool error", async (_l, args, re) => {
    const client = await connect(KEY);
    const r = await call(client, "create_video", args);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(re);
    expect(db.jobs.size).toBe(0);
    await client.close();
  });

  it.each([
    ["an unknown channel", { channel_id: "no-such-channel" }, /No channel with that id in this workspace/],
    ["a channel that is a draft", { channel_id: "draft-one" }, /activate it in the Command Center/],
  ])("OAuth, %s: a tool error with the database's own sentence", async (_l, args, re) => {
    const client = await connect(TOKEN);
    const r = await call(client, "create_video", args);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(re);
    expectNoLeak(text(r));
    await client.close();
  });

  const BAD_ARGS: [string, Record<string, unknown>][] = [
    ["no channel_id", { topic: "Rome" }],
    ["a channel id with spaces and capitals", { channel_id: "My Channel" }],
    ["an absurd duration", { channel_id: "history-uz", duration: 99999 }],
    ["a negative duration", { channel_id: "history-uz", duration: -5 }],
    ["a fractional duration", { channel_id: "history-uz", duration: 90.5 }],
    ["a duration as a string", { channel_id: "history-uz", duration: "90" }],
    ["a topic as a number", { channel_id: "history-uz", topic: 42 }],
    ["an extra field", { channel_id: "history-uz", privacy: "public" }],
    ["a provider choice", { channel_id: "history-uz", video_provider: "kling" }],
    ["a 10 000-character topic", { channel_id: "history-uz", topic: "x".repeat(10_000) }],
    ["an idempotency key with spaces", { channel_id: "history-uz", idempotency_key: "has spaces" }],
    ["a 300-character idempotency key", { channel_id: "history-uz", idempotency_key: "k".repeat(300) }],
  ];
  for (const [door, auth] of [["API key", KEY], ["OAuth", TOKEN]] as const) {
    it.each(BAD_ARGS)(`${door}, create_video with %s: a tool error that names the field, before any database call`, async (_l, args) => {
      const client = await connect(auth);
      db.calls = [];
      const r = await call(client, "create_video", args);
      expect(r.isError).toBe(true);
      // The validator's message names the argument the assistant has to change.
      const field = Object.keys(args).find((k) => k !== "channel_id") ?? "channel_id";
      expect(text(r)).toContain(args.channel_id === "My Channel" || !("channel_id" in args) ? "channel_id" : field);
      // (An OAuth request's token check is not the tool's call.)
      expect(db.calls.filter((c) => c.fn !== "oauth_check")).toEqual([]);
      await client.close();
    });
  }

  it.each([
    ["get_job_status", { job_id: "seven" }],
    ["get_job_status", { job_id: -1 }],
    ["get_video", { video_id: "v".repeat(500) }],
    ["list_videos", { limit: 0 }],
    ["list_videos", { limit: 1000 }],
    ["publish_video", { video_id: "vid-abc123", account_ids: ["not-a-uuid"] }],
    ["publish_video", { video_id: "vid-abc123", channel_ids: Array.from({ length: 11 }, (_, i) => `c${i}`) }],
  ])("%s with bad arguments %j: a tool error, no database call", async (name, args) => {
    const client = await connect(KEY);
    db.calls = [];
    const r = await call(client, name, args);
    expect(r.isError).toBe(true);
    expect(db.calls).toEqual([]);
    await client.close();
  });

  it("an unknown job or video is a not-found tool error, not an empty success", async () => {
    const client = await connect(KEY);
    const j = await call(client, "get_job_status", { job_id: 999999 });
    expect(j.isError).toBe(true);
    expect(text(j)).toMatch(/job_not_found/);
    const v = await call(client, "get_video", { video_id: "../../etc/passwd" });
    expect(v.isError).toBe(true);
    expect(text(v)).toMatch(/video_not_found/);
    await client.close();
  });

  it("publish_video with no target: names the two kinds of id and where to find them", async () => {
    const client = await connect(KEY);
    const r = await call(client, "publish_video", { video_id: "vid-abc123" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/targets_required/);
    expect(text(r)).toMatch(/account_id or YouTube channel_id/);
    await client.close();
  });

  for (const [door, auth] of [["API key", KEY], ["OAuth", TOKEN]] as const) {
    it(`${door}: an idempotency_key replayed returns the first job and creates nothing; the same key with another body is refused`, async () => {
      const client = await connect(auth);
      const args = { channel_id: "history-uz", topic: "Samarkand", duration: 60, idempotency_key: "retry-7" };
      const first = json(await call(client, "create_video", args));
      const second = await call(client, "create_video", args);
      expect(second.isError).toBeFalsy();
      expect(json(second).job_id).toBe(first.job_id);
      expect(db.jobs.size).toBe(1);

      const reused = await call(client, "create_video", { ...args, topic: "Bukhara" });
      expect(reused.isError).toBe(true);
      expect(text(reused)).toMatch(/idempotency_key_reused/);
      expect(db.jobs.size).toBe(1);
      await client.close();
    });
  }

  it("API key: two identical create_video calls in one batch with one idempotency key make one job", async () => {
    const args = { channel_id: "history-uz", duration: 60, idempotency_key: "batch-1" };
    const res = await raw([toolCall("create_video", args, 1), toolCall("create_video", args, 2)]);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { id: number; result: ToolOut }[];
    expect(out).toHaveLength(2);
    const ids = out.map((o) => JSON.parse(o.result.content[0].text).job_id);
    expect(ids[0]).toBe(ids[1]);
    expect(db.jobs.size).toBe(1);
  });

  it("OAuth publish: while a post to a target is still being sent, a repeat call is refused (never sent twice)", async () => {
    const client = await connect(TOKEN);
    const args = { video_id: "vid-abc123", account_ids: [ACCOUNT_IG] };
    expect((await call(client, "publish_video", args)).isError).toBeFalsy();
    const again = await call(client, "publish_video", args);
    expect(again.isError).toBe(true);
    expect(db.calls.filter((c) => c.fn === "api_request_publish").every((c) => !("p_idem_key" in c.args))).toBe(true);
    await client.close();
  });

  // Was a bug: docs/MCP.md says a repeat publish of a target still being sent "is answered `already_sending`".
  // The database does say so (0042: publish_refused with errors[].error = 'already_sending'), but
  // oauthRefusalText's default branch printed only the message and code and dropped `details.errors`, so
  // the assistant read "No publish request could be recorded. (publish_refused)" and could not tell a
  // duplicate from a refusal. publish_refused now names each target's reason.
  it("OAuth publish: the repeat is explained as already being sent", async () => {
    const client = await connect(TOKEN);
    const args = { video_id: "vid-abc123", account_ids: [ACCOUNT_IG] };
    await call(client, "publish_video", args);
    const again = await call(client, "publish_video", args);
    expect(text(again)).toMatch(/already.?sending|already being sent/i);
    expect(text(again)).toContain(ACCOUNT_IG);
    // ...and that repeating it later would post twice, so the assistant does not "retry until it works".
    expect(text(again)).toMatch(/a new call would post the video a second time/);
    expectNoLeak(text(again));
    await client.close();
  });

  it("API key publish: the repeat carries already_sending per target", async () => {
    const client = await connect(KEY);
    const args = { video_id: "vid-abc123", account_ids: [ACCOUNT_IG] };
    await call(client, "publish_video", args);
    const again = await call(client, "publish_video", args);
    expect(again.isError).toBe(true);
    expect((json(again) as { error: unknown }).error).toMatchObject({ code: "publish_refused", errors: [{ account_id: ACCOUNT_IG, error: "already_sending" }] });
    await client.close();
  });

  it("OAuth videos:read only: create_video and publish_video are not offered, and calling them anyway changes nothing", async () => {
    db.oauth.scopes = ["videos:read"];
    const client = await connect(TOKEN);
    for (const name of ["create_video", "publish_video", "request_download"]) {
      const r = await call(client, name, { channel_id: "history-uz", video_id: "vid-abc123", account_ids: [ACCOUNT_IG], quality: "720p" });
      expect(r.isError, name).toBe(true);
    }
    expect(db.calls.map((c) => c.fn).filter((f) => f !== "oauth_check")).toEqual([]);
    expect(db.jobs.size).toBe(0);
    await client.close();
  });

  // Was a bug (rule 6): a connection without videos:create that called create_video (an assistant that
  // remembers the tool from another connection or the docs) got the SDK's "MCP error -32602: Tool
  // create_video not found": nothing said the permission was missing or what the person can do. The tool
  // is still not listed; a call to it is now answered with the insufficient_scope text.
  it.each([
    [["videos:read"], "create_video", { channel_id: "history-uz" }, "videos:create"],
    [["videos:read"], "publish_video", { video_id: "vid-abc123", account_ids: [ACCOUNT_IG] }, "videos:publish"],
    [["videos:create"], "list_channels", {}, "videos:read"],
  ])("OAuth %j: calling %s says which permission is missing and how to get it, and reaches nothing", async (scopes, name, args, need) => {
    db.oauth.scopes = scopes;
    const client = await connect(TOKEN);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(name);
    db.calls = [];
    const r = await call(client, name, args);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`"${need}"`);
    expect(text(r)).toMatch(/connect it again/i);
    expect(text(r)).toContain(`${ORIGIN}/developers`);
    expect(db.calls.filter((c) => c.fn !== "oauth_check")).toEqual([]);
    await client.close();
  });

  it("OAuth: a tool no connection is ever offered (the paid downloads) stays unknown, not a missing permission", async () => {
    const client = await connect(TOKEN);
    const r = await call(client, "request_download", { video_id: "vid-abc123", quality: "720p" });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toMatch(/permission/);
    expect(db.calls.filter((c) => c.fn !== "oauth_check")).toEqual([]);
    await client.close();
  });

  it("OAuth: an access token for another resource, or a dead one, is a 401 that points at the refresh, never a tool answer", async () => {
    db.oauth.resource = "https://evil.example/api/mcp";
    const a = await raw(initialize("2025-06-18"), TOKEN);
    expect(a.status).toBe(401);
    expect(a.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);

    reset();
    db.oauth.checkAnswer = err(401, "invalid_token", "The access token is missing, expired, revoked or unknown. Reconnect the app.");
    const b = await raw(toolCall("list_channels", {}), TOKEN);
    expect(b.status).toBe(401);
    expect(b.headers.get("www-authenticate")).toMatch(/resource_metadata="https:\/\/nightshift-ai\.studio\/\.well-known\/oauth-protected-resource\/api\/mcp"/);
  });

  it("OAuth: a connection over its per-minute limit gets a 429 with Retry-After", async () => {
    db.oauth.checkAnswer = err(429, "rate_limit_exceeded", "This connection is sending too many requests.", { retry_after: 30 });
    const res = await raw(toolCall("list_channels", {}), TOKEN);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  for (const [door, auth] of [["API key", KEY], ["OAuth", TOKEN]] as const) {
    it(`${door}: a database outage is a tool error with a retry hint and none of the database's words`, async () => {
      const client = await connect(auth);
      for (const fn of ["api_list_channels", "api_create_video", "oauth_create_video"])
        db.pgError[fn] = { code: "57014", message: "canceling statement due to statement timeout; password=hunter2 at oauth_ctx" };
      const ch = await call(client, "list_channels");
      expect(ch.isError).toBe(true);
      expectNoLeak(text(ch));
      const cv = await call(client, "create_video", { channel_id: "history-uz" });
      expect(cv.isError).toBe(true);
      expectNoLeak(text(cv));
      expect(text(cv)).toMatch(/Retry|Try again/i);
      await client.close();
    });

    it(`${door}: a malformed answer from the database is an internal tool error, never a success`, async () => {
      const client = await connect(auth);
      // A function that answers something that is not the api_* envelope.
      db.refuse.api_list_channels = { status: 200, error: {} };
      const r = await call(client, "list_channels");
      expect(r.isError).toBe(true);
      expectNoLeak(text(r));
      await client.close();
    });
  }

  // Was a bug (defense in depth): when the database call THROWS (instead of returning { error }), the SDK's
  // tools/call handler caught it and returned the exception's message verbatim as the tool result
  // (sdk server/mcp.js createToolError), so whatever the driver put in the message reached the assistant.
  // The route's own try/catch never sees it. Every tool callback is now wrapped in buildMcpServer: the
  // assistant gets the generic "could not complete this request" text with the request id, and the log
  // line names only the error's class.
  for (const [door, auth] of [["API key", KEY], ["OAuth", TOKEN]] as const) {
    it(`${door}: a thrown database error never reaches the assistant's text or the log`, async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const client = await connect(auth);
        db.throwOn.api_list_channels = "connect ECONNREFUSED 10.0.0.5:5432 (password=hunter2)";
        const r = await call(client, "list_channels");
        expect(r.isError).toBe(true);
        expect(text(r)).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
        expect(text(r)).toMatch(/could not complete this request/);
        expect(text(r)).toMatch(/req_[A-Za-z0-9]/);
        // It is not known whether a thrown call took effect, so the text must not say nothing happened.
        expect(text(r)).not.toMatch(/Nothing was (started|created|charged)/i);
        const lines = logged.mock.calls.map((c) => c.map(String).join(" "));
        expect(lines.some((l) => /\[mcp\] req_\S+ tool list_channels threw Error$/.test(l))).toBe(true);
        for (const l of lines) expect(l).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
        await client.close();
      } finally {
        logged.mockRestore();
      }
    });
  }

  // #707 review: the log names the thrown CLASS. e.name is a writable property a thrower can fill with message text;
  // constructor.name is the class, still allow-listed to a plain identifier.
  it("the log line names the error's class, never a name the thrower wrote into it", async () => {
    class PgTimeout extends Error {}
    const odd = new PgTimeout("x");
    odd.name = "host=10.0.0.5 password=hunter2";
    const renamed = new TypeError("y");
    renamed.name = "Error: connect 10.0.0.5";
    const bare = Object.assign(Object.create(null), { name: "hunter2" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = await connect(KEY);
      for (const [err, want] of [[odd, "PgTimeout"], [renamed, "TypeError"], [bare, "error"], ["plain", "Error"]] as const) {
        logged.mockClear();
        db.throwOn.api_list_channels = err as string | Error;
        await call(client, "list_channels");
        const lines = logged.mock.calls.map((c) => c.map(String).join(" "));
        expect(lines.some((l) => new RegExp(`\\[mcp\\] req_\\S+ tool list_channels threw ${want}$`).test(l)), want).toBe(true);
        for (const l of lines) expect(l).not.toMatch(/hunter2|10\.0\.0\.5/);
      }
      await client.close();
    } finally {
      logged.mockRestore();
    }
  });

  // Was a bug: list_videos (and get_job_status, get_video, publish_video) had non-strict schemas, so a
  // misspelt argument was silently DROPPED: list_videos({ channel: "history-uz" }) listed every channel's
  // videos as if no filter had been asked for. create_video was strict for exactly this reason, and REST
  // refuses unknown fields (operations.ts parsePublish). Every tool with arguments is now strict.
  it("list_videos with a misspelt filter is refused, not answered with every channel", async () => {
    const client = await connect(KEY);
    const r = await call(client, "list_videos", { channel: "history-uz" });
    expect(r.isError).toBe(true);
    await client.close();
  });

  for (const [door, auth] of [["API key", KEY], ["OAuth", TOKEN]] as const) {
    it.each([
      ["get_job_status", { job_id: 101, jobid: 7 }, "jobid"],
      ["list_videos", { channel: "history-uz" }, "channel"],
      ["get_video", { video_id: "vid-abc123", videoId: "x" }, "videoId"],
      ["publish_video", { video_id: "vid-abc123", account_ids: [ACCOUNT_IG], accounts: [ACCOUNT_IG] }, "accounts"],
    ])(`${door}: %s with a misspelt argument names it, before any database call`, async (name, args, field) => {
      const client = await connect(auth);
      db.calls = [];
      const r = await call(client, name, args);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(`"${field}"`);
      expect(db.calls.filter((c) => c.fn !== "oauth_check")).toEqual([]);
      await client.close();
    });
  }

  it.each([
    ["request_download", { video_id: "vid-abc123", quality: "720p", idempotencyKey: "k" }, "idempotencyKey"],
    ["get_download", { download_id: 55, id: 55 }, "id"],
  ])("API key: the paid %s refuses a misspelt argument too (a dropped idempotency key would charge a retry twice)", async (name, args, field) => {
    const client = await connect(KEY);
    db.calls = [];
    const r = await call(client, name, args);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`"${field}"`);
    expect(db.calls).toEqual([]);
    await client.close();
  });

  for (const [door, auth] of [["API key", KEY], ["OAuth", TOKEN]] as const) {
    it(`${door}: every listed schema with properties refuses unknown fields`, async () => {
      for (const t of await listTools(auth)) {
        const s = t.inputSchema as { properties?: Record<string, unknown>; additionalProperties?: boolean };
        if (s.properties && Object.keys(s.properties).length) expect(s.additionalProperties, t.name).toBe(false);
      }
    });
  }
});

// ── the API-key door's own refusal sentences (they are the database's, passed through) ─

/** Every message `code` is raised with in the LATEST body of each function that raises it: what production answers.
 *  Per function, not per file: 0170 restated api_request_download alone, so the last file that raises a code need not
 *  hold every function that does. */
function lastMigrationMessages(code: string): string[] {
  const dir = path.resolve(process.cwd(), "..", "supabase", "migrations");
  const latest = new Map<string, string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = readFileSync(path.join(dir, f), "utf8");
    for (const m of sql.matchAll(/create or replace function public\.(\w+)\(([\s\S]*?)\n\$\$;/g)) latest.set(m[1], m[2]);
  }
  const re = new RegExp(`api_err\\(\\d{3}, '${code}',\\s*'((?:[^']|'')*)'`, "g");
  return [...latest.values()].flatMap((body) => [...body.matchAll(re)].map((m) => m[1]));
}

describe("API key refusals name the remedy (CLAUDE.md rule 6)", () => {
  it("insufficient_balance says where to top up", () => {
    const msgs = lastMigrationMessages("insufficient_balance");
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m).toMatch(/Top up/);
  });
  // Was a bug (low, rule 6; #707 bug 9): the API key's two spend-limit refusals said what happened but not what to do
  // (0042_web_api_hardening.sql:533-541), and the MCP tool passes the sentence through, so the assistant could not tell
  // the developer where the limit is raised. 0147 restates api_create_video / api_request_download with the place.
  it.each(["monthly_limit_reached", "key_limit_reached"])("%s says where the limit is raised", (code) => {
    const msgs = lastMigrationMessages(code);
    expect(msgs.length).toBe(2); // a video and a download
    for (const m of msgs) expect(m).toMatch(/An owner or admin can raise .* in the Developer console: Developers → /);
  });
  it("the org limit names the Usage and billing tab, the key limit the key's own Set limit", () => {
    for (const m of lastMigrationMessages("monthly_limit_reached")) expect(m).toContain("Developers → Usage and billing → Monthly spend limit");
    for (const m of lastMigrationMessages("key_limit_reached")) expect(m).toContain("Developers → API keys → Set limit on this key");
  });
});

// ── JSON-RPC edges ─────────────────────────────────────────────────────────

describe("JSON-RPC edges a client can produce", () => {
  it("a batch of requests is answered with one response per id", async () => {
    const res = await raw([
      { jsonrpc: "2.0", id: "a", method: "tools/list" },
      { jsonrpc: "2.0", id: "b", method: "ping" },
    ]);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { id: string; result?: unknown }[];
    expect(out.map((o) => o.id).sort()).toEqual(["a", "b"]);
    expect(out.every((o) => o.result !== undefined)).toBe(true);
    // A batch that is not only tool calls is one counted key check.
    expect(db.calls.map((c) => c.fn)).toEqual(["api_auth"]);
  });

  it("OAuth: a batch of tool calls is one token check plus one counted call per tool", async () => {
    const res = await raw([toolCall("list_channels", {}, 1), toolCall("get_balance", {}, 2)], TOKEN);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { id: number; result: ToolOut }[];
    expect(out).toHaveLength(2);
    expect(db.calls.map((c) => c.fn).sort()).toEqual(["api_list_channels", "oauth_check", "oauth_get_balance"]);
  });

  it("a notification (no id) is accepted with 202 and no body, after the key is checked", async () => {
    const res = await raw({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(db.calls.map((c) => c.fn)).toEqual(["api_auth"]);
  });

  it("a notification with an unknown method is also accepted silently (JSON-RPC: never answered)", async () => {
    const res = await raw({ jsonrpc: "2.0", method: "notifications/whatever" });
    expect(res.status).toBe(202);
  });

  it.each(["resources/list", "prompts/list", "sampling/createMessage", "no/such/method"])("the unknown method %s is a JSON-RPC -32601, not a 500", async (method) => {
    const res = await raw({ jsonrpc: "2.0", id: 3, method });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 3, error: { code: -32601 } });
  });

  it("a call to an unknown tool is an error the client can read, and nothing is called", async () => {
    const res = await raw(toolCall("delete_everything", {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: ToolOut; error?: { code: number; message: string } };
    const msg = body.error?.message ?? text(body.result!);
    expect(body.error ? true : body.result!.isError).toBe(true);
    expect(msg).toMatch(/delete_everything/);
    expect(db.calls).toEqual([]);
  });

  it.each([
    ["params missing", { jsonrpc: "2.0", id: 4, method: "tools/call" }],
    ["name is a number", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: 123 } }],
    ["arguments is an array", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_channels", arguments: [1, 2] } }],
    ["arguments is a string", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_video", arguments: "channel_id=history-uz" } }],
  ])("tools/call with %s is a JSON-RPC error or a tool error, never a 500, and calls nothing", async (_l, body) => {
    const res = await raw(body);
    expect(res.status).toBeLessThan(500);
    const out = (await res.json()) as { result?: ToolOut; error?: { code: number } };
    expect(out.error !== undefined || out.result?.isError === true).toBe(true);
    expect(db.calls.filter((c) => c.fn !== "api_auth")).toEqual([]);
  });

  it("a body that is not JSON is a 400 with the API's envelope", async () => {
    const res = await raw("{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_body" } });
    expect(db.calls).toEqual([]);
  });

  it("a body over 256 kB is a 413 before any database call", async () => {
    const res = await raw(toolCall("create_video", { channel_id: "history-uz", topic: "x".repeat(300_000) }));
    expect(res.status).toBe(413);
    expect(db.calls).toEqual([]);
  });

  it("a JSON value that is not a JSON-RPC message is a client error, not a 500", async () => {
    for (const body of [42, "\"hello\"", "null", JSON.stringify({ jsonrpc: "1.0", id: 1, method: "tools/list" })]) {
      const res = await raw(typeof body === "number" ? String(body) : body);
      expect(res.status, String(body)).toBeGreaterThanOrEqual(400);
      expect(res.status, String(body)).toBeLessThan(500);
    }
  });

  // JSON-RPC 2.0 answers an empty batch with one Invalid Request error; the SDK transport sees no
  // request in it and answers 202. Harmless (one counted key check, nothing runs); pinned so a change is seen.
  it("an empty batch is accepted with nothing run, never a 500", async () => {
    const res = await raw("[]");
    expect(res.status).toBe(202);
    expect(db.calls.map((c) => c.fn)).toEqual(["api_auth"]);
  });

  it("API key: a database without the API functions says so as a 503 tool error, not a crash", async () => {
    const client = await connect(KEY);
    db.pgError.api_list_channels = { code: "PGRST202", message: "Could not find the function public.api_list_channels" };
    const r = await call(client, "list_channels");
    expect(r.isError).toBe(true);
    expect((json(r) as { error: unknown }).error).toMatchObject({ code: "api_unavailable" });
    expect(text(r)).not.toMatch(/PGRST|Could not find/);
    await client.close();
  });

  it("no credential at all: 401 with the OAuth challenge, nothing reaches the database", async () => {
    const res = await raw(initialize("2025-06-18"), null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata="/);
    expect(db.calls).toEqual([]);
  });
});
