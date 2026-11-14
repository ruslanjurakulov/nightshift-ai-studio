import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller, Rpc } from "@/lib/api/operations";
import { apiError, type ApiResult } from "@/lib/api/http";
import { buildMcpServer, CREATE_REMEDIES, STUDIO_REMEDIES, STUDIO_TOOL_NAMES, TOOL_NAMES } from "@/lib/api/mcp";
import { API_CREATIVE_CAPABILITIES } from "@/lib/api/operations";
import { CREATIVE_CAPABILITIES } from "@/lib/creative/operations";
import { OAUTH_TOOL_SCOPES, oauthRpc } from "@/lib/api/mcp-oauth";
import { MCP_TOOL_IDS } from "@/lib/dev/mcp-clients";
import { devDictionaries } from "@/lib/i18n/dev";

/**
 * The MCP Studio tools (list_models, quote_generation, create_generation, get_generation) through the real MCP route and the real
 * operations, with a fake database. What the database decides (scopes, organizations, the ceiling, the hold, idempotency) is attacked
 * in tests/security/test_sec_mcp_studio_tools.py and test_sec_api_creative.py; this pins the wiring: each tool calls exactly the one
 * function it must with the key's hash, the arguments that carry the money (max_credits, the idempotency key and its fingerprint)
 * reach it unchanged, a request the schema refuses never reaches the database, a refusal says what to do, and a connected app is
 * never offered any of them.
 */

const state = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  answers: {} as Record<string, unknown>,
  signing: true,
}));

vi.mock("@/lib/server/public-api", () => ({
  isCaller: (v: object) => "keyHash" in v,
  apiCaller: async (request: Request, requestId: string): Promise<ApiCaller | ApiResult> => {
    if (!request.headers.get("authorization")) return apiError(401, "invalid_api_key", "no key");
    const rpc: Rpc = async (fn, args) => {
      state.calls.push({ fn, args });
      return { data: state.answers[fn] ?? { ok: true, status: 200, data: {} }, error: null };
    };
    return {
      keyHash: "b".repeat(64),
      requestId,
      rpc,
      backend: "queue",
      downloads: true,
      mediaLink: (id, variant, mime) => (state.signing ? `/api/media/file/${id}/${variant}?t=${encodeURIComponent(mime)}&exp=1&sig=s` : null),
    };
  },
}));

const { POST } = await import("@/app/api/mcp/route");

const KEY_HASH = "b".repeat(64);
const JOB = "3f0c2a8e-6b1d-4c55-9a7e-2d3c4b5a6f70";
const ASSET = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const GEN = { capability: "t2v", model: "minimax-h3", params: { prompt: "a lighthouse at dawn", aspect_ratio: "16:9", duration_s: 6 } };

function rpcRequest(body: unknown) {
  return new Request("https://nightshift.test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer nsk_live_" + "x".repeat(43) },
    body: JSON.stringify(body),
  });
}

async function callTool(name: string, args: unknown): Promise<{ isError?: boolean; body: Record<string, unknown> | null; error?: unknown }> {
  const res = await POST(rpcRequest({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }));
  const json = (await res.json()) as { result?: { isError?: boolean; content: { text: string }[] }; error?: unknown };
  if (!json.result) return { body: null, error: json.error };
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(json.result.content[0].text);
  } catch {
    body = { text: json.result.content[0].text };
  }
  return { isError: json.result.isError, body };
}

/** The database calls past the key check (api_auth is the handshake's). */
const dbCalls = () => state.calls.filter((c) => c.fn !== "api_auth");

beforeEach(() => {
  state.calls = [];
  state.answers = {};
  state.signing = true;
});

