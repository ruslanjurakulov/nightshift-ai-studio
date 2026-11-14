import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiCaller, Rpc } from "@/lib/api/operations";
import { buildMcpServer, OAUTH_STUDIO_TOOL_NAMES, STUDIO_TOOL_NAMES, TOOL_NAMES } from "@/lib/api/mcp";
import { OAUTH_TOOL_SCOPES, oauthRefusalText, oauthRpc } from "@/lib/api/mcp-oauth";
import { OAUTH_SCOPES } from "@/lib/oauth/config";

/**
 * The Studio for a connected assistant (migration 0176), through the real MCP server, the real operations and the real oauthRpc,
 * with a small fake of 0176's functions. What the database itself decides (another workspace's file, another connection's quote,
 * the hold equal to the quote, the monthly limit under the account lock) is attacked against a real Postgres in
 * tests/security/test_sec_mcp_oauth_creative.py; this pins what the assistant is offered and told: an OAuth connection with
 * studio:create gets five tools an API key never gets, create sends nothing but the quote's id and an idempotency key, and every
 * refusal says what to do next.
 */

const TOKEN_HASH = "c".repeat(64);
const ORIGIN = "https://nightshift-ai.studio";
const ALL = ["videos:read", "videos:create", "videos:publish", "studio:create"];
const PROMPT = { prompt: "a lighthouse at dawn", aspect_ratio: "16:9" };
const ASSET = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

type Quote = { id: string; capability: string; model: string; params: Record<string, unknown>; credits: number; expires: number; job: string | null };

const ok = (data: unknown, status = 200) => ({ ok: true, status, data });
const err = (status: number, code: string, message: string, details: Record<string, unknown> = {}) => ({ ok: false, status, error: { code, message, ...details } });

/** A fake of 0176: which models are switched on, the price list, the quotes, the jobs, the connection's limit. */
const db = {
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  on: new Map<string, "ok" | "acknowledgement_required" | "not_offered">(),
  price: new Map<string, number>(),
  quotes: new Map<string, Quote>(),
  jobs: new Map<string, { id: string; quote: string; idem: string; credits: number }>(),
  limit: 100,
  spent: 0,
  next: 1,
};

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function state(model: string) {
  return db.on.get(model) ?? "not_offered";
}

function refusal(s: string, model: string) {
  if (s === "acknowledgement_required") return err(428, "acknowledgement_required", "needs the Studio", { model });
  return err(422, "model_not_offered", "not offered", { model });
}

const fake: Rpc = async (fn, args) => {
  db.calls.push({ fn, args });
  if (!("p_token_hash" in args)) return { data: err(401, "invalid_api_key", "unknown"), error: null };
  switch (fn) {
    case "oauth_creative_models":
      return {
        data: ok({ capability: args.p_capability ?? null, models: [...db.on].filter(([, s]) => s === "ok").map(([id]) => ({ id, capabilities: ["t2i"] })) }),
        error: null,
      };
    case "oauth_media_list":
      return { data: ok({ kind: args.p_kind ?? null, media: [{ asset_id: ASSET, kind: "image", mime: "image/png" }] }), error: null };
    case "oauth_creative_quote": {
      const model = String(args.p_model);
      const s = state(model);
      if (s !== "ok") return { data: refusal(s, model), error: null };
      const id = uuid(db.next++);
      const q: Quote = { id, capability: String(args.p_capability), model, params: args.p_params as Record<string, unknown>, credits: db.price.get(model) ?? 3, expires: Date.now() + 900_000, job: null };
      db.quotes.set(id, q);
      return { data: ok({ quote_id: id, capability: q.capability, model, params: q.params, credits: q.credits, expires_at: new Date(q.expires).toISOString() }, 201), error: null };
    }
    case "oauth_creative_create": {
      const idem = String(args.p_idem_key);
      const prior = [...db.jobs.values()].find((j) => j.idem === idem);
      if (prior) {
        if (prior.quote !== args.p_quote_id) return { data: err(422, "idempotency_key_reused", "reused"), error: null };
        return { data: ok({ id: prior.id, status: "queued", quoted_credits: prior.credits, replayed: true }), error: null };
      }
      const q = db.quotes.get(String(args.p_quote_id));
      if (!q) return { data: err(404, "quote_not_found", "no quote"), error: null };
      if (q.job) return { data: err(409, "quote_used", "used", { job_id: q.job }), error: null };
      if (q.expires <= Date.now()) return { data: err(409, "quote_expired", "expired"), error: null };
      const s = state(q.model);
      if (s !== "ok") return { data: refusal(s, q.model), error: null };
      const now = db.price.get(q.model) ?? 3;
      if (now !== q.credits) return { data: err(409, "price_changed", "changed", { quoted_credits: q.credits, price_credits: now }), error: null };
      if (db.spent + q.credits > db.limit)
        return { data: err(402, "connection_limit_reached", "limit", { limit_credits: db.limit, spent_credits: db.spent, price_credits: q.credits }), error: null };
      const id = uuid(1000 + db.next++);
      db.spent += q.credits;
      q.job = id;
      db.jobs.set(id, { id, quote: q.id, idem, credits: q.credits });
      return { data: ok({ id, status: "queued", quoted_credits: q.credits }, 201), error: null };
    }
    case "oauth_creative_get": {
      const j = db.jobs.get(String(args.p_job_id));
      if (!j) return { data: err(404, "job_not_found", "none"), error: null };
      return { data: ok({ id: j.id, status: "completed", quoted_credits: j.credits, result_asset_ids: [ASSET], files: [{ asset_id: ASSET, kind: "image", mime: "image/png", variants: ["thumb"] }] }), error: null };
    }
    default:
      return { data: ok({}), error: null };
  }
};

