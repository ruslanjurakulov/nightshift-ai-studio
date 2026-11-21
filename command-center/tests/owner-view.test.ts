import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/server/owner-view: what a customer page draws for the platform operator. What would break without these: the owner's
 * User account seeing operator-only things (hidden preview models, the whole registry); a customer who sets the cookie by
 * hand being drawn the operator's view; the Owner account being decided by the cookie instead of the database.
 */
vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ operator: true, cookie: undefined as string | undefined, access: "owner" as string }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "ns_owner_mode" && h.cookie !== undefined ? { value: h.cookie } : undefined) }),
}));
vi.mock("@/lib/auth/org-roles", () => ({ isOperator: async () => h.operator }));
vi.mock("@/lib/server/owner-analytics", () => ({ ownerAccess: async () => h.access }));

const load = async () => {
  vi.resetModules();
  return import("@/lib/server/owner-view");
};

beforeEach(() => {
  h.operator = true;
  h.cookie = undefined;
  h.access = "owner";
});

describe("viewingAsOperator", () => {
  it("is the Owner account by default, and the User account once the owner switched to it", async () => {
    expect(await (await load()).viewingAsOperator()).toBe(true);
    h.cookie = "off";
    expect(await (await load()).viewingAsOperator()).toBe(false);
  });

  it("keeps an admin who is not the owner in the operator's view, even with an old 'off' cookie (no switch to come back)", async () => {
    h.cookie = "off";
    for (const access of ["denied", "error", "missing"]) {
      h.access = access;
      expect(await (await load()).viewingAsOperator(), access).toBe(true);
    }
  });

  it("never draws the operator's view for a customer, whatever cookie they set", async () => {
    h.operator = false;
    h.cookie = "on";
    expect(await (await load()).viewingAsOperator()).toBe(false);
  });
});

describe("isPlatformOwner", () => {
  it("is yes only when the database says owner: denied, missing and error are all no", async () => {
    expect(await (await load()).isPlatformOwner()).toBe(true);
    for (const access of ["denied", "missing", "error", "signed_out"]) {
      h.access = access;
      expect(await (await load()).isPlatformOwner(), access).toBe(false);
    }
  });
});