describe("the Studio tools are listed for an API key and never for a connected app", () => {
  it("the server lists them after the video tools, and the docs table names the same tools in the same order", async () => {
    const res = await POST(rpcRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const tools = ((await res.json()) as { result: { tools: { name: string; inputSchema: { required?: string[] } }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(TOOL_NAMES.slice(-4)).toEqual([...STUDIO_TOOL_NAMES]);
    expect([...MCP_TOOL_IDS]).toEqual([...TOOL_NAMES]);
    // create_generation cannot be called without the two things that protect the person's credits.
    const create = tools.find((t) => t.name === "create_generation")!;
    expect(create.inputSchema.required).toEqual(expect.arrayContaining(["capability", "model", "params", "max_credits", "idempotency_key"]));
  });

  it("an OAuth connection is offered none of them, whatever it was granted, and its database door refuses their functions", async () => {
    for (const t of STUDIO_TOOL_NAMES) expect(Object.hasOwn(OAUTH_TOOL_SCOPES, t), t).toBe(false);
    const calls: string[] = [];
    const rpc: Rpc = async (fn) => {
      calls.push(fn);
      return { data: { ok: true, status: 200, data: {} }, error: null };
    };
    const caller = { keyHash: "a".repeat(64), requestId: "r", rpc: oauthRpc(rpc), backend: "queue", downloads: false } as ApiCaller;
    const server = buildMcpServer(caller, { scopes: ["videos:read", "videos:create", "videos:publish"], origin: "https://nightshift-ai.studio" });
    const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    for (const t of STUDIO_TOOL_NAMES) expect(registered, t).not.toContain(t);
    for (const fn of ["api_creative_models", "api_creative_quote", "api_creative_create", "api_creative_job_files"]) {
      const out = await oauthRpc(rpc)(fn, { p_key_hash: "a".repeat(64) });
      expect((out.data as { error: { code: string } }).error.code, fn).toBe("not_available_for_connected_apps");
    }
    expect(calls).toEqual([]);
  });

  it("the /mcp table says the Studio tools need an API key, in every language", () => {
    for (const [loc, dev] of Object.entries(devDictionaries)) {
      const ids = dev.mcp.tools.list.map((t) => t.id);
      expect(ids, loc).toEqual([...MCP_TOOL_IDS]);
      expect(Object.keys(dev.mcp.tools.paid).sort(), loc).toEqual(["create_generation", "create_video", "request_download"]);
      expect(dev.mcp.tools.lead, loc).toMatch(/API(-ключ| key| kalit)/);
    }
  });
});

describe("list_models", () => {
  it("calls api_creative_models with the key's hash and the capability, and answers the database's list", async () => {
    state.answers.api_creative_models = { ok: true, status: 200, data: { capability: "t2v", models: [{ id: "minimax-h3", name: "MiniMax H3" }] } };
    const out = await callTool("list_models", { capability: "t2v" });
    expect(out.isError).toBeUndefined();
    expect(out.body).toEqual({ capability: "t2v", models: [{ id: "minimax-h3", name: "MiniMax H3" }] });
    expect(dbCalls()).toEqual([{ fn: "api_creative_models", args: { p_key_hash: KEY_HASH, p_capability: "t2v", p_request_id: expect.stringMatching(/^req_/) } }]);
  });

  it("the API's capabilities are the Studio's own, without the web-only captions and the unsellable music", () => {
    expect([...API_CREATIVE_CAPABILITIES].sort()).toEqual(CREATIVE_CAPABILITIES.filter((c) => c !== "captions" && c !== "music").sort());
  });

  it("with no capability asks for every model; an unknown capability never reaches the database", async () => {
    await callTool("list_models", {});
    expect(dbCalls()[0].args.p_capability).toBeNull();
    state.calls = [];
    const out = await callTool("list_models", { capability: "teleport" });
    expect(out.isError ?? out.error).toBeTruthy();
    expect(dbCalls()).toEqual([]);
  });

  it("a database without 0162 is a 503 that names the migration, not an empty list", async () => {
    const res = await POST(rpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(res.status).toBe(200);
    const caller = {
      keyHash: KEY_HASH, requestId: "req_x", backend: "queue", downloads: true,
      rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.api_creative_models" } }),
    } as unknown as ApiCaller;
    const { listCreativeModels } = await import("@/lib/api/operations");
    const r = await listCreativeModels(caller, null);
    expect(r).toMatchObject({ ok: false, status: 503, code: "api_unavailable" });
    expect(!r.ok && r.message).toMatch(/0162/);
  });
});

describe("quote_generation", () => {
  it("is api_creative_quote with exactly the request (nothing held), and answers its price", async () => {
    state.answers.api_creative_quote = { ok: true, status: 200, data: { quote: { model: "minimax-h3", credits: 90 } } };
    const out = await callTool("quote_generation", GEN);
    expect(out.body).toEqual({ quote: { model: "minimax-h3", credits: 90 } });
    const [c] = dbCalls();
    expect(c.fn).toBe("api_creative_quote");
    expect(c.args).toMatchObject({ p_key_hash: KEY_HASH, p_capability: "t2v", p_model: "minimax-h3", p_params: GEN.params });
    expect(dbCalls().map((x) => x.fn)).not.toContain("api_creative_create");
  });

  it("refuses an unknown field before the database (strict schema): a provider cannot be smuggled in", async () => {
    const out = await callTool("quote_generation", { ...GEN, provider: "kling" });
    expect(out.isError ?? out.error).toBeTruthy();
    expect(dbCalls()).toEqual([]);
  });
});

describe("create_generation: the ceiling and the idempotency key carry the money", () => {
  it("sends max_credits, the idempotency key and a fingerprint of the exact request to api_creative_create, once", async () => {
    state.answers.api_creative_create = { ok: true, status: 201, data: { id: JOB, status: "queued", quoted_credits: 90 } };
    const out = await callTool("create_generation", { ...GEN, max_credits: 90, idempotency_key: "gen-1" });
    expect(out.body).toMatchObject({ id: JOB, status: "queued", quoted_credits: 90 });
    const creates = dbCalls().filter((c) => c.fn === "api_creative_create");
    expect(creates).toHaveLength(1);
    expect(creates[0].args).toMatchObject({
      p_key_hash: KEY_HASH, p_capability: "t2v", p_model: "minimax-h3", p_params: GEN.params, p_mode: "exact",
      p_max_credits: 90, p_idem_key: "gen-1", p_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("the same request with the same key fingerprints the same; another price or prompt does not (a reused key is the database's 422)", async () => {
    await callTool("create_generation", { ...GEN, max_credits: 90, idempotency_key: "gen-1" });
    await callTool("create_generation", { ...GEN, max_credits: 90, idempotency_key: "gen-1" });
    await callTool("create_generation", { ...GEN, max_credits: 120, idempotency_key: "gen-1" });
    await callTool("create_generation", { ...GEN, params: { ...GEN.params, prompt: "another" }, max_credits: 90, idempotency_key: "gen-1" });
    const prints = dbCalls().filter((c) => c.fn === "api_creative_create").map((c) => c.args.p_fingerprint);
    expect(prints[0]).toBe(prints[1]);
    expect(new Set(prints).size).toBe(3);
  });

  it.each([
    ["no max_credits", { ...GEN, idempotency_key: "gen-2" }],
    ["no idempotency key", { ...GEN, max_credits: 90 }],
    ["a negative ceiling", { ...GEN, max_credits: -1, idempotency_key: "gen-2" }],
    ["a malformed idempotency key", { ...GEN, max_credits: 90, idempotency_key: "has spaces" }],
    ["a model id with a path in it", { ...GEN, model: "../minimax", max_credits: 90, idempotency_key: "gen-2" }],
    ["an organization", { ...GEN, max_credits: 90, idempotency_key: "gen-2", org_id: "00000000-0000-0000-0000-000000000001" }],
  ])("%s is refused before the database: nothing can be held", async (_name, args) => {
    const out = await callTool("create_generation", args);
    expect(out.isError ?? out.error).toBeTruthy();
    expect(dbCalls().filter((c) => c.fn === "api_creative_create")).toEqual([]);
  });

  it.each([
    ["price_changed", 409, "quote_generation again"],
    ["insufficient_credits", 402, "add credits"],
    ["key_credit_limit_reached", 402, "Developer console"],
    ["model_not_sellable", 422, "list_models"],
    ["entitlement_required", 403, "list_models"],
    ["model_temporarily_off", 503, "list_models"],
    ["invalid_params", 400, "list_models"],
    ["insufficient_scope", 403, "Studio permissions"],
    ["idempotency_key_reused", 422, "fresh one"],
  ])("a %s refusal keeps the database's code and says what to do", async (code, status, remedy) => {
    state.answers.api_creative_create = { ok: false, status, error: { code, message: "refused by the database" } };
    const out = await callTool("create_generation", { ...GEN, max_credits: 90, idempotency_key: "gen-3" });
    expect(out.isError).toBe(true);
    const err = (out.body as { error: { code: string; message: string; remedy: string } }).error;
    expect(err.code).toBe(code);
    expect(err.message).toBe("refused by the database");
    expect(err.remedy).toBe(STUDIO_REMEDIES[code]);
    expect(err.remedy).toContain(remedy);
  });

  it.each(["idempotency_in_progress", "upstream_error", "internal_error"])(
    "a %s answer to create says to retry with the SAME idempotency_key, never a new one (a new one could pay twice)",
    async (code) => {
      state.answers.api_creative_create = { ok: false, status: code === "idempotency_in_progress" ? 409 : 502, error: { code, message: "not settled" } };
      const out = await callTool("create_generation", { ...GEN, max_credits: 90, idempotency_key: "gen-4" });
      const err = (out.body as { error: { code: string; remedy: string } }).error;
      expect(err.code).toBe(code);
      expect(err.remedy).toMatch(/SAME idempotency_key, never a new one/);
    },
  );

  it("a read that the database did not answer gets no create advice", async () => {
    state.answers.api_creative_quote = { ok: false, status: 502, error: { code: "upstream_error", message: "no answer" } };
    const out = await callTool("quote_generation", GEN);
    expect((out.body as { error: Record<string, unknown> }).error).not.toHaveProperty("remedy");
    expect(CREATE_REMEDIES.upstream_error).toMatch(/SAME idempotency_key/);
  });

  it("no credits and no model are told apart: opposite remedies", () => {
    expect(STUDIO_REMEDIES.insufficient_credits).not.toMatch(/list_models/);
    expect(STUDIO_REMEDIES.model_not_sellable).not.toMatch(/credits/);
    expect(STUDIO_REMEDIES.invalid_params).not.toMatch(/credits/);
  });
});

describe("get_generation", () => {
  const row = (files: unknown[]) => ({ ok: true, status: 200, data: { id: JOB, status: "completed", charged_credits: 90, result_asset_ids: files.map((f) => (f as { asset_id: string }).asset_id), files } });

  it("is api_creative_job_files for the id, and signs a link to each file (the original, and its thumbnail when there is one)", async () => {
    state.answers.api_creative_job_files = row([{ asset_id: ASSET, kind: "video", mime: "video/mp4", variants: ["thumb", "proxy"], width: 1280, height: 720, duration_s: 6 }]);
    const out = await callTool("get_generation", { generation_id: JOB.toUpperCase() });
    expect(dbCalls()).toEqual([{ fn: "api_creative_job_files", args: { p_key_hash: KEY_HASH, p_job_id: JOB, p_request_id: expect.stringMatching(/^req_/) } }]);
    const f = (out.body as { files: Record<string, unknown>[] }).files[0];
    expect(f).toMatchObject({ asset_id: ASSET, kind: "video", mime: "video/mp4", width: 1280, height: 720, duration_s: 6 });
    expect(f.url).toBe(`/api/media/file/${ASSET}/original?t=video%2Fmp4&exp=1&sig=s`);
    expect(f.thumbnail_url).toBe(`/api/media/file/${ASSET}/thumb?t=video%2Fmp4&exp=1&sig=s`);
    expect(out.body).not.toHaveProperty("files_note");
  });

  it("never signs what is not a file id the database returned, and says so when this host cannot sign at all", async () => {
    state.answers.api_creative_job_files = row([{ asset_id: "../../etc/passwd", kind: "image", mime: "image/png", variants: [] }]);
    const bad = await callTool("get_generation", { generation_id: JOB });
    expect((bad.body as { files: { url: unknown }[] }).files[0].url).toBeNull();
    state.signing = false;
    state.answers.api_creative_job_files = row([{ asset_id: ASSET, kind: "image", mime: "image/png", variants: ["thumb"] }]);
    const off = await callTool("get_generation", { generation_id: JOB });
    const body = off.body as { files: { url: unknown; thumbnail_url: unknown }[]; files_note?: string };
    expect(body.files[0].url).toBeNull();
    expect(body.files[0].thumbnail_url).toBeNull();
    expect(body.files_note).toMatch(/library/);
  });

  it("an empty or short list never reads as 'it made nothing' (CLAUDE.md #5)", async () => {
    // Completed, two results, one no longer served here: the list says how many cannot be served and where they are.
    state.answers.api_creative_job_files = {
      ok: true, status: 200,
      data: { id: JOB, status: "completed", result_asset_ids: [ASSET, JOB], files: [{ asset_id: ASSET, kind: "image", mime: "image/png", variants: [] }] },
    };
    const short = (await callTool("get_generation", { generation_id: JOB })).body as { files: unknown[]; files_note?: string };
    expect(short.files).toHaveLength(1);
    expect(short.files_note).toMatch(/^1 of this generation's 2 results cannot be served/);
    // Still running: no file yet, and it says so.
    state.answers.api_creative_job_files = { ok: true, status: 200, data: { id: JOB, status: "running", result_asset_ids: [], files: [] } };
    const running = (await callTool("get_generation", { generation_id: JOB })).body as { files_note?: string };
    expect(running.files_note).toBe("Files are listed once the generation is completed.");
    // Failed and refunded (Breach BR-0162-1): no file and no promise of one; the job's own error is the explanation.
    state.answers.api_creative_job_files = { ok: true, status: 200, data: { id: JOB, status: "failed", result_asset_ids: [ASSET], files: [], error: "refused" } };
    const failed = (await callTool("get_generation", { generation_id: JOB })).body as { files: unknown[]; files_note?: string };
    expect(failed.files).toEqual([]);
    expect(failed).not.toHaveProperty("files_note");
  });

  it("a job that is not this key's is the database's 404; a malformed id never reaches it", async () => {
    state.answers.api_creative_job_files = { ok: false, status: 404, error: { code: "job_not_found", message: "No generation with that id for this key." } };
    const out = await callTool("get_generation", { generation_id: JOB });
    expect(out.isError).toBe(true);
    expect((out.body as { error: { code: string } }).error.code).toBe("job_not_found");
    state.calls = [];
    const bad = await callTool("get_generation", { generation_id: "not-a-uuid" });
    expect(bad.isError ?? bad.error).toBeTruthy();
    expect(dbCalls()).toEqual([]);
  });
});
