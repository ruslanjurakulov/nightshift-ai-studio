/**
 * app/api/org/switch: the organization switch as a form-post navigation (used when leaving the editor's page, whose
 * unsaved-changes prompt must run first). The route checks the origin, the session and the caller's membership like
 * /api/org/select, sets the organization cookie, forgets the remembered channel and answers 303 to /all-channels,
 * which the next request resolves under the new organization; anything else changes no cookie.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state: {
  user: { id: string } | null;
  orgs: { data: unknown; error: { message: string } | null };
  /** The caller's own org_members rows (switchableFor). */
  members: { data: unknown; error: { message: string } | null };
  /** [table, select's columns, eq column, eq value] for every read. */
  memberFilter: Array<[string, unknown, string, unknown]>;
  rpcCalls: string[];
} = { user: { id: "u1" }, orgs: { data: [], error: null }, members: { data: [], error: null }, memberFilter: [], rpcCalls: [] };

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => state.user,
  createClient: async () => ({
    rpc: async (fn: string) => {
      state.rpcCalls.push(fn);
      return fn === "my_organizations" ? state.orgs : { data: null, error: null };
    },
    from: (table: string) => ({
      select: (columns: unknown) => ({
        eq: async (col: string, value: unknown) => {
          state.memberFilter.push([table, columns, col, value]);
          return table === "org_members" ? state.members : { data: null, error: { message: "unexpected table" } };
        },
      }),
    }),
  }),
}));

const { POST } = await import("../app/api/org/switch/route");
const { ORG_COOKIE } = await import("../lib/orgs");
const { CHANNEL_COOKIE } = await import("../lib/channels");

const ORGS = [
  { id: "0a000000-0000-4000-8000-00000000000a", name: "A", slug: "a", role: "owner", is_default: true },
  { id: "0b000000-0000-4000-8000-00000000000b", name: "B", slug: "b", role: "viewer", is_default: false },
];
const ORIGIN = "https://app.example.test";

