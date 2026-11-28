import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An old invite link joins nobody to anything. The site has the operator and users, each user owns their own workspace, and
 * the Team page with its roles is gone (migration 0233 closes the roster to browsers, 0091 closed the workspace side).
 * /i/<token> and /api/invite/join are "Invite friends" (0092): they count a NEW account toward a credit reward for the link's
 * owner and never made anyone a member. What would break without these: a route that starts writing a membership row, or calls
 * a membership function, for whoever opens a link; or an old link that 500s instead of landing on a plain page.
 */

vi.mock("server-only", () => ({}));

const MEMBERSHIP = /^(owner_(add|set|remove)_member|invite_org_member|accept_org_invite|decline_org_invite|bind_org_memberships|create_organization)$/;

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  peek: true as unknown,
  rpc: vi.fn(),
  from: vi.fn(),
  jar: new Map<string, string>(),
}));

vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: h.rpc, from: h.from }),
  getUser: async () => h.user,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string, opts?: { maxAge?: number }) => {
      if (opts?.maxAge === 0) h.jar.delete(name);
      else h.jar.set(name, value);
    },
  }),
}));

const { GET } = await import("@/app/i/[token]/route");
const { POST: joinRoute } = await import("@/app/api/invite/join/route");
const { INVITE_COOKIE } = await import("@/lib/friend-invites");

const TOKEN = "0123456789abcdef0123456789abcdef";
let ip = 0;
const visit = (token: string) =>
  GET(new Request(`https://nightshift.test/i/${token}`, { headers: { "x-nightshift-client-ip": `198.51.100.${++ip % 250}` } }), {
    params: Promise.resolve({ token }),
  });
const called = () => h.rpc.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  h.user = null;
  h.peek = true;
  h.jar.clear();
  h.from.mockReset();
  h.rpc.mockReset();
  h.rpc.mockImplementation(async (fn: string) => {
    if (fn === "friend_invite_peek") return { data: h.peek, error: null };
    if (fn === "take_web_rate") return { data: true, error: null };
    return { data: { status: "counted" }, error: null };
  });
});

describe("an old invite link adds nobody", () => {
  it.each([
    ["signed out, live link", null, true],
    ["signed out, dead link", null, false],
    ["signed in", { id: "u-1" }, true],
  ] as const)("%s: a redirect to a plain page, no table touched, no membership function called", async (_label, user, live) => {
    h.user = user;
    h.peek = live;
    const res = await visit(TOKEN);
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(["/signup", "/invite"]).toContain(to.pathname);
    expect(h.from).not.toHaveBeenCalled();
    expect(called().filter((fn) => MEMBERSHIP.test(fn))).toEqual([]);
    // the only database question a visit asks is whether the link is live
    expect(called().every((fn) => fn === "friend_invite_peek")).toBe(true);
  });

  it("a malformed token is the neutral page without a database call", async () => {
    const res = await visit("../../members");
    expect(new URL(res.headers.get("location")!).pathname).toBe("/invite");
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
  });

  it("the sign-up join route records a friend's join and nothing else: no membership function, no table", async () => {
    h.user = { id: "u-new" };
    h.jar.set(INVITE_COOKIE, TOKEN);
    const res = await joinRoute(new Request("https://nightshift.test/api/invite/join", { method: "POST", headers: { origin: "https://nightshift.test" } }));
    expect(res.status).toBe(200);
    // the person's own rate allowance, then the friend-invite join: nothing that makes a member
    expect(called()).toEqual(["take_web_rate", "join_friend_invite"]);
    expect(h.from).not.toHaveBeenCalled();
  });

  it("neither route, nor the invite notice page, names a membership table or function in its source", () => {
    const root = join(__dirname, "..");
    for (const file of ["app/i/[token]/route.ts", "app/api/invite/join/route.ts", "app/invite/page.tsx", "lib/server/friend-invites.ts", "lib/friend-invites.ts"]) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src, file).not.toMatch(/org_members|app_members|owner_(add|set|remove)_member|invite_org_member|accept_org_invite/);
    }
    // and the Team page's own write route is gone
    expect(existsSync(join(root, "app/api/owner/team/route.ts"))).toBe(false);
  });
});

describe("the old Team page", () => {
  it("only redirects to Settings: no roster read, no role, no write control", () => {
    const src = readFileSync(join(__dirname, "..", "app/(app)/[channel]/members/page.tsx"), "utf8");
    expect(src).toMatch(/redirect\(path\("\/organization"\)\)/);
    expect(src).not.toMatch(/from\(|rpc\(|MembersBoard|resolveRole/);
  });
});
