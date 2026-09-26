import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "../lib/auth/roles-shared";
import type { OrgContext } from "../lib/orgs-server";

/**
 * requireOrgRole (lib/auth/org-roles.ts) and the routes that moved to it.
 *
 * What would break without these: a customer organization's admin locked out
 * of their own Run now (the platform-role gate), an admin of org B acting on
 * org A's channel (the tenant boundary), a viewer spending money, the operator
 * losing access, or a pre-0018 deployment suddenly refusing everyone.
 *
 * The database is faked at the edges the helper actually consults: the org
 * context (my_organizations), the channel-in-org guard, and the platform role.
 */

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

const state: {
  user: { id: string; email?: string } | null;
  org: OrgContext;
  /** Channels of the organization being viewed; null = unscoped (pre-0018). */
  inScope: Set<string> | null;
  platformRole: Role;
  platformAdmin: boolean;
  creditsEnforced: boolean;
  learning: Row | null;
  series: Row | null;
} = {
  user: null,
  org: { supported: false, orgs: [], current: null },
  inScope: null,
  platformRole: "viewer",
  platformAdmin: false,
  creditsEnforced: true,
  learning: null,
  series: null,
};

const dispatchDailyVideo = vi.fn(async () => undefined);
const reserveRunCredits = vi.fn(async () => ({ ok: true, creditRef: null, estimate: null, exempt: false }));
const learningUpdate = vi.fn();
const seriesInsert = vi.fn();
const seriesUpdate = vi.fn();

/** A PostgREST-ish builder: every filter returns itself, terminals resolve. */
function builder(table: string) {
  let op: "select" | "update" | "insert" = "select";
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ["select", "eq", "in", "or", "is", "order", "limit", "gte"]) b[m] = self;
  b.update = (patch: Row) => {
    op = "update";
    if (table === "learnings") learningUpdate(patch);
    if (table === "content_series") seriesUpdate(patch);
    return b;
  };
  b.insert = (row: Row) => {
    op = "insert";
    if (table === "content_series") seriesInsert(row);
    return b;
  };
  b.maybeSingle = async () => ({
    data: table === "learnings" ? state.learning : table === "content_series" ? state.series : null,
    error: null,
  });
  // Awaiting the builder itself: an update/insert result.
  b.then = (resolve: (v: unknown) => void) =>
    resolve(op === "update" && table === "learnings" ? { data: [{ id: "l1" }], error: null } : { data: null, error: null });
  return b;
}

const fakeClient = {
  from: (table: string) => builder(table),
  rpc: async (fn: string) => (fn === "is_platform_admin" ? { data: state.platformAdmin, error: null } : { data: null, error: null }),
};

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => state.user,
  createClient: async () => fakeClient,
}));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => state.org,
  ORG_COOKIE_OPTIONS: {},
}));
vi.mock("@/lib/channels-server", async () => {
  const { unscopedScope } = await vi.importActual<typeof import("../lib/channels")>("../lib/channels");
  return {
    isChannelInCurrentOrg: async (id: string | null | undefined) =>
      state.inScope === null ? true : Boolean(id) && state.inScope.has(id as string),
    getChannelScope: async () =>
      state.inScope === null
        ? unscopedScope()
        : { selection: "__all__", orgChannelIds: [...state.inScope], includeGlobal: false },
  };
});
vi.mock("@/lib/auth/roles", async () => {
  const shared = await vi.importActual<typeof import("../lib/auth/roles-shared")>("../lib/auth/roles-shared");
  return {
    ...shared,
    resolveRole: async () => state.platformRole,
    requireRole: async (min: Role) => (shared.atLeast(state.platformRole, min) ? state.platformRole : null),
  };
});
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => undefined }));
vi.mock("@/lib/server/github-secrets", () => ({ dispatchDailyVideo, isGithubConfigured: true }));
vi.mock("@/lib/server/credits", () => ({
  get creditsEnforced() {
    return state.creditsEnforced;
  },
  reserveRunCredits,
}));

const { requireOrgRole, resolveCurrentOrgRole } = await import("../lib/auth/org-roles");
const run = await import("../app/api/agent/run/route");
const decide = await import("../app/api/learnings/decide/route");
const series = await import("../app/api/series/route");

const ORG_A = "0a000000-0000-0000-0000-00000000000a";
const ORG_B = "0b000000-0000-0000-0000-00000000000b";

function org(id: string, role: Role, isDefault = false) {
  return { id, name: id, slug: id.slice(0, 4), role, is_default: isDefault };
}

/** Signed in, viewing `current` (whose channels are `channels`). */
function viewing(current: ReturnType<typeof org> | null, channels: string[], platformRole: Role = "viewer") {
  state.user = { id: "u-me" };
  state.org = { supported: true, orgs: current ? [current] : [], current };
  state.inScope = new Set(channels);
  state.platformRole = platformRole;
}

