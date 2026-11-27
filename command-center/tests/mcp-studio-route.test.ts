import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hashApiKey } from "@/lib/api/keys";
import { oauthEndpoints } from "@/lib/oauth/config";

/**
 * The five Studio tools of a connected assistant (migration 0191, scope studio:create) driven the way an assistant drives them:
 * JSON-RPC POSTs and the official SDK client, through the real POST handler of app/api/mcp/route.ts. Unlike
 * tests/mcp-oauth-creative.test.ts (buildMcpServer directly), everything between the HTTP request and the Supabase client is real
 * here: classifyBearer, hashApiKey, the real oauthCheck / oauthApiCaller / oauthRpc of lib/server/public-api.ts, the real media
 * signer and the route's own origin. Only `@supabase/supabase-js` is a fake, whose answers copy the shapes and codes of 0191's
 * functions (oauth_check, oauth_creative_models / _quote / _create / _get, oauth_media_list).
 *
 * What the database itself decides (another workspace's rows, the hold equal to the quote under the account lock, the exempt
 * workspace) is attacked against a real Postgres in tests/security/test_sec_mcp_oauth_creative.py; this pins what crosses the
 * route: which tools a grant is offered, what reaches the database (the token's hash, never the token; create sends nothing but
 * the quote's id and a key), and that every refusal names the remedy.
 */

vi.hoisted(() => {
  // lib/config reads these at import time: without them apiRpc answers "not configured" and oauth_check never runs.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://probe.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-probe";
});

const ORIGIN = "https://nightshift-ai.studio";
const MCP_URL = `${ORIGIN}/api/mcp`;
// Distinctive bodies, so a leak of either token anywhere is unmistakable in a response or a log line.
const RAW_A = "nso_at_" + "PROBEsecretA" + "q".repeat(31);
const RAW_B = "nso_at_" + "PROBEsecretB" + "w".repeat(31);
const SECRET_BODIES = [RAW_A, RAW_B, "PROBEsecretA", "PROBEsecretB"];
const ALL = ["videos:read", "videos:create", "videos:publish", "studio:create"];
const VIDEO_ONLY = ["videos:read", "videos:create", "videos:publish"];
const STUDIO_FIVE = ["list_creative_models", "list_media", "quote_creative", "create_creative", "get_creative_job"];
const KEY_STUDIO_FOUR = ["list_models", "quote_generation", "create_generation", "get_generation"];
const VIDEO_TOOLS = ["list_channels", "get_job_status", "list_videos", "get_video", "list_connected_accounts", "get_balance", "create_video", "publish_video"];
const ASSET = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const PROMPT = { prompt: "a lighthouse at dawn", aspect_ratio: "16:9" };

let HASH_A = "";
let HASH_B = "";

type Quote = { id: string; owner: string; capability: string; model: string; params: Record<string, unknown>; credits: number; expires: number; job: string | null };
type Job = { id: string; owner: string; quote: string; idem: string; credits: number; status: string };

const ok = (data: unknown, status = 200) => ({ ok: true, status, data });
const err = (status: number, code: string, message: string, details: Record<string, unknown> = {}) => ({ ok: false, status, error: { code, message, ...details } });

/** A fake of 0191 behind the Supabase client: grants, model states, the price list, quotes, jobs, the workspace's credits. */
const db = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  grants: new Map<string, { scopes: string[]; resource: string }>(),
  on: new Map<string, "ok" | "temporarily_off" | "not_offered">(),
  price: new Map<string, number>(),
  /** What the NS409 branch answers: a price moved inside create_creative_job (only quoted_credits in details). */
  ns409: false,
  quotes: new Map<string, unknown>(),
  jobs: new Map<string, unknown>(),
  credits: { balance: 50, reserved: 0, extraOff: false },
  limit: 100,
  spent: 0,
  next: 1,
  /** fn -> a PostgREST-level error (the database did not answer). */
  pgError: {} as Record<string, { code: string; message: string }>,
}));

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function stateRefusal(state: string, model: string) {
  if (state === "temporarily_off") return err(503, "model_temporarily_off", "That model is temporarily unavailable. Nothing was held or charged.", { model });
  return err(422, "model_not_offered", "That model is not offered to connected apps for this capability. Nothing was held or charged.", { model });
}

