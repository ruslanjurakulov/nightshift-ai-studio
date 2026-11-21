import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY, FAILED, NO_ROW, supabaseStub, type StubResult } from "./helpers/supabaseStub";

/**
 * GET /api/credits/account — what the header's credit pill and the Studio's price key re-read after a generation starts, is cancelled
 * or finishes (lib/credits-live.ts). Signed in, the organization being viewed only, the member's own RLS read; a failed read is a 503
 * (unknown), never a zero; a missing row is a real 0.
 */

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  client: null as unknown,
  user: { id: "u1", email: "me@example.com" } as { id: string; email: string } | null,
  role: { ok: true } as { ok: boolean; status?: number; error?: string },
  asked: [] as unknown[],
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => h.client,
  getUser: async () => h.user,
}));
vi.mock("@/lib/auth/org-roles", () => ({
  requireOrgRole: async (target: unknown) => {
    h.asked.push(target);
    return h.role;
  },
}));

const { GET } = await import("../app/api/credits/account/route");

const ORG = "0a000000-0000-4000-8000-00000000000a";
const call = async (q = `?org_id=${ORG}`) => {
  const res = await GET(new Request(`http://x/api/credits/account${q}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const setup = (account: StubResult) => {
  h.client = supabaseStub((name) => (name === "credit_accounts" ? account : EMPTY));
};

beforeEach(() => {
  h.user = { id: "u1", email: "me@example.com" };
  h.role = { ok: true };
  h.asked = [];
  setup({ data: { balance: 400, reserved: 25 }, error: null });
});

describe("GET /api/credits/account", () => {
  it("answers the account as it is now: balance, held and available", async () => {
    expect(await call()).toEqual({ status: 200, body: { supported: true, account: { balance: 400, reserved: 25, available: 375 } } });
    expect(h.asked).toEqual([{ orgId: ORG }]);
  });

  it("signed out is 401 and asks nothing", async () => {
    h.user = null;
    expect((await call()).status).toBe(401);
    expect(h.asked).toEqual([]);
  });

  it("another organization than the one being viewed is not found (requireOrgRole's answer)", async () => {
    h.role = { ok: false, status: 404, error: "not_found" };
    expect(await call()).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("a malformed id is refused before anything is read", async () => {
    expect((await call("?org_id=nope")).status).toBe(400);
    expect(h.asked).toEqual([]);
  });

  it("a failed read is unknown (503), never a zero; no row is a real 0", async () => {
    setup(FAILED);
    expect(await call()).toEqual({ status: 503, body: { error: "credits_read_failed" } });
    setup(NO_ROW);
    expect(await call()).toEqual({ status: 200, body: { supported: true, account: { balance: 0, reserved: 0, available: 0 } } });
  });
});
