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
}));

/** A PostgREST builder that records its filters and answers on `.limit()` as RLS would. */
function table(name: string) {
  const filters: [string, string, unknown][] = [];
  h.asked.push({ table: name, filters });
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => (filters.push(["eq", col, v]), q),
    not: (col: string, op: string, v: unknown) => (filters.push(["not", col, `${op}.${String(v)}`]), q),
    or: (expr: string) => (filters.push(["or", "", expr]), q),
    order: () => q,
    limit: async (n: number) => {
      if (h.error) return { data: null, error: h.error };
      const org = filters.find(([k, c]) => k === "eq" && c === "org_id")?.[2];
      const visible = h.rows.filter((r) => h.memberOf.has(r.org_id) && r.org_id === org);
      return { data: visible.slice(0, n), error: null };
    },
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => ({ from: (name: string) => table(name) }),
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
    expect(await get(`org_id=${ORG}&models=pic-1`)).toEqual({ status: 200, body: { durations: { "pic-1": [40] } } });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]!.table).toBe("creative_jobs");
    expect(h.asked[0]!.filters).toContainEqual(["eq", "org_id", ORG]);
    expect(h.asked[0]!.filters).toContainEqual(["eq", "status", "completed"]);
  });

  it("another organization's id answers empty, like one with no jobs — never its times", async () => {
    const out = await get(`org_id=${OTHER}&models=pic-1`);
    expect(out).toEqual({ status: 200, body: { durations: { "pic-1": [] } } });
    expect(JSON.stringify(out.body)).not.toContain("900");
  });

  it("no org_id (or a malformed one): the member's current organization", async () => {
    expect((await get(`models=pic-1`)).body).toEqual({ durations: { "pic-1": [40] } });
    expect((await get(`org_id=not-a-uuid&models=pic-1`)).body).toEqual({ durations: { "pic-1": [40] } });
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
  });
});