function caller(): ApiCaller {
  return {
    keyHash: TOKEN_HASH,
    requestId: "req_t",
    rpc: oauthRpc(fake),
    backend: "queue",
    downloads: false,
    mediaLink: (id, variant, mime) => `${ORIGIN}/api/media/file/${id}/${variant}?t=${encodeURIComponent(mime)}&exp=1&sig=s`,
  };
}

async function connect(scopes: string[] | null) {
  const server = buildMcpServer(caller(), scopes === null ? undefined : { scopes, origin: ORIGIN });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return { client, instructions: client.getInstructions() ?? "" };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content[0]?.text ?? "";
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { isError: r.isError === true, text, body };
}

const created = () => db.calls.filter((c) => c.fn === "oauth_creative_create");

beforeEach(() => {
  db.calls = [];
  db.on = new Map([["img-on", "ok"], ["img-ack", "acknowledgement_required"]]);
  db.price = new Map([["img-on", 4]]);
  db.quotes = new Map();
  db.jobs = new Map();
  db.limit = 100;
  db.spent = 0;
});

describe("who is offered the Studio over MCP", () => {
  it("an OAuth connection with studio:create gets the five Studio tools, and never the API key's four", async () => {
    const { client } = await connect(ALL);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of OAUTH_STUDIO_TOOL_NAMES) expect(names, t).toContain(t);
    for (const t of STUDIO_TOOL_NAMES) expect(names, t).not.toContain(t);
  });

  it("a connection without studio:create is not offered them, and a call to one names the permission to give", async () => {
    const { client, instructions } = await connect(["videos:read", "videos:create", "videos:publish"]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of OAUTH_STUDIO_TOOL_NAMES) expect(names, t).not.toContain(t);
    const r = await call(client, "quote_creative", { capability: "t2i", model: "img-on", params: PROMPT });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"studio:create" permission');
    expect(db.calls).toEqual([]);
    expect(instructions).toContain("generate pictures and clips in the Studio");
  });

  it("an API key keeps exactly its own tools: none of the connection's five", async () => {
    const { client } = await connect(null);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual([...TOOL_NAMES]);
    for (const t of OAUTH_STUDIO_TOOL_NAMES) expect(names, t).not.toContain(t);
  });

  it("the permission is a new one: every tool of the five needs studio:create, and it is advertised", () => {
    for (const t of OAUTH_STUDIO_TOOL_NAMES) expect(OAUTH_TOOL_SCOPES[t]).toBe("studio:create");
    expect(OAUTH_SCOPES).toContain("studio:create");
  });

  it("the instructions and the create tool tell the assistant to show the price and get a confirmation first", async () => {
    const { client, instructions } = await connect(ALL);
    expect(instructions).toMatch(/ALWAYS tell the person that price and get their confirmation before create_creative/);
    const create = (await client.listTools()).tools.find((t) => t.name === "create_creative");
    expect(create?.description).toMatch(/Only call it after the person saw the quoted price and agreed/);
    const quote = (await client.listTools()).tools.find((t) => t.name === "quote_creative");
    expect(quote?.description).toMatch(/Tell the person the price and ask them to confirm/);
  });
});

