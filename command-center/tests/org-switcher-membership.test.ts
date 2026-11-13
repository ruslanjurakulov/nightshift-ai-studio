/**
 * The header's organization switcher lists the orgs the caller BELONGS to, not every org they can read.
 *
 * my_organizations() (accessible_org_ids, migration 0043) gives a platform owner/admin every organization on the
 * platform — what they may READ (`orgs`). But the switcher listed every customer, and a remembered cookie could leave
 * the operator's own Command Center acting inside a customer's workspace. `switchable` (lib/orgs.ts switchableOrgs,
 * lib/orgs-server.ts switchableFor) is their own bound memberships plus the default org, and `current` is resolved
 * from it, so role checks (which read `current`) resolve against those orgs too: the operator cannot act inside a
 * customer's workspace. That is intended (owner decision, 2026-11-13); support is read-only through Customers.
 * What would break without these tests: customers reappearing in the owner's switcher, the owner landing in a
 * customer's org from an old cookie, a customer's own list being narrowed, an operator who belongs to nothing being
 * sent to /welcome, a failed membership read showing every org again, or a failed read quietly moving a remembered
 * workspace to the default org (writes landing in the wrong org).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state: {
  orgs: { data: unknown; error: { message: string; code?: string } | null };
  members: { data: unknown; error: { message: string } | null } | "throw";
  /** [table, select's columns, eq column, eq value] for every org_members read. */
  memberReads: Array<[string, unknown, string, unknown]>;
  cookie: string | undefined;
  user: { id: string } | null;
} = { orgs: { data: [], error: null }, members: { data: [], error: null }, memberReads: [], cookie: undefined, user: null };

vi.mock("@/lib/supabase/server", () => {
  const client = () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    rpc: async (fn: string) => (fn === "my_organizations" ? state.orgs : { data: null, error: null }),
    from: (table: string) => ({
      select: (columns: unknown) => ({
        eq: async (col: string, value: unknown) => {
          state.memberReads.push([table, columns, col, value]);
          if (state.members === "throw") throw new Error("network");
          return state.members;
        },
      }),
    }),
  });
  return { createClient: async () => client(), getUser: async () => state.user };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "nightshift_org" && state.cookie ? { value: state.cookie } : undefined) }),
}));

const { getOrgContext } = await import("../lib/orgs-server");
const { POST: select } = await import("../app/api/org/select/route");
const { DEFAULT_ORG_ID, ORG_COOKIE, membershipCanNarrow, switchableOrgs, coerceMemberOrgIds } = await import("../lib/orgs");

const NIGHTSHIFT = { id: DEFAULT_ORG_ID, name: "Nightshift", slug: "nightshift", role: "owner" as const, is_default: true };
const OWN_TEST = { id: "0d000000-0000-4000-8000-00000000000d", name: "My test", slug: "my-test", role: "owner" as const, is_default: false };
const NEW = { id: "0e000000-0000-4000-8000-00000000000e", name: "new", slug: "new", role: "owner" as const, is_default: false };
const MEDIA = { id: "0f000000-0000-4000-8000-00000000000f", name: "ruslan-media", slug: "ruslan-media", role: "owner" as const, is_default: false };
/** The live shape for the platform owner: every org, each carrying the platform role, so `role` proves nothing. */
const EVERY_ORG = [NIGHTSHIFT, NEW, MEDIA];

beforeEach(() => {
  state.user = { id: "u-owner" };
  state.orgs = { data: EVERY_ORG, error: null };
  state.members = { data: [{ org_id: DEFAULT_ORG_ID }], error: null };
  state.memberReads = [];
  state.cookie = undefined;
});

