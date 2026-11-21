import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/account/owner-mode: the avatar menu's account switcher (User / Owner). What would break without these: a
 * customer (or a signed-out caller, or another site) setting the preference; an admin who is not the platform owner
 * switching to the Owner account; a failed role or owner lookup read as "not the operator" or as "the owner"; a body that
 * is not a boolean being taken as one; the cookie being readable by page scripts.
 */
vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  lookup: { operator: true, failed: false },
  owner: "owner" as string,
}));

vi.mock("@/lib/supabase/server", () => ({ getUser: async () => h.user }));
vi.mock("@/lib/auth/org-roles", () => ({ operatorLookup: async () => h.lookup }));
vi.mock("@/lib/server/owner-analytics", () => ({ ownerAccess: async () => h.owner }));

const { POST } = await import("../app/api/account/owner-mode/route");

const ORIGIN = "http://localhost";
const post = (body: unknown, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/api/account/owner-mode`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  h.user = { id: "u1" };
  h.lookup = { operator: true, failed: false };
  h.owner = "owner";
});

describe("account switcher (User / Owner)", () => {
  it("lets the platform owner switch to User and back to Owner, as an http-only cookie", async () => {
    const off = await POST(post({ on: false }));
    expect(off.status).toBe(200);
    const cookie = off.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("ns_owner_mode=off");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect((await POST(post({ on: true }))).headers.get("set-cookie")).toContain("ns_owner_mode=on");
  });

  it("refuses an admin who is not the platform owner the Owner account, but lets them back to User", async () => {
    h.owner = "denied";
    const res = await POST(post({ on: true }));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await POST(post({ on: false }))).status).toBe(200);
  });

  it("answers 503 when the owner check cannot be made, never guessing the owner", async () => {
    for (const owner of ["error", "missing"]) {
      h.owner = owner;
      const res = await POST(post({ on: true }));
      expect(res.status, owner).toBe(503);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("refuses a customer, and sets nothing", async () => {
    h.lookup = { operator: false, failed: false };
    const res = await POST(post({ on: true }));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers 503 when the role cannot be read, rather than guessing either way", async () => {
    h.lookup = { operator: false, failed: true };
    const res = await POST(post({ on: false }));
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a signed-out caller, another site, and a body that is not a boolean", async () => {
    h.user = null;
    expect((await POST(post({ on: true }))).status).toBe(401);
    h.user = { id: "u1" };
    expect((await POST(post({ on: true }, "https://evil.example"))).status).toBe(403);
    expect((await POST(post({ on: "yes" }))).status).toBe(400);
    expect((await POST(post("not json"))).status).toBe(400);
  });
});