function answer(fn: string, a: Record<string, unknown>): unknown {
  if (fn === "oauth_check") {
    const g = db.grants.get(String(a.p_token_hash));
    return g ? ok({ resource: g.resource, scopes: g.scopes, entitled: true }) : err(401, "invalid_token", "unknown token");
  }
  // 0191's functions open with oauth_ctx(p_token_hash): an unknown hash (a raw token, an API key's hash) is no connection.
  const owner = String(a.p_token_hash ?? "");
  if (!db.grants.has(owner)) return err(401, "invalid_token", "unknown token");
  switch (fn) {
    case "oauth_creative_models":
      return ok({
        capability: a.p_capability ?? null,
        models: [...db.on].filter(([, s]) => s === "ok").map(([id]) => ({ id, capabilities: ["t2i"], aspect_ratios: ["16:9", "1:1"] })),
      });
    case "oauth_media_list":
      return ok({ kind: a.p_kind ?? null, media: [{ asset_id: ASSET, kind: "image", mime: "image/png", created_at: "2026-11-20T10:00:00Z" }] });
    case "oauth_creative_quote": {
      const model = String(a.p_model);
      const s = db.on.get(model) ?? "not_offered";
      if (s !== "ok") return stateRefusal(s, model);
      const id = uuid(db.next++);
      const q: Quote = { id, owner, capability: String(a.p_capability), model, params: a.p_params as Record<string, unknown>, credits: db.price.get(model) ?? 3, expires: Date.now() + 900_000, job: null };
      db.quotes.set(id, q);
      return ok({ quote_id: id, capability: q.capability, model, params: q.params, credits: q.credits, expires_at: new Date(q.expires).toISOString() }, 201);
    }
    case "oauth_creative_create": {
      const idem = String(a.p_idem_key);
      const jobs = [...db.jobs.values()] as Job[];
      const prior = jobs.find((j) => j.owner === owner && j.idem === idem);
      if (prior) {
        if (prior.quote !== a.p_quote_id) return err(422, "idempotency_key_reused", "reused");
        return { ...ok({ id: prior.id, status: "queued", quoted_credits: prior.credits }), replayed: true };
      }
      const q = db.quotes.get(String(a.p_quote_id)) as Quote | undefined;
      // Another connection's quote is no quote of this one.
      if (!q || q.owner !== owner) return err(404, "quote_not_found", "No quote with that id for this connection.");
      if (q.job) return err(409, "quote_used", "used", { job_id: q.job });
      const s = db.on.get(q.model) ?? "not_offered";
      if (s !== "ok") return stateRefusal(s, q.model);
      const now = db.price.get(q.model) ?? 3;
      if (now !== q.credits) return err(409, "price_changed", "The price changed since the quote. Nothing was held.", { quoted_credits: q.credits, price_credits: now });
      if (db.spent + q.credits > db.limit)
        return err(402, "connection_limit_reached", "This generation would take this connection past its monthly spending limit.", {
          limit_credits: db.limit, spent_credits: db.spent, price_credits: q.credits,
        });
      if (db.ns409) return err(409, "price_changed", "The price changed since the quote. Nothing was held.", { quoted_credits: q.credits });
      const available = Math.max(db.credits.balance - db.credits.reserved, 0);
      if (available < q.credits)
        return err(402, "insufficient_credits", "The workspace does not have enough credits for this generation. Nothing was held.", {
          available_credits: available, held_credits: db.credits.reserved, price_credits: q.credits, ...(db.credits.extraOff ? { extra_credits_off: true } : {}),
        });
      const id = uuid(1000 + db.next++);
      db.credits.reserved += q.credits;
      db.spent += q.credits;
      q.job = id;
      db.jobs.set(id, { id, owner, quote: q.id, idem, credits: q.credits, status: "completed" } satisfies Job);
      return ok({ id, status: "queued", quoted_credits: q.credits }, 201);
    }
    case "oauth_creative_get": {
      const j = db.jobs.get(String(a.p_job_id)) as Job | undefined;
      if (!j || j.owner !== owner) return err(404, "job_not_found", "No generation with that id for this connection.");
      return ok({
        id: j.id, status: j.status, quoted_credits: j.credits, charged_credits: j.credits, error_code: null,
        result_asset_ids: [ASSET], files: [{ asset_id: ASSET, kind: "image", mime: "image/png", width: 1920, height: 1080, variants: ["thumb"] }],
      });
    }
    default:
      // Any other function a connection's Studio call reached is a routing mistake; answer loudly.
      return err(500, "unexpected_function", `fake has no ${fn}`);
  }
}

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.calls.push({ fn, args });
      if (db.pgError[fn]) return { data: null, error: db.pgError[fn] };
      return { data: answer(fn, args), error: null };
    },
  }),
}));

