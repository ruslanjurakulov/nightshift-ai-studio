import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The platform role (lib/auth/roles.ts) fails CLOSED.
 *
 * What would break without these: a failed roster lookup — a database hiccup,
 * a timeout, a revoked grant — used to read as 'owner', so for as long as it
 * lasted every signed-in account could write the operator's GitHub secrets,
 * top up providers and change billing settings (security audit C4). And since
 * migration 0033 a signed-in customer off the roster gets NULL, which must
 * never be mistaken for a role.
 */

vi.mock("server-only", () => ({}));

const state: {
  configured: boolean;
  user: { id: string } | null;
  rpc: () => Promise<{ data: unknown; error: unknown }>;
} = { configured: true, user: { id: "u1" }, rpc: async () => ({ data: null, error: null }) };

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => state.user,
  createClient: async () => (state.configured ? { rpc: () => state.rpc() } : null),
}));

const { requireRole, resolvePlatformRole, resolveRole } = await import("../lib/auth/roles");

beforeEach(() => {
  state.configured = true;
  state.user = { id: "u1" };
  state.rpc = async () => ({ data: null, error: null });
});

describe("platform role", () => {
  it("is nothing when the roster lookup errors", async () => {
    state.rpc = async () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    expect(await resolvePlatformRole()).toBeNull();
    expect(await requireRole("admin")).toBeNull();
    expect(await requireRole("viewer")).toBeNull();
    expect(await resolveRole()).toBe("viewer");
  });

  it("is nothing when the lookup throws", async () => {
    state.rpc = async () => {
      throw new Error("fetch failed");
    };
    expect(await requireRole("admin")).toBeNull();
  });

  it("is nothing when the function is missing (no pre-0007 all-admin fallback)", async () => {
    state.rpc = async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    expect(await requireRole("editor")).toBeNull();
  });

  it("is nothing for a signed-in customer off the roster (0033 returns NULL)", async () => {
    state.rpc = async () => ({ data: null, error: null });
    expect(await resolvePlatformRole()).toBeNull();
    expect(await requireRole("viewer")).toBeNull();
  });

  it("is nothing for a value that is not a role", async () => {
    state.rpc = async () => ({ data: "superuser", error: null });
    expect(await requireRole("viewer")).toBeNull();
  });

  it("is nothing when signed out", async () => {
    state.user = null;
    expect(await requireRole("viewer")).toBeNull();
  });

  it("is the roster role when the lookup answers", async () => {
    state.rpc = async () => ({ data: "admin", error: null });
    expect(await requireRole("admin")).toBe("admin");
    expect(await requireRole("owner")).toBeNull();
  });

  it("stays owner only with no Supabase configured at all (local development)", async () => {
    state.configured = false;
    expect(await requireRole("admin")).toBe("owner");
  });
});
