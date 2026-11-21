/**
 * GET /api/creative/durations through the route, the real session helper and the real database door
 * (lib/server/creative creativeDb), with only Supabase itself stood in for — a client that answers the way RLS does:
 * rows of an organization the member belongs to, nothing of any other.
 *
 * What would break without these: history answered to someone signed out; another organization's job times read by
 * passing its id (the "~N%" would then be built from a workspace the member cannot see); a malformed model list
 * reaching the PostgREST `or=` filter; a database without 0036 read as "no history" instead of "not available".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const at = (s: number) => new Date(Date.parse("2026-11-01T10:00:00Z") + s * 1000).toISOString();

const h = vi.hoisted(() => ({
  user: { id: "u" } as { id: string } | null,
  memberOf: new Set<string>(),
  rows: [] as { org_id: string; started_at: string; finished_at: string; requested_model: string }[],
  error: null as null | { code: string; message: string },
  asked: [] as { table: string; filters: [string, string, unknown][] }[],
  // 0151's model_probe_seconds, as the member's own session calls it: what it answers, and what it was asked.
  seedRows: [] as Record<string, unknown>[],
  seedError: null as null | { code: string; message: string },
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
}));

/** A PostgREST builder that records its filters and answers on `.limit()` as RLS would. */
function table(name: string) {
  const filters: [string, string, unknown][] = [];
  h.asked.push({ table: name, filters });
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => (filters.push(["eq", col, v]), q),
    neq: (col: string, v: unknown) => (filters.push(["neq", col, v]), q),
    not: (col: string, op: string, v: unknown) => (filters.push(["not", col, `${op}.${String(v)}`]), q),
    or: (expr: string) => (filters.push(["or", "", expr]), q),
    order: () => q,
    limit: async (n: number) => {
      if (h.error) return { data: null, error: h.error };
      const org = filters.find(([k, c]) => k === "eq" && c === "org_id")?.[2];
      const visible = h.rows.filter((r) => h.memberOf.has(r.org_id) && r.org_id === org)
        .filter((r) => filters.every(([k, c, v]) => k !== "neq" || (r as Record<string, unknown>)[c] !== v));
      return { data: visible.slice(0, n), error: null };
    },
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => ({
    from: (name: string) => table(name),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcs.push({ fn, args });
      return h.seedError ? { data: null, error: h.seedError } : { data: h.seedRows, error: null };
    },
  }),
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ current: { id: ORG } }) }));