const route = await import("@/app/api/mcp/route");
const { verifyMedia, mediaUrlSecret } = await import("@/lib/server/media");

// ── the assistant's side ───────────────────────────────────────────────────

function routeFetch(auth: string, bodies: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const headers = new Headers(req.headers);
    headers.set("authorization", auth);
    const body = req.method === "POST" ? await req.text() : undefined;
    const handler = (req.method === "POST" ? route.POST : req.method === "GET" ? route.GET : route.DELETE) as (r: Request) => Promise<Response> | Response;
    const res = await handler(new Request(req.url, { method: req.method, headers, body }));
    // Every byte the route sends back is kept, to look for the token in it.
    const text = await res.clone().text();
    bodies.push(text, JSON.stringify([...res.headers]));
    return res;
  }) as typeof fetch;
}

const seen: string[] = [];

async function connect(token: string = RAW_A) {
  const client = new Client({ name: "probe-assistant", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: routeFetch(`Bearer ${token}`, seen) }));
  return client;
}

type ToolOut = { isError?: boolean; content: { type: string; text: string }[] };

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as ToolOut;
  const text = r.content.map((c) => c.text).join("\n");
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { isError: r.isError === true, text, body };
}

/** A raw JSON-RPC POST to the route, for the protocol level and for what the SDK client would never send. */
async function raw(body: unknown, token: string = RAW_A): Promise<{ status: number; text: string; json: unknown }> {
  const res = await route.POST(
    new Request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-protocol-version": "2025-06-18" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  seen.push(text, JSON.stringify([...res.headers]));
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

const initialize = (id = 1) => ({
  jsonrpc: "2.0", id, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
});
const toolCall = (name: string, args: unknown, id: number | string = 7) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
type RpcResult = { result: { content: { text: string }[]; isError?: boolean } };

/** The database calls a tool made (not the per-request token check). */
const toolCalls = () => db.calls.filter((c) => c.fn !== "oauth_check");
const creates = () => db.calls.filter((c) => c.fn === "oauth_creative_create");

async function quote(client: Client, model = "img-on", params: Record<string, unknown> = PROMPT) {
  const q = await call(client, "quote_creative", { capability: "t2i", model, params });
  expect(q.isError, q.text).toBe(false);
  return q.body as { quote_id: string; credits: number };
}

// ── console capture: the raw token must never be logged ────────────────────

const logged: string[] = [];
const spies: ReturnType<typeof vi.spyOn>[] = [];

beforeAll(async () => {
  HASH_A = await hashApiKey(RAW_A);
  HASH_B = await hashApiKey(RAW_B);
});

beforeEach(() => {
  delete process.env.APP_ORIGIN;
  // The media library's signer is real: a secret of 32+ characters and a directory that exists.
  process.env.MEDIA_URL_SECRET = "probe-media-secret-" + "s".repeat(24);
  process.env.NIGHTSHIFT_MEDIA_DIR = mkdtempSync(path.join(tmpdir(), "probe-media-"));
  const resource = oauthEndpoints(ORIGIN).resource;
  db.calls = [];
  db.grants = new Map([
    [HASH_A, { scopes: [...ALL], resource }],
    [HASH_B, { scopes: [...ALL], resource }],
  ]);
  db.on = new Map([["img-on", "ok"], ["img-off-now", "temporarily_off"]]);
  db.price = new Map([["img-on", 4]]);
  db.ns409 = false;
  db.quotes = new Map();
  db.jobs = new Map();
  db.credits = { balance: 50, reserved: 0, extraOff: false };
  db.limit = 100;
  db.spent = 0;
  db.pgError = {};
  seen.length = 0;
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    spies.push(vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" "))));
});