describe("quote, then create", () => {
  it("create spends the quote: it sends only the quote id and the idempotency key, never a model, params or a price", async () => {
    const { client } = await connect(ALL);
    const q = await call(client, "quote_creative", { capability: "t2i", model: "img-on", params: PROMPT });
    expect(q.isError).toBe(false);
    const quote = q.body as { quote_id: string; credits: number };
    expect(quote.credits).toBe(4);
    const c = await call(client, "create_creative", { quote_id: quote.quote_id, idempotency_key: "gen-1" });
    expect(c.isError).toBe(false);
    expect(created()).toHaveLength(1);
    expect(created()[0].args).toEqual({ p_token_hash: TOKEN_HASH, p_quote_id: quote.quote_id, p_idem_key: "gen-1", p_request_id: "req_t" });
    expect(db.spent).toBe(4);
  });

  it("a crafted create that carries params, a model or a price is refused before the database", async () => {
    const { client } = await connect(ALL);
    const q = await call(client, "quote_creative", { capability: "t2i", model: "img-on", params: PROMPT });
    const id = (q.body as { quote_id: string }).quote_id;
    for (const extra of [{ params: { prompt: "something else" } }, { model: "img-ack" }, { max_credits: 0 }, { capability: "t2v" }]) {
      const r = await call(client, "create_creative", { quote_id: id, idempotency_key: "gen-x", ...extra });
      expect(r.isError, JSON.stringify(extra)).toBe(true);
    }
    expect(created()).toEqual([]);
  });

  it("the same idempotency key creates once; another quote with that key is refused", async () => {
    const { client } = await connect(ALL);
    const q1 = (await call(client, "quote_creative", { capability: "t2i", model: "img-on", params: PROMPT })).body as { quote_id: string };
    const a = await call(client, "create_creative", { quote_id: q1.quote_id, idempotency_key: "same" });
    const b = await call(client, "create_creative", { quote_id: q1.quote_id, idempotency_key: "same" });
    expect((a.body as { id: string }).id).toBe((b.body as { id: string }).id);
    expect((b.body as { replayed: boolean }).replayed).toBe(true);
    expect(db.spent).toBe(4);
    const q2 = (await call(client, "quote_creative", { capability: "t2i", model: "img-on", params: PROMPT })).body as { quote_id: string };
    const c = await call(client, "create_creative", { quote_id: q2.quote_id, idempotency_key: "same" });
    expect(c.isError).toBe(true);
    expect(c.text).toContain("already used with a different quote");
    expect(db.spent).toBe(4);
  });

  it("a quote pays once: a second key for the same quote is told it was used, and where the generation is", async () => {
    const { client } = await connect(ALL);
    const q = (await call(client, "quote_creative", { capability: "t2i", model: "img-on", params: PROMPT })).body as { quote_id: string };
    await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "k1" });
    const again = await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "k2" });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already paid for a generation/);
    expect(again.text).toContain("get_creative_job");
  });

  it("no create without a quote: an id that is no quote of this connection says to quote first", async () => {
    const { client } = await connect(ALL);
    const r = await call(client, "create_creative", { quote_id: uuid(999), idempotency_key: "k" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no quote with that id for this connection/i);
    expect(r.text).toContain("quote_creative");
  });

  it("an idempotency key is required", async () => {
    const { client } = await connect(ALL);
    const r = await call(client, "create_creative", { quote_id: uuid(1) });
    expect(r.isError).toBe(true);
    expect(created()).toEqual([]);
  });
});

describe("expiry and a moved price", () => {
  it("an expired quote is refused with the next step: quote again and confirm", async () => {
    const { client } = await connect(ALL);
    const q = (await call(client, "quote_creative", { capability: "t2i", model: "img-on", params: PROMPT })).body as { quote_id: string };
    db.quotes.get(q.quote_id)!.expires = Date.now() - 1;
    const r = await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "late" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/quote has expired/);
    expect(r.text).toMatch(/tell the person the price/);
    expect(db.spent).toBe(0);
  });

  it("a price that changed since the quote is refused as price_changed, with both numbers, and nothing is spent", async () => {
    const { client } = await connect(ALL);
    const q = (await call(client, "quote_creative", { capability: "t2i", model: "img-on", params: PROMPT })).body as { quote_id: string };
    db.price.set("img-on", 6);
    const r = await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "moved" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/price changed since the quote \(it was 4 credits and is now 6\)/);
    expect(r.text).toContain("Call quote_creative again");
    expect(db.spent).toBe(0);
  });
});