function preMigration(platformRole: Role) {
  state.user = { id: "u-me" };
  state.org = { supported: false, orgs: [], current: null };
  state.inScope = null;
  state.platformRole = platformRole;
}

function post(body: unknown, method = "POST") {
  return new Request("http://test.local/api", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.platformAdmin = false;
  state.creditsEnforced = true;
  state.learning = null;
  state.series = null;
  dispatchDailyVideo.mockClear();
  reserveRunCredits.mockClear();
  learningUpdate.mockClear();
  seriesInsert.mockClear();
  seriesUpdate.mockClear();
});

describe("requireOrgRole", () => {
  it("gives a customer organization's admin their role on their own channel", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    expect(await requireOrgRole({ channelId: "ch-a" }, "admin")).toEqual({
      ok: true,
      role: "admin",
      orgId: ORG_A,
      source: "org",
    });
  });

  it("answers not found — not forbidden — for another organization's channel, even to its admin", async () => {
    viewing(org(ORG_B, "owner"), ["ch-b"]);
    expect(await requireOrgRole({ channelId: "ch-a" }, "viewer")).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses a role below the minimum inside the organization", async () => {
    viewing(org(ORG_A, "viewer"), ["ch-a"]);
    expect(await requireOrgRole({ channelId: "ch-a" }, "editor")).toMatchObject({ ok: false, status: 403 });
    viewing(org(ORG_A, "editor"), ["ch-a"]);
    expect(await requireOrgRole({ channelId: "ch-a" }, "editor")).toMatchObject({ ok: true, role: "editor" });
    expect(await requireOrgRole({ channelId: "ch-a" }, "admin")).toMatchObject({ ok: false, status: 403 });
  });

  it("uses the organization role, not the platform role, once 0018 is applied", async () => {
    // A platform viewer who is an org admin acts as admin there…
    viewing(org(ORG_A, "admin"), ["ch-a"], "viewer");
    expect(await requireOrgRole({ channelId: "ch-a" }, "admin")).toMatchObject({ ok: true });
    // …and the database's answer for the org (my_organizations → org_role)
    // is what counts, whatever the platform roster says.
    viewing(org(ORG_A, "viewer"), ["ch-a"], "editor");
    expect(await requireOrgRole({ channelId: "ch-a" }, "editor")).toMatchObject({ ok: false, status: 403 });
  });

  it("keeps the platform admin's access: org_role() makes them admin of every organization", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"], "admin");
    expect(await requireOrgRole({ channelId: "ch-a" }, "admin")).toMatchObject({ ok: true, orgId: ORG_A });
  });

  it("checks an organization target against the organization being viewed", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    expect(await requireOrgRole({ orgId: ORG_A }, "admin")).toMatchObject({ ok: true, orgId: ORG_A });
    expect(await requireOrgRole({ orgId: ORG_B }, "viewer")).toMatchObject({ ok: false, status: 404 });
    expect(await requireOrgRole({ orgId: "" }, "viewer")).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses a caller who belongs to no organization", async () => {
    viewing(null, []);
    expect(await requireOrgRole({ channelId: "ch-a" }, "viewer")).toMatchObject({ ok: false, status: 404 });
    expect(await resolveCurrentOrgRole()).toBe("viewer");
  });

  it("falls back to the platform role before 0018, exactly as requireRole did", async () => {
    preMigration("admin");
    expect(await requireOrgRole({ channelId: "anything" }, "admin")).toEqual({
      ok: true,
      role: "admin",
      orgId: null,
      source: "platform",
    });
    preMigration("editor");
    expect(await requireOrgRole({ channelId: "anything" }, "admin")).toMatchObject({ ok: false, status: 403 });
    expect(await resolveCurrentOrgRole()).toBe("editor");
  });

  it("fails closed when 0018 is there but the membership lookup failed", async () => {
    preMigration("owner");
    state.org = { supported: false, orgs: [], current: null, unavailable: true };
    expect(await requireOrgRole({ channelId: "ch-a" }, "viewer")).toMatchObject({ ok: false, status: 503 });
    expect(await resolveCurrentOrgRole()).toBe("viewer");
  });

  it("refuses a signed-out caller before looking anything up", async () => {
    viewing(org(ORG_A, "owner"), ["ch-a"]);
    state.user = null;
    expect(await requireOrgRole({ channelId: "ch-a" }, "viewer")).toMatchObject({ ok: false, status: 401 });
  });
});

