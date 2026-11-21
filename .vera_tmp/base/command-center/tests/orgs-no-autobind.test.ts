import { describe, expect, it, vi } from "vitest";

/**
 * getOrgContext runs on every page load. It used to call
 * bind_org_memberships() first, which bound every invite addressed to the
 * caller's email — putting them into organizations they never agreed to join
 * (security audit C6). Invites are accepted explicitly now (migration 0043).
 */

vi.mock("server-only", () => ({}));

const calls: string[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "ivan@a.test" } } }) },
    rpc: async (fn: string) => {
      calls.push(fn);
      return fn === "my_organizations"
        ? { data: [{ id: "o1", name: "Mine", slug: "mine", role: "owner", is_default: false }], error: null }
        : { data: 0, error: null };
    },
  }),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

const { getOrgContext } = await import("../lib/orgs-server");

describe("getOrgContext", () => {
  it("reads the caller's organizations without binding any invite", async () => {
    const ctx = await getOrgContext();
    expect(ctx.supported).toBe(true);
    expect(calls).toContain("my_organizations");
    expect(calls).not.toContain("bind_org_memberships");
  });
});
