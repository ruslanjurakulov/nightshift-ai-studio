import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller, Rpc } from "@/lib/api/operations";
import { apiError, type ApiResult } from "@/lib/api/http";
import { needsKeyCheck } from "@/lib/api/mcp-http";
import { TOOL_NAMES } from "@/lib/api/mcp";
import { gateDecision, isPublicApiPath } from "@/lib/public-paths";

// The MCP route with a fake database: the operations underneath are the real
// ones, so this checks the wiring from a JSON-RPC tool call down to the one
// 0031 function it must call, with the caller's key hash.

const state = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  answer: { ok: true, status: 200, data: { ok: 1 } } as unknown,
  refuse: null as unknown,
}));

vi.mock("@/lib/server/public-api", () => ({
  isCaller: (v: object) => "keyHash" in v,
  apiCaller: async (request: Request, requestId: string): Promise<ApiCaller | ApiResult> => {
    if (!request.headers.get("authorization")) return apiError(401, "invalid_api_key", "no key");
    const rpc: Rpc = async (fn, args) => {
      state.calls.push({ fn, args });
      return { data: fn === "api_auth" && state.refuse ? state.refuse : state.answer, error: null };
    };
    return { keyHash: "b".repeat(64), requestId, rpc, backend: "queue", downloads: true };
  },
}));

const { POST } = await import("@/app/api/mcp/route");

function rpcRequest(body: unknown, auth = true) {
  return new Request("https://nightshift.test/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(auth ? { authorization: "Bearer nsk_live_" + "x".repeat(43) } : {}),
    },
    body: JSON.stringify(body),
  });
}

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

beforeEach(() => {
  state.calls = [];
  state.answer = { ok: true, status: 200, data: { ok: 1 } };
  state.refuse = null;
});

describe("MCP endpoint", () => {
  it("refuses a request without a key with the API's 401 envelope", async () => {
    const res = await POST(rpcRequest(init, false));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { type: "authentication_error", code: "invalid_api_key" } });
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
  });

  it("checks the key once for the handshake, and refuses a refused key before answering", async () => {
    const ok = await POST(rpcRequest(init));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ result: { serverInfo: { name: "nightshift" } } });
    expect(state.calls.map((c) => c.fn)).toEqual(["api_auth"]);

    state.refuse = { ok: false, status: 403, error: { code: "api_not_activated", message: "activate" } };
    const no = await POST(rpcRequest(init));
    expect(no.status).toBe(403);
    expect(await no.json()).toMatchObject({ error: { code: "api_not_activated" } });
  });

  it("lists every tool with a description and an input schema", async () => {
    const res = await POST(rpcRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const tools = ((await res.json()) as { result: { tools: { name: string; description: string; inputSchema: object }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.inputSchema, t.name).toMatchObject({ type: "object" });
    }
    const create = tools.find((t) => t.name === "create_video")!.inputSchema as { required?: string[] };
    expect(create.required).toEqual(["channel_id"]);
  });

  it.each([
    ["create_video", { channel_id: "my-channel", topic: "Rome", duration: 90 }, "api_create_video", { p_channel_id: "my-channel", p_params: { topic: "Rome", duration: 90 } }],
    ["get_job_status", { job_id: 7 }, "api_get_job", { p_job_id: 7 }],
    ["list_videos", { channel_id: "my-channel", limit: 5 }, "api_list_videos", { p_channel_id: "my-channel", p_limit: 5, p_offset: 0 }],
    ["get_video", { video_id: "abc" }, "api_get_video", { p_video_id: "abc" }],
    ["publish_video", { video_id: "abc", channel_ids: ["other"] }, "api_request_publish", { p_video_id: "abc", p_channel_ids: ["other"], p_account_ids: [] }],
    ["request_download", { video_id: "abc", quality: "1080p" }, "api_request_download", { p_video_id: "abc", p_quality: "1080p" }],
    ["get_download", { download_id: 3 }, "api_get_download", { p_id: 3 }],
    ["get_balance", {}, "api_balance", {}],
    ["list_channels", {}, "api_list_channels", {}],
    ["list_connected_accounts", {}, "api_list_connected_accounts", {}],
  ])("%s calls %s once, with the key hash and nothing else counted", async (tool, args, fn, expected) => {
    const res = await POST(rpcRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: args } }));
    expect(res.status).toBe(200);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].fn).toBe(fn);
    expect(state.calls[0].args).toMatchObject({ p_key_hash: "b".repeat(64), ...expected });
  });

  it("returns a refused operation as a tool error carrying the API's code", async () => {
    state.answer = { ok: false, status: 402, error: { code: "insufficient_balance", message: "Top up.", price_cents: 180 } };
    const res = await POST(rpcRequest({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_video", arguments: { channel_id: "c" } } }));
    const result = ((await res.json()) as { result: { isError: boolean; content: { text: string }[] } }).result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { type: "billing_error", code: "insufficient_balance", price_cents: 180 } });
  });

  it("rejects bad tool arguments before any database call", async () => {
    const res = await POST(rpcRequest({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "create_video", arguments: { channel_id: "c", duration: 5 } } }));
    const body = (await res.json()) as { result?: { isError?: boolean }; error?: unknown };
    expect(body.error ?? body.result?.isError).toBeTruthy();
    expect(state.calls).toEqual([]);
  });
});

describe("MCP helpers", () => {
  it("count a handshake but not tool calls or notifications", () => {
    expect(needsKeyCheck(init)).toBe(true);
    expect(needsKeyCheck({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(true);
    expect(needsKeyCheck({ jsonrpc: "2.0", id: 1, method: "tools/call" })).toBe(false);
    expect(needsKeyCheck({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(false);
    expect(needsKeyCheck([{ method: "tools/call" }, { method: "tools/list" }])).toBe(true);
  });

  it("exempt exactly /api/mcp from the cookie gate", () => {
    expect(isPublicApiPath("/api/mcp")).toBe(true);
    expect(isPublicApiPath("/api/mcp/x")).toBe(false);
    expect(isPublicApiPath("/api/mcpx")).toBe(false);
    expect(gateDecision("/api/mcp", false)).toBe("pass");
  });
});