describe("POST /api/agent/run", () => {
  it("lets an admin of the channel's own organization run it", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    const res = await run.POST(post({ channel_id: "ch-a" }));
    expect(res.status).toBe(200);
    expect(dispatchDailyVideo).toHaveBeenCalledOnce();
    // Paid through the org's credits, as that admin (reserve_credits checks the same role).
    expect(reserveRunCredits).toHaveBeenCalledOnce();
  });

  it("never runs another organization's channel, even for that organization's admin", async () => {
    viewing(org(ORG_B, "owner"), ["ch-b"]);
    const res = await run.POST(post({ channel_id: "ch-a" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "channel_not_found" });
    expect(dispatchDailyVideo).not.toHaveBeenCalled();
    expect(reserveRunCredits).not.toHaveBeenCalled();
  });

  it("refuses a viewer or editor of the organization", async () => {
    for (const role of ["viewer", "editor"] as Role[]) {
      viewing(org(ORG_A, role), ["ch-a"]);
      const res = await run.POST(post({ channel_id: "ch-a" }));
      expect(res.status).toBe(403);
    }
    expect(dispatchDailyVideo).not.toHaveBeenCalled();
  });

  it("still lets the platform admin run a channel of the organization they are viewing", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"], "admin");
    state.platformAdmin = true;
    state.creditsEnforced = false;
    const res = await run.POST(post({ channel_id: "ch-a" }));
    expect(res.status).toBe(200);
    expect(dispatchDailyVideo).toHaveBeenCalledOnce();
  });

  it("does not let a customer's admin spend the operator's providers when credits are off", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    state.creditsEnforced = false;
    const res = await run.POST(post({ channel_id: "ch-a" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "credits_not_enforced" });
    expect(dispatchDailyVideo).not.toHaveBeenCalled();
  });

  it("runs the operator's own organization without credits, as before", async () => {
    viewing(org("00000000-0000-0000-0000-000000000001", "admin", true), ["default"]);
    state.creditsEnforced = false;
    const res = await run.POST(post({ channel_id: "default" }));
    expect(res.status).toBe(200);
  });

  it("before 0018, gates on the platform role exactly as it used to", async () => {
    preMigration("admin");
    state.creditsEnforced = false;
    expect((await run.POST(post({ channel_id: "default" }))).status).toBe(200);
    preMigration("editor");
    expect((await run.POST(post({ channel_id: "default" }))).status).toBe(403);
  });
});

describe("POST /api/learnings/decide", () => {
  const body = { id: "11111111-1111-1111-1111-111111111111", decision: "approve" };

  it("lets an admin of the learning's channel's organization decide it", async () => {
    viewing(org(ORG_A, "admin"), ["ch-a"]);
    state.learning = { id: body.id, channel_id: "ch-a", kind: "topic", status: "pending" };
    const res = await decide.POST(post(body));
    expect(res.status).toBe(200);
    expect(learningUpdate).toHaveBeenCalledOnce();
  });

  it("reads another organization's learning as not found", async () => {
    viewing(org(ORG_B, "admin"), ["ch-b"]);
    state.learning = { id: body.id, channel_id: "ch-a", kind: "topic", status: "pending" };
    const res = await decide.POST(post(body));
    expect(res.status).toBe(404);
    expect(learningUpdate).not.toHaveBeenCalled();
  });

  it("refuses an editor of the organization", async () => {
    viewing(org(ORG_A, "editor"), ["ch-a"]);
    state.learning = { id: body.id, channel_id: "ch-a", kind: "topic", status: "pending" };
    const res = await decide.POST(post(body));
    expect(res.status).toBe(403);
    expect(learningUpdate).not.toHaveBeenCalled();
  });
});

describe("/api/series", () => {
  it("lets an editor of the organization create a series on its channel", async () => {
    viewing(org(ORG_A, "editor"), ["ch-a"]);
    const res = await series.POST(post({ name: "Weekly", channel_id: "ch-a" }));
    expect(res.status).toBe(200);
    expect(seriesInsert).toHaveBeenCalledOnce();
  });

  it("refuses a viewer, and another organization's channel", async () => {
    viewing(org(ORG_A, "viewer"), ["ch-a"]);
    expect((await series.POST(post({ name: "Weekly", channel_id: "ch-a" }))).status).toBe(403);
    viewing(org(ORG_B, "owner"), ["ch-b"]);
    expect((await series.POST(post({ name: "Weekly", channel_id: "ch-a" }))).status).toBe(404);
    expect(seriesInsert).not.toHaveBeenCalled();
  });

  it("checks a status change against the series' own channel's organization", async () => {
    viewing(org(ORG_A, "editor"), ["ch-a"]);
    state.series = { channel_id: "ch-a" };
    expect((await series.PATCH(post({ series_id: "s1", status: "ACTIVE" }, "PATCH"))).status).toBe(200);
    expect(seriesUpdate).toHaveBeenCalledOnce();

    seriesUpdate.mockClear();
    viewing(org(ORG_A, "viewer"), ["ch-a"]);
    expect((await series.PATCH(post({ series_id: "s1", status: "ACTIVE" }, "PATCH"))).status).toBe(403);
    // A series the org-scoped read cannot find — another tenant's — is not found.
    viewing(org(ORG_B, "owner"), ["ch-b"]);
    state.series = null;
    expect((await series.PATCH(post({ series_id: "s1", status: "ACTIVE" }, "PATCH"))).status).toBe(404);
    expect(seriesUpdate).not.toHaveBeenCalled();
  });
});
