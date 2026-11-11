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
  rpcCalls: string[];
} = { user: { id: "u1" }, orgs: { data: [], error: null }, rpcCalls: [] };

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => state.user,
  createClient: async () => ({
    rpc: async (fn: string) => {
      state.rpcCalls.push(fn);
      return fn === "my_organizations" ? state.orgs : { data: null, error: null };
    },
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

beforeEach(() => {
  delete process.env.APP_ORIGIN;
  state.user = { id: "u1" };
  state.orgs = { data: ORGS, error: null };
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

  it("a foreign referer is not followed back", async () => {
    const res = await post("orgId=nope", { referer: "https://evil.example/steal" });
    expect(new URL(res.headers.get("location")!).origin).toBe(ORIGIN);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });
});