describe("limits and models", () => {
  it("the connection's monthly spending limit refuses a generation, says who can raise it, and nothing is charged", async () => {
    db.limit = 5;
    db.spent = 3;
    const { client } = await connect(ALL);
    const q = (await call(client, "quote_creative", { capability: "t2i", model: "img-on", params: PROMPT })).body as { quote_id: string };
    const r = await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "over" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("monthly spending limit");
    expect(r.text).toContain("this generation needs 4");
    expect(r.text).toContain(`${ORIGIN}/developers`);
    expect(r.text).toContain("Nothing was started and nothing was charged");
    expect(db.spent).toBe(3);
  });

  it("a model that is off for assistants is refused with the remedy: pick from the list, or use the Studio", async () => {
    const { client } = await connect(ALL);
    const r = await call(client, "quote_creative", { capability: "t2i", model: "img-off", params: PROMPT });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not offered to connected apps");
    expect(r.text).toContain("list_creative_models");
    expect(r.text).toContain(`${ORIGIN}/studio`);
  });

  it("a model that needs a rights acknowledgement is refused with 'confirm in the Studio', never acknowledged by the assistant", async () => {
    const { client } = await connect(ALL);
    const r = await call(client, "quote_creative", { capability: "i2v", model: "img-ack", params: { ...PROMPT, source_asset_id: ASSET } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/needs the person to confirm, in the Studio/);
    expect(r.text).toMatch(/cannot give that confirmation for them/);
    expect(r.text).toContain(`${ORIGIN}/studio`);
  });

  it("the 0174 refusal from inside the job start maps to the same text", () => {
    const text = oauthRefusalText({ ok: false, status: 428, code: "acknowledgement_required", message: "", details: { model: "x" } }, ORIGIN, { studio: "create" });
    expect(text).toMatch(/confirm, in the Studio/);
  });

  it("an empty model list says why (no model allows it yet), never that the Studio has none", async () => {
    db.on = new Map();
    const { client } = await connect(ALL);
    const r = await call(client, "list_creative_models", {});
    expect(r.isError).toBe(false);
    const data = r.body as { models: unknown[]; models_note: string };
    expect(data.models).toEqual([]);
    expect(data.models_note).toMatch(/only once its terms allow it/);
  });

  it("list_media lists the workspace's files and get_creative_job gives absolute, signed file links", async () => {
    const { client } = await connect(ALL);
    const m = await call(client, "list_media", { kind: "image" });
    expect(db.calls.at(-1)).toEqual({ fn: "oauth_media_list", args: { p_token_hash: TOKEN_HASH, p_kind: "image", p_limit: null, p_request_id: "req_t" } });
    expect(m.isError).toBe(false);
    const q = (await call(client, "quote_creative", { capability: "t2i", model: "img-on", params: PROMPT })).body as { quote_id: string };
    const c = (await call(client, "create_creative", { quote_id: q.quote_id, idempotency_key: "files" })).body as { id: string };
    const g = await call(client, "get_creative_job", { job_id: c.id });
    const files = (g.body as { files: { url: string }[] }).files;
    expect(files[0].url.startsWith(`${ORIGIN}/api/media/file/${ASSET}/original?`)).toBe(true);
  });

  it("a routed mode is not an assistant's: it names one model", async () => {
    const { client } = await connect(ALL);
    const r = await call(client, "quote_creative", { capability: "t2i", model: "img-on", params: PROMPT, mode: "cheap" });
    expect(r.isError).toBe(true);
    expect(db.calls.filter((x) => x.fn === "oauth_creative_quote")).toEqual([]);
  });
});

describe("the database door", () => {
  it("oauthRpc sends 0176's functions with the token hash, and still refuses the API key's creative functions", async () => {
    const seen: string[] = [];
    const rpc = oauthRpc(async (fn, args) => {
      seen.push(`${fn}:${Object.keys(args).join(",")}`);
      return { data: ok({}), error: null };
    });
    await rpc("oauth_creative_quote", { p_key_hash: TOKEN_HASH, p_capability: "t2i" });
    expect(seen).toEqual(["oauth_creative_quote:p_token_hash,p_capability"]);
    for (const fn of ["api_creative_quote", "api_creative_create", "api_creative_models", "api_creative_job_files"]) {
      const r = await rpc(fn, { p_key_hash: TOKEN_HASH });
      expect((r.data as { error: { code: string } }).error.code, fn).toBe("not_available_for_connected_apps");
    }
    expect(seen).toHaveLength(1);
  });
});