const get = async (qs: string) => {
  const { GET } = await import("@/app/api/creative/durations/route");
  const res = await GET(new Request(`http://x/api/creative/durations?${qs}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  h.user = { id: "u" };
  h.memberOf = new Set([ORG]);
  h.error = null;
  h.asked = [];
  h.seedRows = [];
  h.seedError = null;
  h.rpcs = [];
  h.rows = [
    { org_id: ORG, started_at: at(0), finished_at: at(40), requested_model: "pic-1" },
    { org_id: OTHER, started_at: at(0), finished_at: at(900), requested_model: "pic-1" },
  ];
});

describe("GET /api/creative/durations", () => {
  it("signed out: 401, and the database is not asked", async () => {
    h.user = null;
    expect(await get(`org_id=${ORG}&models=pic-1`)).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(h.asked).toHaveLength(0);
  });

  it("a member's own organization: the finished jobs' seconds, read from creative_jobs for that org only", async () => {
    // One job is too little history, so the probe seed is asked for too: 0151 answered, with nothing for this model.
    expect(await get(`org_id=${ORG}&models=pic-1`)).toEqual({ status: 200, body: { durations: { "pic-1": [40] }, seeds: {} } });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]!.table).toBe("creative_jobs");
    expect(h.asked[0]!.filters).toContainEqual(["eq", "org_id", ORG]);
    expect(h.asked[0]!.filters).toContainEqual(["eq", "status", "completed"]);
  });

  it("another organization's id answers empty, like one with no jobs — never its times", async () => {
    const out = await get(`org_id=${OTHER}&models=pic-1`);
    expect(out).toEqual({ status: 200, body: { durations: { "pic-1": [] }, seeds: {} } });
    expect(JSON.stringify(out.body)).not.toContain("900");
  });

  it("no org_id (or a malformed one): the member's current organization", async () => {
    expect((await get(`models=pic-1`)).body).toEqual({ durations: { "pic-1": [40] }, seeds: {} });
    expect((await get(`org_id=not-a-uuid&models=pic-1`)).body).toEqual({ durations: { "pic-1": [40] }, seeds: {} });
  });

  it.each([
    ["missing", "org_id=" + ORG],
    ["empty", `org_id=${ORG}&models=`],
    ["a filter injection", `org_id=${ORG}&models=${encodeURIComponent('pic-1,"),or(org_id.neq.x')}`],
    ["upper case", `org_id=${ORG}&models=PIC-1`],
    ["too many (5)", `org_id=${ORG}&models=a1,b1,c1,d1,e1`],
  ])("a bad model list (%s): 400, and the database is not asked", async (_, qs) => {
    expect(await get(qs)).toEqual({ status: 400, body: { error: "invalid_params" } });
    expect(h.asked).toHaveLength(0);
  });

  it("a database without 0036: 503 creative_unavailable, not an empty history", async () => {
    h.error = { code: "42P01", message: 'relation "public.creative_jobs" does not exist' };
    expect(await get(`org_id=${ORG}&models=pic-1`)).toEqual({ status: 503, body: { error: "creative_unavailable" } });
  });

  it("any other failed read leaves the model out (its pill then says the history was not read)", async () => {
    h.error = { code: "57014", message: "canceling statement due to statement timeout" };
    expect(await get(`org_id=${ORG}&models=pic-1`)).toEqual({ status: 200, body: { durations: {} } });
    // An unread history is not "too little": no seed is asked for it.
    expect(h.rpcs).toHaveLength(0);
  });
});

describe("GET /api/creative/durations: the probe seed (0151)", () => {
  const SEED_ROW = {
    model_id: "vid-1",
    capability: "i2v",
    probe_seconds: 70.976,
    clip_seconds: 5,
    probed_at: "2026-11-10T09:00:00Z",
    failed_after: false,
  };

  it("a model with too little history here gets the platform's test run, asked with the member's session for that model only", async () => {
    h.seedRows = [SEED_ROW];
    // This stand-in answers by organization only (the model filter is PostgREST's): one model's rows, so one model is named.
    h.rows = [{ org_id: ORG, started_at: at(0), finished_at: at(60), requested_model: "vid-1" }];
    const out = await get(`org_id=${ORG}&models=vid-1`);
    expect(out).toEqual({
      status: 200,
      body: {
        durations: { "vid-1": [60] },
        seeds: { "vid-1": [{ capability: "i2v", seconds: 70.976, clipSeconds: 5, probedAt: "2026-11-10T09:00:00Z", failedAfter: false }] },
      },
    });
    expect(h.rpcs).toEqual([{ fn: "model_probe_seconds", args: { p_models: ["vid-1"] } }]);
  });

  it("one seed per capability the model was probed for: a newer t2v probe does not hide the i2v one", async () => {
    h.seedRows = [SEED_ROW, { ...SEED_ROW, capability: "t2v", probe_seconds: 40, clip_seconds: null, probed_at: "2026-11-11T09:00:00Z" }];
    h.rows = [];
    const seeds = (await get(`org_id=${ORG}&models=vid-1`)).body.seeds as Record<string, { capability: string; seconds: number }[]>;
    expect(seeds["vid-1"]!.map((s) => [s.capability, s.seconds])).toEqual([
      ["i2v", 70.976],
      ["t2v", 40],
    ]);
  });

  it("a model with enough history of its own is not asked about: the workspace's median wins", async () => {
    h.seedRows = [{ ...SEED_ROW, model_id: "pic-1", capability: "t2i" }];
    h.rows.push(
      { org_id: ORG, started_at: at(0), finished_at: at(50), requested_model: "pic-1" },
      { org_id: ORG, started_at: at(0), finished_at: at(45), requested_model: "pic-1" },
    );
    expect(await get(`org_id=${ORG}&models=pic-1`)).toEqual({ status: 200, body: { durations: { "pic-1": [40, 50, 45] } } });
    expect(h.rpcs).toHaveLength(0);
  });

  it.each([
    ["0151 not applied (PostgREST)", { code: "PGRST202", message: "Could not find the function public.model_probe_seconds(p_models)" }],
    ["0151 not applied (Postgres)", { code: "42883", message: "function public.model_probe_seconds(text[]) does not exist" }],
    ["any other error", { code: "57014", message: "canceling statement due to statement timeout" }],
  ])("%s: no seed and no error — the history as before, and the pill counts seconds", async (_, err) => {
    h.seedError = err;
    expect(await get(`org_id=${ORG}&models=pic-1`)).toEqual({ status: 200, body: { durations: { "pic-1": [40] } } });
  });

  it("a row for a model not asked about, or one that does not read whole, is dropped — never patched into a number", async () => {
    h.seedRows = [
      { ...SEED_ROW, model_id: "other-1" },
      { ...SEED_ROW, model_id: "pic-1", probe_seconds: "70" },
      { ...SEED_ROW, model_id: "pic-1", failed_after: null },
    ];
    expect((await get(`org_id=${ORG}&models=pic-1`)).body).toEqual({ durations: { "pic-1": [40] }, seeds: {} });
  });
});

describe("GET /api/creative/durations (continued)", () => {
  it("signed out still asks for no seed", async () => {
    h.user = null;
    await get(`org_id=${ORG}&models=pic-1`);
    expect(h.rpcs).toHaveLength(0);
  });
});
