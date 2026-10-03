import { describe, expect, it } from "vitest";
import { oauthRefusalText, oauthRpc, OAUTH_TOOL_SCOPES } from "@/lib/api/mcp-oauth";
import { buildMcpServer, TOOL_NAMES } from "@/lib/api/mcp";
import type { ApiCaller, Rpc } from "@/lib/api/operations";
import type { ApiResult } from "@/lib/api/http";

/**
 * What an AI app connected with OAuth is offered and where its calls go. The
 * rule under test: a token can reach site-credit functions and the read/publish
 * functions the database lets it reach, and NOTHING that touches the prepaid
 * USD balance — checked here by name, in the mapping, before any network.
 */

const H = "a".repeat(64);

function recorder() {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    return { data: { ok: true, status: 200, data: {} }, error: null };
  };
  return { calls, rpc };
}

describe("oauthRpc", () => {
  it.each([
    ["api_create_video", "oauth_create_video", { p_channel_id: "c", p_params: {}, p_idem_key: "k", p_fingerprint: "f", p_request_id: "r" }, ["p_token_hash", "p_channel_id", "p_params", "p_idem_key", "p_request_id"]],
    ["api_get_job", "oauth_get_job", { p_job_id: 1, p_request_id: "r" }, ["p_token_hash", "p_job_id", "p_request_id"]],
    ["api_balance", "oauth_get_balance", { p_request_id: "r" }, ["p_token_hash", "p_request_id"]],
  ])("sends %s to %s (site credits), with the token's hash and no API-key argument", async (from, to, args, keys) => {
    const { calls, rpc } = recorder();
    await oauthRpc(rpc)(from, { p_key_hash: H, ...args });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe(to);
    expect(Object.keys(calls[0].args).sort()).toEqual([...keys].sort());
    expect(calls[0].args.p_token_hash).toBe(H);
  });

  it.each(["api_list_channels", "api_list_videos", "api_get_video", "api_list_connected_accounts", "api_request_publish"])(
    "passes %s through unchanged (the database lets a token reach it)",
    async (fn) => {
      const { calls, rpc } = recorder();
      await oauthRpc(rpc)(fn, { p_key_hash: H, p_request_id: "r" });
      expect(calls[0]).toEqual({ fn, args: { p_key_hash: H, p_request_id: "r" } });
    },
  );

  it.each(["api_request_download", "api_get_download", "api_auth", "api_creative_quote", "api_creative_create", "api_creative_get", "api_account_lock", "create_api_key", "api_add_topup", "anything_else"])(
    "refuses %s before the network",
    async (fn) => {
      const { calls, rpc } = recorder();
      const out = await oauthRpc(rpc)(fn, { p_key_hash: H });
      expect(calls).toEqual([]);
      expect(out.data).toMatchObject({ ok: false, status: 403, error: { code: "not_available_for_connected_apps" } });
    },
  );
});

function caller(rpc: Rpc): ApiCaller {
  return { keyHash: H, requestId: "req_x", rpc: oauthRpc(rpc), backend: "queue", downloads: false };
}

async function listed(scopes: string[]) {
  const server = buildMcpServer(caller(recorder().rpc), { scopes, origin: "https://nightshift-ai.studio" });
  // The registry the SDK keeps; names are all this test needs.
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
}

describe("the tools an OAuth caller is offered follow what the person allowed", () => {
  it("all three permissions: eight tools, and never the two paid-download tools", async () => {
    const names = await listed(["videos:read", "videos:create", "videos:publish"]);
    expect(names).toEqual(Object.keys(OAUTH_TOOL_SCOPES).sort());
    expect(names).not.toContain("request_download");
    expect(names).not.toContain("get_download");
  });
  it("read only: nothing that spends or publishes", async () => {
    expect(await listed(["videos:read"])).toEqual(["get_balance", "get_job_status", "get_video", "list_channels", "list_connected_accounts", "list_videos"]);
  });
  it("create without publish, publish without create", async () => {
    expect(await listed(["videos:create"])).toEqual(["create_video"]);
    expect(await listed(["videos:publish"])).toEqual(["publish_video"]);
    expect(await listed([])).toEqual([]);
  });
  it("an API key still gets all ten tools, exactly as before", () => {
    const server = buildMcpServer(caller(recorder().rpc));
    expect(Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)).toEqual([...TOOL_NAMES]);
  });
});

describe("refusals are written for a person", () => {
  const fail = (code: string, details: Record<string, unknown> = {}, extra: Partial<Extract<ApiResult, { ok: false }>> = {}): Extract<ApiResult, { ok: false }> => ({
    ok: false,
    status: 402,
    code,
    message: "internal message",
    details,
    ...extra,
  });
  const O = "https://nightshift-ai.studio";
  const INTERNAL = /rj-|reserve|ledger|hold|hash|sha|NS4|api_|oauth_|tenant|org_id|usd|cents|balance_cents|grant|oauth/i;

  it("not enough credits: the numbers are the workspace's own, with both links", () => {
    const t = oauthRefusalText(fail("insufficient_credits", { price_credits: 90, available_credits: 12.5, held_credits: 0 }), O);
    expect(t).toContain("needs 90 credits");
    expect(t).toContain("12.5 available");
    expect(t).not.toContain("set aside");
    expect(t).toContain(`${O}/credits`);
    expect(t).toContain(`${O}/pricing`);
    expect(t).not.toMatch(INTERNAL);
  });
  it("the connection limit: the person raises it, the assistant cannot", () => {
    const t = oauthRefusalText(fail("connection_limit_reached", { limit_credits: 100, spent_credits: 90, price_credits: 90 }), O);
    expect(t).toContain(`${O}/developers`);
    expect(t).toMatch(/Only the person can raise it/);
    expect(t).toMatch(/You cannot change it/);
    expect(t).not.toMatch(INTERNAL);
  });
  it("the run limit: wait or upgrade", () => {
    const t = oauthRefusalText(fail("run_limit_reached", { run_limit: 2, active_runs: 2, retry_after: 60 }, { status: 429 }), O);
    expect(t).toContain("at most 2 videos at once and 2 are in progress");
    expect(t).toContain("about a minute");
    expect(t).toContain(`${O}/pricing`);
    expect(t).not.toMatch(INTERNAL);
  });
  it("a paused plan, a dead connection, a missing permission, a lost workspace and a flood each say what to do", () => {
    expect(oauthRefusalText(fail("subscription_required", {}, { status: 403 }), O)).toMatch(/paid plan.*pricing.*no need to connect the app again/s);
    expect(oauthRefusalText(fail("invalid_api_key", {}, { status: 401 }), O)).toMatch(/connect the app to Nightshift again/);
    expect(oauthRefusalText(fail("insufficient_scope", { required_scope: "videos:create" }, { status: 403 }), O)).toContain('"videos:create"');
    expect(oauthRefusalText(fail("workspace_access_lost", {}, { status: 403 }), O)).toMatch(/connect the app again/);
    expect(oauthRefusalText(fail("rate_limit_exceeded", {}, { status: 429, retryAfter: 12 }), O)).toContain("12 seconds");
    for (const code of ["internal_error", "upstream_error", "api_unavailable"]) expect(oauthRefusalText(fail(code), O)).toMatch(/Nothing was started or charged/);
  });
  it("never leaks the database's own words for the three limits", () => {
    for (const code of ["insufficient_credits", "connection_limit_reached", "run_limit_reached", "subscription_required"]) {
      expect(oauthRefusalText(fail(code), O)).not.toContain("internal message");
    }
  });
});