afterEach(() => {
  // Every test, not one dedicated test: the token must not leak on any path (CLAUDE.md #1).
  const everything = [...seen, ...logged].join("\n");
  for (const s of SECRET_BODIES) expect(everything, `leaked ${s.slice(0, 7)}…`).not.toContain(s);
  for (const s of spies) s.mockRestore();
  spies.length = 0;
  delete process.env.APP_ORIGIN;
  delete process.env.MEDIA_URL_SECRET;
  delete process.env.NIGHTSHIFT_MEDIA_DIR;
});

// ── 1. who is offered what ─────────────────────────────────────────────────

describe("tools/list through the route: the grant decides the Studio tools", () => {
  it("initialize then tools/list with studio:create: the video tools plus exactly the five Studio tools, none of the API key's four", async () => {
    const init = await raw(initialize());
    expect(init.status).toBe(200);
    expect((init.json as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
    const list = await raw({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.status).toBe(200);
    const names = (list.json as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect([...names].sort()).toEqual([...VIDEO_TOOLS, ...STUDIO_FIVE].sort());
    for (const t of KEY_STUDIO_FOUR) expect(names, t).not.toContain(t);
    // The token was checked once per POST, by its hash, and nothing else reached the database.
    expect(db.calls.map((c) => c.fn)).toEqual(["oauth_check", "oauth_check"]);
    expect(db.calls.every((c) => c.args.p_token_hash === HASH_A)).toBe(true);
  });

  it("studio:create alone: exactly the five Studio tools, no video tool and none of the key's four", async () => {
    db.grants.get(HASH_A)!.scopes = ["studio:create"];
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect([...names].sort()).toEqual([...STUDIO_FIVE].sort());
    await client.close();
  });

  it("without studio:create: none of the five, and the instructions say the Studio permission is missing and how to give it", async () => {
    db.grants.get(HASH_A)!.scopes = [...VIDEO_ONLY];
    const init = await raw(initialize());
    const instructions = (init.json as { result: { instructions: string } }).result.instructions;
    expect(instructions).toMatch(/not given permission to [^.]*generate pictures and clips in the Studio/);
    expect(instructions).toMatch(/disconnect it and connect it again, allowing that/);
    // Nothing tells an assistant without the tools to call them.
    for (const t of STUDIO_FIVE) expect(instructions, t).not.toContain(t);
    const list = await raw({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (list.json as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    for (const t of [...STUDIO_FIVE, ...KEY_STUDIO_FOUR]) expect(names, t).not.toContain(t);
    expect([...names].sort()).toEqual([...VIDEO_TOOLS].sort());
  });

  // tests/mcp-assistant-session.test.ts pins "the instructions name only tools that are offered" for the video scopes (an
  // assistant told about a tool it lacks tells the person the server is broken); this extends it to grants with the Studio.
  async function toolsNamedButNotOffered(scopes: string[]): Promise<string[]> {
    db.grants.get(HASH_A)!.scopes = scopes;
    const client = await connect();
    const offered = new Set((await client.listTools()).tools.map((t) => t.name));
    const instructions = client.getInstructions() ?? "";
    await client.close();
    const named = [...VIDEO_TOOLS, ...STUDIO_FIVE, ...KEY_STUDIO_FOUR].filter((t) => new RegExp(`\\b${t}\\b`).test(instructions));
    return named.filter((t) => !offered.has(t));
  }

  it("all four scopes: the instructions name only tools this grant is offered", async () => {
    expect(await toolsNamedButNotOffered(ALL)).toEqual([]);
  });

  // Pinned bug, fixed in this PR: the Studio paragraph always ended "(only publish_video publishes …)", so a grant with
  // studio:create but not videos:publish was told about a tool it is not offered, and an assistant that cannot find it reports a
  // broken server.
  it.each([[["studio:create"]], [["videos:read", "studio:create"]], [["videos:create", "studio:create"]]])(
    "scopes %j: the instructions name only tools this grant is offered (publish_video is named without videos:publish)",
    async (scopes) => {
      expect(await toolsNamedButNotOffered(scopes)).toEqual([]);
    },
  );

  it("a token whose connection was issued for another resource is a 401 and reaches no Studio function", async () => {
    db.grants.get(HASH_A)!.resource = "https://evil.example/api/mcp";
    const r = await raw(toolCall("list_creative_models", {}));
    expect(r.status).toBe(401);
    expect(r.text).toMatch(/invalid_token/);
    expect(toolCalls()).toEqual([]);
  });
});

// ── 2. the happy path ──────────────────────────────────────────────────────

describe("tools/call through the route: list, quote, create, get", () => {
  it("each call reaches its oauth_creative_* function with the token's hash, never the raw token; create sends only quote id and key", async () => {
    const client = await connect();

    const models = await call(client, "list_creative_models", { capability: "t2i" });
    expect(models.isError, models.text).toBe(false);
    expect((models.body as { models: { id: string }[] }).models.map((m) => m.id)).toEqual(["img-on"]);

    const media = await call(client, "list_media", { kind: "image", limit: 5 });
    expect(media.isError, media.text).toBe(false);

    const q = await quote(client);
    expect(q.credits).toBe(4);

    const c = await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "conv-1-gen-1" });
    expect(c.isError, c.text).toBe(false);
    const jobId = (c.body as { id: string }).id;

    const g = await call(client, "get_creative_job", { job_id: jobId });
    expect(g.isError, g.text).toBe(false);
    await client.close();

    expect(toolCalls().map((x) => x.fn)).toEqual(["oauth_creative_models", "oauth_media_list", "oauth_creative_quote", "oauth_creative_create", "oauth_creative_get"]);
    for (const x of db.calls) {
      expect(x.args.p_token_hash, x.fn).toBe(HASH_A);
      expect(x.args, x.fn).not.toHaveProperty("p_key_hash");
      expect(JSON.stringify(x.args), x.fn).not.toContain("PROBEsecret");
    }
    // The API key's Studio doors are never reached by a connection.
    expect(db.calls.some((x) => /^api_/.test(x.fn))).toBe(false);

    const [create] = creates();
    expect(Object.keys(create.args).sort()).toEqual(["p_idem_key", "p_quote_id", "p_request_id", "p_token_hash"]);
    expect(create.args).toMatchObject({ p_quote_id: q.quote_id, p_idem_key: "conv-1-gen-1" });
    expect(create.args.p_request_id).toMatch(/^req_/);
    expect(db.calls.find((x) => x.fn === "oauth_creative_quote")!.args).toMatchObject({ p_capability: "t2i", p_model: "img-on", p_params: PROMPT });
    expect(db.calls.find((x) => x.fn === "oauth_media_list")!.args).toMatchObject({ p_kind: "image", p_limit: 5 });
    expect(db.spent).toBe(4);
    // The leak check in afterEach reads what the route really sent back (not an empty capture).
    expect(seen.join("\n")).toContain(q.quote_id);
  });

  it("get_creative_job carries absolute links on this deployment's origin, signed for that asset and that file, that verify", async () => {
    const client = await connect();
    const q = await quote(client);
    const jobId = ((await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "files-1" })).body as { id: string }).id;
    const g = await call(client, "get_creative_job", { job_id: jobId });
    await client.close();
    const files = (g.body as { files: { url: string | null; thumbnail_url: string | null; asset_id: string }[]; files_note?: string }).files;
    expect(files).toHaveLength(1);
    expect(g.body).not.toHaveProperty("files_note");
    const secret = mediaUrlSecret()!;
    for (const [link, variant] of [[files[0].url, "original"], [files[0].thumbnail_url, "thumb"]] as const) {
      expect(link, variant).not.toBeNull();
      const u = new URL(link!);
      expect(u.origin).toBe(ORIGIN);
      expect(u.pathname).toBe(`/api/media/file/${ASSET}/${variant}`);
      const verdict = verifyMedia(secret, { id: ASSET, variant, mime: u.searchParams.get("t"), exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig") });
      expect(verdict, variant).toBe("ok");
    }
  });

  it("the links use APP_ORIGIN, never the request's Host: a forged Host cannot point an assistant at another server", async () => {
    process.env.APP_ORIGIN = "https://studio.example.org";
    db.grants.get(HASH_A)!.resource = oauthEndpoints("https://studio.example.org").resource;
    const client = await connect();
    const q = await quote(client);
    const jobId = ((await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "origin-1" })).body as { id: string }).id;
    const g = await call(client, "get_creative_job", { job_id: jobId });
    await client.close();
    const url = (g.body as { files: { url: string }[] }).files[0].url;
    expect(new URL(url).origin).toBe("https://studio.example.org");
    expect(url).not.toContain("nightshift-ai.studio");
  });

  it("a server without a media signing secret says the links are unavailable, never hands out an unsigned path", async () => {
    delete process.env.MEDIA_URL_SECRET;
    const client = await connect();
    const q = await quote(client);
    const jobId = ((await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "nosig-1" })).body as { id: string }).id;
    const g = await call(client, "get_creative_job", { job_id: jobId });
    await client.close();
    const body = g.body as { files: { url: string | null }[]; files_note: string };
    expect(body.files[0].url).toBeNull();
    expect(body.files_note).toMatch(/cannot hand out file links right now/);
  });

  it("an Uzbek/Cyrillic prompt with an emoji reaches the quote exactly as typed", async () => {
    const client = await connect();
    const params = { prompt: "Oʻzbekiston: Амир Темур ва Самарқанд — tarix 🏛", aspect_ratio: "16:9" };
    await quote(client, "img-on", params);
    await client.close();
    expect(db.calls.find((x) => x.fn === "oauth_creative_quote")!.args.p_params).toEqual(params);
  });

  it("an empty model list for assistants says why, never that the Studio has no models", async () => {
    db.on = new Map();
    const client = await connect();
    const r = await call(client, "list_creative_models", {});
    await client.close();
    expect(r.isError).toBe(false);
    expect((r.body as { models: unknown[] }).models).toEqual([]);
    expect((r.body as { models_note: string }).models_note).toMatch(/only once its terms allow it/);
  });

  it("a duplicate submit (two creates with one key in one batch) makes one generation and holds once", async () => {
    const client = await connect();
    const q = await quote(client);
    await client.close();
    const args = { quote_id: q.quote_id, idempotency_key: "double-click" };
    const res = await raw([toolCall("create_creative", args, 1), toolCall("create_creative", args, 2)]);
    expect(res.status).toBe(200);
    const out = res.json as RpcResult[];
    expect(out).toHaveLength(2);
    const ids = out.map((o) => JSON.parse(o.result.content[0].text).id);
    expect(ids[0]).toBe(ids[1]);
    expect(db.jobs.size).toBe(1);
    expect(db.spent).toBe(4);
    expect(db.credits.reserved).toBe(4);
  });
});

// ── 2b. isolation between two connections, request by request ─────────────

describe("two connections through the same route: each request is its own caller", () => {
  it("connection B cannot read A's generation or spend A's quote; each call carried its own token's hash", async () => {
    const a = await connect(RAW_A);
    const q = await quote(a);
    const jobId = ((await call(a, "create_creative", { quote_id: q.quote_id, idempotency_key: "a-1" })).body as { id: string }).id;
    await a.close();

    const b = await connect(RAW_B);
    const read = await call(b, "get_creative_job", { job_id: jobId });
    expect(read.isError).toBe(true);
    expect(read.text).toMatch(/Only generations this connection started can be read here/);
    const spend = await call(b, "create_creative", { quote_id: q.quote_id, idempotency_key: "b-1" });
    expect(spend.isError).toBe(true);
    expect(spend.text).toMatch(/no quote with that id for this connection/i);
    expect(spend.text).not.toContain(ASSET);
    await b.close();

    const byB = db.calls.filter((c) => c.fn === "oauth_creative_get" || (c.fn === "oauth_creative_create" && c.args.p_idem_key === "b-1"));
    expect(byB.map((c) => c.args.p_token_hash)).toEqual([HASH_B, HASH_B]);
    expect(db.jobs.size).toBe(1);
    expect(db.spent).toBe(4);
  });
});

// ── 3. the create schema ───────────────────────────────────────────────────

describe("create_creative's schema refuses what a quote already fixed, before any database call", () => {
  it.each([
    ["a model", { model: "img-other" }],
    ["params", { params: { prompt: "something else" } }],
    ["max_credits", { max_credits: 0 }],
    ["a capability", { capability: "t2v" }],
    ["model, params and max_credits together", { model: "img-other", params: { prompt: "x" }, max_credits: 1 }],
  ])("create with %s on top of quote_id and key: a tool error, no oauth_creative_create", async (_label, extra) => {
    const client = await connect();
    const q = await quote(client);
    db.calls = [];
    const r = await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "crafted", ...extra });
    await client.close();
    expect(r.isError).toBe(true);
    for (const k of Object.keys(extra)) expect(r.text, k).toContain(k);
    expect(toolCalls()).toEqual([]);
    expect(db.spent).toBe(0);
  });

  it.each([
    ["no idempotency_key", (id: string) => ({ quote_id: id })],
    ["an empty idempotency_key", (id: string) => ({ quote_id: id, idempotency_key: "" })],
    ["an idempotency_key with spaces", (id: string) => ({ quote_id: id, idempotency_key: "has spaces" })],
    ["a 300-character idempotency_key", (id: string) => ({ quote_id: id, idempotency_key: "k".repeat(300) })],
    ["a quote_id that is not a uuid", () => ({ quote_id: "q-1", idempotency_key: "k" })],
    ["no quote_id", () => ({ idempotency_key: "k" })],
  ])("create with %s: refused by the schema, nothing reaches the database", async (_label, build) => {
    const client = await connect();
    const q = await quote(client);
    db.calls = [];
    const r = await call(client, "create_creative", build(q.quote_id));
    await client.close();
    expect(r.isError).toBe(true);
    expect(toolCalls()).toEqual([]);
  });

  it("a request body over the route's size limit is a 413 before any Studio function (a 300 000-character prompt)", async () => {
    const r = await raw(toolCall("quote_creative", { capability: "t2i", model: "img-on", params: { prompt: "x".repeat(300_000) } }));
    expect(r.status).toBe(413);
    expect(toolCalls()).toEqual([]);
  });

  it("malformed JSON is a 400 before any Studio function", async () => {
    const r = await raw('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_creative"');
    expect(r.status).toBe(400);
    expect(toolCalls()).toEqual([]);
  });
});