describe("switchableOrgs (pure)", () => {
  it("narrows a platform admin's list to their memberships plus the default org", () => {
    expect(switchableOrgs([NIGHTSHIFT, OWN_TEST, NEW, MEDIA], new Set([OWN_TEST.id])).map((o) => o.id)).toEqual([
      NIGHTSHIFT.id,
      OWN_TEST.id,
    ]);
  });

  it("never narrows a list without the default org, or a single org: that is already the caller's memberships", () => {
    expect(membershipCanNarrow([NEW, MEDIA])).toBe(false);
    expect(membershipCanNarrow([NIGHTSHIFT])).toBe(false);
    expect(switchableOrgs([NEW, MEDIA], new Set())).toEqual([NEW, MEDIA]);
    expect(switchableOrgs([NEW, MEDIA], null)).toEqual([NEW, MEDIA]);
  });

  it("a failed membership read (null) keeps the default org only — never every org, never none", () => {
    expect(switchableOrgs(EVERY_ORG, null)).toEqual([NIGHTSHIFT]);
  });

  it("reads org ids out of rows and drops malformed ones; a non-array is a failed read", () => {
    expect([...(coerceMemberOrgIds([{ org_id: "a" }, { org_id: "" }, { org_id: 3 }, null, { org_id: "a" }]) ?? [])]).toEqual(["a"]);
    expect(coerceMemberOrgIds(null)).toBeNull();
    expect(coerceMemberOrgIds({ org_id: "a" })).toBeNull();
  });
});

describe("getOrgContext", () => {
  it("the platform owner's switcher holds only their own org, while `orgs` still holds every org", async () => {
    const ctx = await getOrgContext();
    expect(ctx.supported).toBe(true);
    expect(ctx.switchable.map((o) => o.slug)).toEqual(["nightshift"]);
    // `orgs` still holds what they may READ (RLS, Customers, canCarryRun). Role checks read `current`, which comes
    // from `switchable`, so acting inside a customer's workspace is not possible (intended; support is read-only).
    expect(ctx.orgs.map((o) => o.slug)).toEqual(["nightshift", "new", "ruslan-media"]);
    // Their own rows only, and the org ids only: the select policy would hand a platform admin every org's member rows.
    expect(state.memberReads).toEqual([["org_members", "org_id", "user_id", "u-owner"]]);
  });

  it("a remembered cookie naming a customer's org resolves to the operator's own default org", async () => {
    state.cookie = NEW.id;
    expect((await getOrgContext()).current?.id).toBe(DEFAULT_ORG_ID);
  });

  it("a remembered cookie naming another org the operator IS a member of is still honoured", async () => {
    state.orgs = { data: [NIGHTSHIFT, OWN_TEST, NEW], error: null };
    state.members = { data: [{ org_id: DEFAULT_ORG_ID }, { org_id: OWN_TEST.id }], error: null };
    state.cookie = OWN_TEST.id;
    const ctx = await getOrgContext();
    expect(ctx.current?.id).toBe(OWN_TEST.id);
    expect(ctx.switchable.map((o) => o.id)).toEqual([DEFAULT_ORG_ID, OWN_TEST.id]);
  });

  it("a platform admin who is a member of nothing still lands on the default org, not on /welcome", async () => {
    state.members = { data: [], error: null };
    const ctx = await getOrgContext();
    expect(ctx.current?.id).toBe(DEFAULT_ORG_ID);
    expect(ctx.switchable).toEqual([NIGHTSHIFT]);
    // The layout sends someone to /welcome only when `orgs` is empty.
    expect(ctx.orgs.length).toBeGreaterThan(0);
  });

  it("a customer sees exactly what they saw before, and no membership read is made", async () => {
    state.user = { id: "u-customer" };
    state.orgs = { data: [NEW], error: null };
    state.cookie = NEW.id;
    const ctx = await getOrgContext();
    expect(ctx.switchable).toEqual(ctx.orgs);
    expect(ctx.switchable.map((o) => o.id)).toEqual([NEW.id]);
    expect(ctx.current?.id).toBe(NEW.id);
    expect(state.memberReads).toEqual([]);
  });

  it("a customer with several workspaces keeps every one of them and their remembered choice", async () => {
    state.user = { id: "u-customer" };
    state.orgs = { data: [NEW, MEDIA], error: null };
    state.cookie = MEDIA.id;
    const ctx = await getOrgContext();
    expect(ctx.switchable.map((o) => o.id)).toEqual([NEW.id, MEDIA.id]);
    expect(ctx.current?.id).toBe(MEDIA.id);
    expect(state.memberReads).toEqual([]);
  });

  for (const [label, members] of [
    ["an error", { data: null, error: { message: "permission denied" } }],
    ["a throw", "throw"],
  ] as const) {
    it(`a membership read that fails with ${label} and no remembered org fails closed to the default org, not to every org`, async () => {
      state.members = members;
      const ctx = await getOrgContext();
      expect(ctx.supported).toBe(true);
      expect(ctx.unavailable).toBeUndefined();
      expect(ctx.switchable.map((o) => o.id)).toEqual([DEFAULT_ORG_ID]);
      expect(ctx.current?.id).toBe(DEFAULT_ORG_ID);
      expect(ctx.orgs.length).toBe(3);
    });

    it(`a membership read that fails with ${label} and a default-org cookie keeps the default org`, async () => {
      state.members = members;
      state.cookie = DEFAULT_ORG_ID;
      const ctx = await getOrgContext();
      expect(ctx.unavailable).toBeUndefined();
      expect(ctx.current?.id).toBe(DEFAULT_ORG_ID);
    });

    it(`a membership read that fails with ${label} while a non-default org is remembered is UNAVAILABLE, never a quiet move to the default org`, async () => {
      // The remembered org may be the operator's own second workspace: resolving to the default org would send
      // every write of this request (keyed on current.id) to another organization with nothing on screen.
      state.orgs = { data: [NIGHTSHIFT, OWN_TEST, NEW], error: null };
      state.members = members;
      state.cookie = OWN_TEST.id;
      const ctx = await getOrgContext();
      expect(ctx.unavailable).toBe(true);
      expect(ctx.supported).toBe(false);
      expect(ctx.current).toBeNull();
      expect(ctx.switchable).toEqual([]);
    });
  }

  it("a failed read with a cookie naming no org the caller can read is the default org, as a good read would give", async () => {
    state.members = { data: null, error: { message: "boom" } };
    state.cookie = "0a0a0a0a-0000-4000-8000-0000000000aa";
    const ctx = await getOrgContext();
    expect(ctx.unavailable).toBeUndefined();
    expect(ctx.current?.id).toBe(DEFAULT_ORG_ID);
  });
});

