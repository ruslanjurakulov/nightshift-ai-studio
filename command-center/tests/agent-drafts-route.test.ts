import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/agent-builder/drafts (GET list, POST save) and /api/agent-builder/drafts/<id> (GET one, DELETE), migration 0130, behind
 * NIGHTSHIFT_AGENT_DRAFTS_ENABLED.
 *
 * What would break without these: the switch being off and a route still reading the session or reaching the database (it answers the
 * public 404 first); a flag value the other switches accept (on, 1, yes, TRUE) leaving this one off; a cross-site POST or DELETE reaching
 * the handler; an oversized or malformed body reaching the database; a refusal of the function (its own 22023 messages, a version
 * conflict, another person's id) answered as a 503 outage; and a version past 30 (the database keeps counting after pruning) refused.
 */

vi.mock("server-only", () => ({}));

type Err = { code?: string; message?: string };
type Result = { data: unknown; error: Err | null };

const ID = "0b000000-0000-4000-8000-00000000000b";
const h = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  rpc: {} as Record<string, Result>,
  table: {} as Record<string, Result>,
  sessionReads: 0,
  calls: [] as { kind: string; name: string; args?: Record<string, unknown> }[],
}));

function builder(result: () => Result): unknown {
  const q: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      return () => q;
    },
  });
  return q;
}

const client = {
  auth: { getUser: async () => { h.sessionReads++; return { data: { user: h.user }, error: null }; } },
  rpc: (name: string, args: Record<string, unknown>) => {
    h.calls.push({ kind: "rpc", name, args });
    return builder(() => h.rpc[name] ?? { data: null, error: null });
  },
  from: (name: string) => {
    h.calls.push({ kind: "from", name });
    return builder(() => h.table[name] ?? { data: null, error: null });
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => { h.sessionReads++; return client; } }));

const list = await import("../app/api/agent-builder/drafts/route");
const one = await import("../app/api/agent-builder/drafts/[id]/route");
const { agentDraftsEnabled, draftRpcFailure } = await import("../lib/server/agent-drafts");
const { createCampaignWorkflow } = await import("../lib/agent-graph");
const { exportWorkflowDraft } = await import("../lib/agent-draft");