// ── 4. a grant without studio:create ───────────────────────────────────────

describe("a grant without studio:create that calls a Studio tool anyway", () => {
  it.each(STUDIO_FIVE)("%s: isError naming studio:create and the reconnect remedy, and no database call", async (name) => {
    db.grants.get(HASH_A)!.scopes = [...VIDEO_ONLY];
    const args: Record<string, Record<string, unknown>> = {
      list_creative_models: {}, list_media: {},
      quote_creative: { capability: "t2i", model: "img-on", params: PROMPT },
      create_creative: { quote_id: uuid(1), idempotency_key: "k" },
      get_creative_job: { job_id: uuid(1001) },
    };
    const r = await raw(toolCall(name, args[name]));
    expect(r.status).toBe(200);
    const result = (r.json as RpcResult).result;
    expect(result.isError).toBe(true);
    const t = result.content[0].text;
    expect(t).toContain('"studio:create" permission');
    expect(t).toMatch(/connect it again, allowing that permission/);
    expect(t).toContain(`${ORIGIN}/developers`);
    // Not the SDK's "tool not found", which reads as a broken server.
    expect(t).not.toMatch(/not found/i);
    expect(toolCalls()).toEqual([]);
  });
});

// ── 5. refusals name the remedy ────────────────────────────────────────────