function post(body: string, headers: Record<string, string> = {}) {
  return POST(
    new Request(`${ORIGIN}/api/org/switch`, {
      method: "POST",
      body,
      headers: {
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
        referer: `${ORIGIN}/chronos/editor/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        ...headers,
      },
    }),
  );
}
const cookie = (res: Response, name: string) =>
  (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""]).find((c) => c.startsWith(`${name}=`)) ?? null;

/** What my_organizations() answers a platform owner: every org, a customer's included, each with the platform role. */
const CUSTOMER = { id: "0c000000-0000-4000-8000-00000000000c", name: "Customer", slug: "customer", role: "owner", is_default: false };
const PLATFORM_ORGS = [{ ...ORGS[0], role: "owner" }, { ...ORGS[1], role: "owner" }, CUSTOMER];

beforeEach(() => {
  delete process.env.APP_ORIGIN;
  state.user = { id: "u1" };
  state.orgs = { data: ORGS, error: null };
  state.members = { data: [{ org_id: ORGS[0].id }, { org_id: ORGS[1].id }], error: null };
  state.memberFilter = [];
  state.rpcCalls = [];
});

describe("the form-post organization switch", () => {
  it("a member's switch sets the organization, forgets the channel and redirects 303 to /all-channels", async () => {
    const res = await post(`orgId=${ORGS[1].id}`);
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/all-channels");
    expect(cookie(res, ORG_COOKIE)).toContain(ORGS[1].id);
    expect(cookie(res, CHANNEL_COOKIE)).toContain("all-channels");
    expect(state.rpcCalls).toEqual(["my_organizations"]);
  });

  it("an organization the caller is not a member of changes nothing and goes back to the page it came from", async () => {
    const res = await post("orgId=0c000000-0000-4000-8000-00000000000c");
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/chronos/editor/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(cookie(res, ORG_COOKIE)).toBeNull();
  });

  it("no session: to the sign-in page, no cookie, the database not asked", async () => {
    state.user = null;
    const res = await post(`orgId=${ORGS[1].id}`);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(cookie(res, ORG_COOKIE)).toBeNull();
    expect(state.rpcCalls).toEqual([]);
  });

  it("another origin is refused (the same-origin rule of every POST route)", async () => {
    const res = await post(`orgId=${ORGS[1].id}`, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(cookie(res, ORG_COOKIE)).toBeNull();
    expect(state.rpcCalls).toEqual([]);
  });

  it("a JSON body, an empty or oversized form, or a failing membership read changes nothing", async () => {
    for (const r of [
      await post(JSON.stringify({ orgId: ORGS[1].id }), { "content-type": "application/json" }),
      await post(`orgId=${ORGS[1].id}`, { "content-type": "text/plain" }),
      await post(""),
      await post(`orgId=${ORGS[1].id}&pad=${"x".repeat(2000)}`),
    ]) {
      expect(r.status).toBe(303);
      expect(cookie(r, ORG_COOKIE)).toBeNull();
    }
    state.orgs = { data: null, error: { message: "boom" } };
    expect(cookie(await post(`orgId=${ORGS[1].id}`), ORG_COOKIE)).toBeNull();
  });

  it("a platform admin cannot switch into a customer's org they can read but do not belong to", async () => {
    state.orgs = { data: PLATFORM_ORGS, error: null };
    const res = await post(`orgId=${CUSTOMER.id}`);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/chronos/editor/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(cookie(res, ORG_COOKIE)).toBeNull();
    // Their OWN rows, org ids only: without the user_id filter, RLS hands a platform admin every org's members.
    expect(state.memberFilter).toEqual([["org_members", "org_id", "user_id", "u1"]]);
  });

  it("a platform admin still switches into an org they are a member of, and into the default org", async () => {
    state.orgs = { data: PLATFORM_ORGS, error: null };
    expect(cookie(await post(`orgId=${ORGS[1].id}`), ORG_COOKIE)).toContain(ORGS[1].id);
    // A member of nothing: the default org stays reachable for every platform role.
    state.members = { data: [], error: null };
    expect(cookie(await post(`orgId=${ORGS[0].id}`), ORG_COOKIE)).toContain(ORGS[0].id);
  });

  it("a failed membership read goes back to the page unchanged (as a failed my_organizations does); the default org stays reachable", async () => {
    state.orgs = { data: PLATFORM_ORGS, error: null };
    state.members = { data: null, error: { message: "boom" } };
    for (const id of [ORGS[1].id, CUSTOMER.id]) {
      const res = await post(`orgId=${id}`);
      expect(res.status).toBe(303);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/chronos/editor/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      expect(cookie(res, ORG_COOKIE)).toBeNull();
      expect(cookie(res, CHANNEL_COOKIE)).toBeNull();
    }
    expect(cookie(await post(`orgId=${ORGS[0].id}`), ORG_COOKIE)).toContain(ORGS[0].id);
  });

  it("a customer's list is never narrowed and costs no membership read", async () => {
    state.orgs = { data: [{ ...ORGS[1], role: "owner" }, CUSTOMER], error: null };
    state.members = { data: null, error: { message: "would fail closed if it were asked" } };
    expect(cookie(await post(`orgId=${CUSTOMER.id}`), ORG_COOKIE)).toContain(CUSTOMER.id);
    expect(state.memberFilter).toEqual([]);
  });

  it("a same-origin referer whose path would leave the site is not followed back (no open redirect)", async () => {
    for (const path of ["//evil.example/steal", "/\\evil.example/steal", "/../..//evil.example/steal"]) {
      const res = await post("orgId=nope", { referer: `${ORIGIN}${path}` });
      const to = new URL(res.headers.get("location")!);
      expect(to.origin, path).toBe(ORIGIN);
      expect(to.host, path).not.toContain("evil");
    }
  });

  it("a foreign referer is not followed back", async () => {
    const res = await post("orgId=nope", { referer: "https://evil.example/steal" });
    expect(new URL(res.headers.get("location")!).origin).toBe(ORIGIN);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });
});