const ORIGIN = "http://localhost";
const DOCUMENT = JSON.parse(exportWorkflowDraft(createCampaignWorkflow(), {}));
const post = (body: unknown, headers: Record<string, string> = {}) =>
  list.POST(new Request(`${ORIGIN}/api/agent-builder/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as never);
const del = (id: string = ID, headers: Record<string, string> = {}) =>
  one.DELETE(new Request(`${ORIGIN}/api/agent-builder/drafts/${id}`, { method: "DELETE", headers: { origin: ORIGIN, ...headers } }),
    { params: Promise.resolve({ id }) });
const getOne = (id: string = ID, query = "") =>
  one.GET(new Request(`${ORIGIN}/api/agent-builder/drafts/${id}${query}`), { params: Promise.resolve({ id }) });
const saves = () => h.calls.filter((c) => c.kind === "rpc" && c.name === "save_agent_workflow_draft");

beforeEach(() => {
  h.user = { id: "u1" };
  h.rpc = { save_agent_workflow_draft: { data: [{ saved_id: ID, saved_version: 1 }], error: null } };
  h.table = {};
  h.sessionReads = 0;
  h.calls = [];
  vi.stubEnv("NIGHTSHIFT_AGENT_DRAFTS_ENABLED", "on");
});
afterEach(() => vi.unstubAllEnvs());

describe("the switch", () => {
  it.each(["on", "1", "true", "yes", " TRUE ", "Yes"])("%j is on", (v) => expect(agentDraftsEnabled(v)).toBe(true));
  it.each(["", "0", "off", "false", "no", "enabled", "truthy"])("%j is off", (v) => expect(agentDraftsEnabled(v)).toBe(false));

  it.each(["", "off", "false", "0"])("NIGHTSHIFT_AGENT_DRAFTS_ENABLED=%j: every route is the public 404 before the session is read", async (v) => {
    vi.stubEnv("NIGHTSHIFT_AGENT_DRAFTS_ENABLED", v);
    for (const res of [await list.GET(), await post({ document: DOCUMENT }), await getOne(), await del()]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(h.sessionReads).toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe("same origin", () => {
  it.each<Record<string, string>>([{ origin: "https://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }])("a cross-site POST or DELETE is 403 before anything runs (%j)", async (headers) => {
    for (const res of [await post({ document: DOCUMENT }, headers), await del(ID, headers)]) {
      expect(res.status).toBe(403);
    }
    expect(h.sessionReads).toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe("POST", () => {
  it("saves a valid draft and answers the id and version", async () => {
    const res = await post({ document: DOCUMENT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID, version: 1 });
    expect(saves()[0].args).toEqual({ p_draft_id: null, p_expected_version: null, p_document: DOCUMENT });
  });

  it("refuses a body over the cap with 413 and never calls the database", async () => {
    const res = await post(JSON.stringify({ document: DOCUMENT, pad: "x".repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(saves()).toEqual([]);
  });

  it.each([
    ["not json", "{", 400, "invalid_json"],
    ["an array", [], 400, "invalid_request"],
    ["no document", { id: null }, 400, "invalid_agent_draft"],
    ["a bad id", { id: "not-a-uuid", document: DOCUMENT }, 400, "invalid_draft_id"],
    ["a fractional version", { id: ID, expectedVersion: 1.5, document: DOCUMENT }, 400, "invalid_expected_version"],
    ["a negative version", { id: ID, expectedVersion: -1, document: DOCUMENT }, 400, "invalid_expected_version"],
    ["a config with a key", { document: { ...DOCUMENT, workflow: { ...DOCUMENT.workflow, nodes: DOCUMENT.workflow.nodes.map((n: object, i: number) => (i === 0 ? { ...n, config: { apiKey: "x" } } : n)) } } }, 400, "invalid_agent_draft"],
    ["a bidi label", { document: { ...DOCUMENT, workflow: { ...DOCUMENT.workflow, name: "Plan \u202egnp" } } }, 400, "invalid_agent_draft"],
  ])("refuses %s before the database", async (_what, body, status, error) => {
    const res = await post(body);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    expect(saves()).toEqual([]);
  });

  it("takes an expected version past 30: the database keeps counting after it prunes", async () => {
    h.rpc.save_agent_workflow_draft = { data: [{ saved_id: ID, saved_version: 42 }], error: null };
    const res = await post({ id: ID, expectedVersion: 41, document: DOCUMENT });
    expect(res.status).toBe(200);
    expect(saves()[0].args?.p_expected_version).toBe(41);
  });

  it("is 401 without a session", async () => {
    h.user = null;
    expect((await post({ document: DOCUMENT })).status).toBe(401);
    expect(saves()).toEqual([]);
  });

  it.each([
    [{ code: "22023", message: "invalid_agent_node" }, 400, "invalid_agent_draft"],
    [{ code: "22023", message: "invalid_agent_position" }, 400, "invalid_agent_draft"],
    [{ code: "22023", message: "invalid_agent_draft_name" }, 400, "invalid_agent_draft"],
    [{ code: "22023", message: "agent_draft_too_large" }, 413, "payload_too_large"],
    [{ code: "22023", message: "agent_draft_limit" }, 409, "draft_limit_reached"],
    [{ code: "40001", message: "version_conflict" }, 409, "version_conflict"],
    [{ code: "P0002", message: "draft_not_found" }, 404, "not_found"],
    [{ code: "42501", message: "not_authenticated" }, 401, "unauthorized"],
    [{ code: "PGRST202", message: "Could not find the function public.save_agent_workflow_draft" }, 503, "drafts_unavailable"],
    [{ code: "08006", message: "connection failure" }, 503, "drafts_unavailable"],
  ])("answers the function's refusal %j as %i", async (error, status, body) => {
    h.rpc.save_agent_workflow_draft = { data: null, error };
    const res = await post({ document: DOCUMENT });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: body });
  });
});

describe("DELETE", () => {
  it("calls the owner's delete and answers what it deleted", async () => {
    h.rpc.delete_agent_workflow_draft = { data: null, error: null };
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: ID });
    expect(h.calls).toEqual([{ kind: "rpc", name: "delete_agent_workflow_draft", args: { p_draft_id: ID } }]);
  });

  it("another person's or a missing id is 404", async () => {
    h.rpc.delete_agent_workflow_draft = { data: null, error: { code: "P0002", message: "draft_not_found" } };
    const res = await del();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("refuses an id that is not a uuid before the session", async () => {
    const res = await del("../drafts");
    expect(res.status).toBe(400);
    expect(h.sessionReads).toBe(0);
  });

  it("is 401 without a session", async () => {
    h.user = null;
    expect((await del()).status).toBe(401);
    expect(h.calls).toEqual([]);
  });
});

describe("GET one", () => {
  it("a version the database pruned or another person's draft is 404", async () => {
    h.table.agent_workflow_drafts = { data: { id: ID, current_version: 40 }, error: null };
    h.table.agent_workflow_draft_versions = { data: null, error: null };
    expect((await getOne(ID, "?version=3")).status).toBe(404);
    h.table.agent_workflow_drafts = { data: null, error: null };
    expect((await getOne()).status).toBe(404);
  });
});

describe("draftRpcFailure", () => {
  it("never answers a function refusal as an outage", () => {
    for (const message of ["invalid_agent_draft", "invalid_agent_edge", "anything_else"]) {
      expect(draftRpcFailure({ code: "22023", message }).status).toBe(400);
    }
  });
});