describe("Studio refusals through the route name the next step, and nothing is charged", () => {
  it("price_changed (the price moved after the quote): both numbers, quote again, confirm with the person", async () => {
    const client = await connect();
    const q = await quote(client);
    db.price.set("img-on", 6);
    const r = await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "moved" });
    await client.close();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/price changed since the quote \(it was 4 credits and is now 6\)/);
    expect(r.text).toContain("Nothing was started and nothing was charged");
    expect(r.text).toContain("Call quote_creative again");
    expect(r.text).toMatch(/create only if they agree/);
    expect(db.spent).toBe(0);
    expect(db.credits.reserved).toBe(0);
  });

  it("price_changed from inside the job start (0191's NS409 branch, no new price in it): still the remedy, no invented number", async () => {
    db.ns409 = true;
    const client = await connect();
    const q = await quote(client);
    const r = await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "ns409" });
    await client.close();
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Call quote_creative again");
    // CLAUDE.md #5: an unknown new price is not rendered as a number.
    expect(r.text).not.toMatch(/is now/);
    expect(r.text).not.toMatch(/undefined|NaN|\?/);
  });

  it("connection_limit_reached: the connection's numbers, only the person can raise it, and where", async () => {
    db.limit = 5;
    db.spent = 3;
    const client = await connect();
    const q = await quote(client);
    const r = await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "over" });
    await client.close();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/limit 5 credits, 3 used this month, and this generation needs 4/);
    expect(r.text).toContain("Only the person can raise it");
    expect(r.text).toContain(`${ORIGIN}/developers`);
    expect(r.text).toContain("You cannot change it");
    expect(db.spent).toBe(3);
  });

  it("model_not_offered at quote: pick another from list_creative_models, or use it in the Studio", async () => {
    const client = await connect();
    const r = await call(client, "quote_creative", { capability: "t2i", model: "img-not-for-apps", params: PROMPT });
    await client.close();
    expect(r.isError).toBe(true);
    expect(r.text).toContain("The model img-not-for-apps is not offered to connected apps");
    expect(r.text).toContain("nothing was quoted or charged");
    expect(r.text).toContain("Call list_creative_models and pick one it lists");
    expect(r.text).toContain(`${ORIGIN}/studio`);
  });

  it("model_temporarily_off at quote: another model or later, not 'not offered'", async () => {
    const client = await connect();
    const r = await call(client, "quote_creative", { capability: "t2i", model: "img-off-now", params: PROMPT });
    await client.close();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/switched off for now/);
    expect(r.text).toMatch(/try again later/);
    expect(r.text).not.toMatch(/not offered/);
  });

  it("insufficient credits: what it needs, what there is, what is held, both links, and no reconnecting", async () => {
    db.credits = { balance: 5, reserved: 2, extraOff: false };
    const client = await connect();
    const q = await quote(client);
    const r = await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "broke" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Not enough credits to start this generation");
    expect(r.text).toContain("needs 4 credits");
    expect(r.text).toContain("3 available");
    expect(r.text).toContain("2 more are set aside");
    expect(r.text).toContain(`${ORIGIN}/credits`);
    expect(r.text).toContain(`${ORIGIN}/pricing`);
    expect(r.text).toMatch(/no need to connect the app again/);
    expect(r.text).not.toMatch(/cents|\$/);
    expect(db.spent).toBe(0);

    // The person buys credits; the same quote and key now go through on the same connection.
    db.credits.balance = 50;
    const again = await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "broke" });
    await client.close();
    expect(again.isError, again.text).toBe(false);
    expect(db.jobs.size).toBe(1);
  });

  it("insufficient credits with extra credits switched off: says so and where to turn them on", async () => {
    db.credits = { balance: 0, reserved: 0, extraOff: true };
    const client = await connect();
    const q = await quote(client);
    const r = await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "extra-off" });
    await client.close();
    expect(r.text).toMatch(/Extra credits are turned off/);
    expect(r.text).toContain(`${ORIGIN}/usage`);
    expect(r.text).toMatch(/new generations/);
  });

  it("the database not answering at create: whether it started is unknown, so retry with the SAME quote_id and key", async () => {
    const client = await connect();
    const q = await quote(client);
    db.pgError.oauth_creative_create = { code: "08006", message: "connection to 10.0.0.5:5432 failed password=hunter2" };
    const r = await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "flaky" });
    await client.close();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Whether a generation started is not known/);
    expect(r.text).toMatch(/SAME quote_id and idempotency_key/);
    expect(r.text).toMatch(/never a new key/);
    expect(r.text).not.toMatch(/10\.0\.0\.5|5432|hunter2|08006/);
  });

  it("the database missing 0191 on a read: a tool error that says nothing was charged and leaks no function or PostgREST code", async () => {
    db.pgError.oauth_creative_models = { code: "PGRST202", message: "Could not find the function public.oauth_creative_models" };
    const client = await connect();
    const r = await call(client, "list_creative_models", {});
    await client.close();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Nothing was started or charged/);
    expect(r.text).not.toMatch(/PGRST|public\.oauth_creative_models|migration/);
  });

  it("a quote of another capability than the list offers is refused by the schema, not by the database", async () => {
    const client = await connect();
    db.calls = [];
    const r = await call(client, "quote_creative", { capability: "make_me_rich", model: "img-on", params: PROMPT });
    await client.close();
    expect(r.isError).toBe(true);
    expect(r.text).toContain("capability");
    expect(toolCalls()).toEqual([]);
  });
});