describe("/api/org/select", () => {
  const ORIGIN = "https://app.example.test";
  const choose = (orgId: string) =>
    select(
      new Request(`${ORIGIN}/api/org/select`, {
        method: "POST",
        body: JSON.stringify({ orgId }),
        headers: { origin: ORIGIN, "content-type": "application/json" },
      }),
    );
  const orgCookie = (res: Response) =>
    (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""]).find((c) => c.startsWith(`${ORG_COOKIE}=`)) ?? null;

  beforeEach(() => {
    delete process.env.APP_ORIGIN;
  });

  it("refuses to put a platform admin inside a customer's org (403, no cookie)", async () => {
    const res = await choose(NEW.id);
    expect(res.status).toBe(403);
    expect(orgCookie(res)).toBeNull();
  });

  it("lets a platform admin choose an org they belong to, and the default org", async () => {
    state.orgs = { data: [NIGHTSHIFT, OWN_TEST, NEW], error: null };
    state.members = { data: [{ org_id: OWN_TEST.id }], error: null };
    const own = await choose(OWN_TEST.id);
    expect(own.status).toBe(200);
    expect(orgCookie(own)).toContain(OWN_TEST.id);
    expect(orgCookie(await choose(DEFAULT_ORG_ID))).toContain(DEFAULT_ORG_ID);
  });

  it("a failed membership read answers 503 org_unavailable (could not check), never 403, and sets no cookie", async () => {
    state.members = { data: null, error: { message: "boom" } };
    const res = await choose(NEW.id);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "org_unavailable" });
    expect(orgCookie(res)).toBeNull();
    state.members = "throw";
    expect((await choose(OWN_TEST.id)).status).toBe(503);
  });

  it("a failed membership read still lets the default org be chosen: it needs no membership row", async () => {
    state.members = { data: null, error: { message: "boom" } };
    const res = await choose(DEFAULT_ORG_ID);
    expect(res.status).toBe(200);
    expect(orgCookie(res)).toContain(DEFAULT_ORG_ID);
  });

  it("a customer switches between their own workspaces exactly as before", async () => {
    state.user = { id: "u-customer" };
    state.orgs = { data: [NEW, MEDIA], error: null };
    const res = await choose(MEDIA.id);
    expect(res.status).toBe(200);
    expect(orgCookie(res)).toContain(MEDIA.id);
    expect(state.memberReads).toEqual([]);
  });
});
