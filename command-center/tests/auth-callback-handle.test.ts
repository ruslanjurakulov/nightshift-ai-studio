import { beforeEach, describe, expect, it, vi } from "vitest";

// The username chosen at sign-up rides in the new account's metadata and is
// applied on the first session: here, when the confirmation link is exchanged.
const h = vi.hoisted(() => ({
  meta: {} as Record<string, unknown>,
  own: null as unknown,
  rpc: vi.fn(async (_fn: string, _args?: unknown) => ({ data: { code: "ok", handle: "ana.k" } as unknown, error: null as unknown })),
  jar: new Map<string, string>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({ data: { user: { id: "u" }, session: null, redirectType: null }, error: null }),
      getUser: async () => ({ data: { user: { user_metadata: h.meta } } }),
    },
    from: () => ({ select: () => ({ maybeSingle: async () => ({ data: h.own, error: null }) }) }),
    rpc: h.rpc,
  }),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { verifyOtp: vi.fn() } }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));

const { GET } = await import("@/app/auth/callback/route");
const land = async () => new URL((await GET(new Request("https://nightshift.test/auth/callback?code=abc&next=/welcome"))).headers.get("location")!).pathname;
const setHandleCalls = () => h.rpc.mock.calls.filter((c) => c[0] === "set_handle");

beforeEach(() => {
  h.meta = {};
  h.own = null;
  h.rpc.mockReset().mockResolvedValue({ data: { code: "ok", handle: "ana.k" }, error: null });
});

describe("the first session applies the handle chosen at sign-up", () => {
  it("sets it once through set_handle, and the sign-in goes on", async () => {
    h.meta = { signup_handle: "Ana.K" };
    expect(await land()).toBe("/welcome");
    expect(setHandleCalls()).toEqual([["set_handle", { p_handle: "ana.k" }]]);
  });

  it("a name taken meanwhile does not block the account", async () => {
    h.meta = { signup_handle: "ana.k" };
    h.rpc.mockResolvedValue({ data: { code: "taken" }, error: null });
    expect(await land()).toBe("/welcome");
  });

  it("a failing database does not block the account either", async () => {
    h.meta = { signup_handle: "ana.k" };
    h.rpc.mockRejectedValue(new Error("down"));
    expect(await land()).toBe("/welcome");
  });

  it("does nothing for an account with no chosen handle or one that already has a handle", async () => {
    expect(await land()).toBe("/welcome");
    h.meta = { signup_handle: "ana.k" };
    h.own = { handle: "already" };
    expect(await land()).toBe("/welcome");
    expect(setHandleCalls()).toEqual([]);
  });

  it("never applies a reserved or malformed name from the metadata", async () => {
    for (const bad of ["admin", "a..b", "nightshift_x"]) {
      h.meta = { signup_handle: bad };
      await land();
    }
    expect(setHandleCalls()).toEqual([]);
  });
});
