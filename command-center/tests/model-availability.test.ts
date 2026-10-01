import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "../lib/orgs-server";

/**
 * The operator's model availability screen (migration 0035).
 *
 * What would break without these: a customer organization's admin putting an
 * unprobed model on sale (or pulling a paid one) through the route; a junk id
 * or availability value reaching the database; the Models section showing up
 * in a customer's rail or opening for them by URL.
 *
 * The database is faked at the edges the route consults: the session, the org
 * context, is_platform_admin, model_registry_admin() and the model_registry
 * UPDATE.
 */

vi.mock("server-only", () => ({}));

const CUSTOMER_ORG = { id: "0b000000-0000-0000-0000-00000000000b", name: "B", slug: "b", role: "owner" as const, is_default: false };

const VERIFIED = {
  id: "flux-1.1-pro",
  display_name: "FLUX 1.1 Pro",
  provider: "bfl",
  adapter: "image.bfl",
  capabilities: ["t2i"],
  spec: { pricing: { usd_per_image: 0.04 } },
  availability: "hidden",
  verified_at: "2026-09-30T10:00:00+00:00",
  verified_by: "probe",
  verified_probe_id: 7,
  credit_unit: "image_flux_pro",
  entitlement: null,
  updated_at: "2026-09-30T10:00:00+00:00",
};
const UNVERIFIED = { ...VERIFIED, id: "veo-3", display_name: "Veo 3", verified_at: null, verified_probe_id: null, verified_by: null };
const GATED = { ...VERIFIED, id: "luma-ray-2", spec: { terms_gate: "luma_written_consent" } };

const state: {
  user: { id: string } | null;
  org: OrgContext;
  platformAdmin: boolean;
  adminRows: { data: unknown; error: { code?: string; message?: string } | null };
  update: { data: unknown; error: { code?: string; message?: string } | null };
} = {
  user: null,
  org: { supported: true, orgs: [], current: null },
  platformAdmin: false,
  adminRows: { data: [], error: null },
  update: { data: [], error: null },
};

const rpcCalls: { fn: string; args: unknown }[] = [];
const updates: { table: string; values: unknown; eq: [string, unknown] | null; select: string | null }[] = [];

const fakeClient = {
  rpc: async (fn: string, args?: unknown) => {
    rpcCalls.push({ fn, args });
    if (fn === "is_platform_admin") return { data: state.platformAdmin, error: null };
    if (fn === "model_registry_admin") {
      // The database's own check, as 0035 writes it.
      if (!state.platformAdmin) return { data: null, error: { code: "42501", message: "platform admin only" } };
      return state.adminRows;
    }
    return { data: null, error: null };
  },
  from: (table: string) => ({
    update: (values: unknown) => {
      const call = { table, values, eq: null as [string, unknown] | null, select: null as string | null };
      updates.push(call);
      return {
        eq: (col: string, val: unknown) => {
          call.eq = [col, val];
          return {
            select: async (cols: string) => {
              call.select = cols;
              return state.update;
            },
          };
        },
      };
    },
    insert: async () => ({ data: null, error: null }),
  }),
};

vi.mock("@/lib/config", () => ({
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  isSupabaseConfigured: true,
}));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => state.user,
  createClient: async () => fakeClient,
}));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => state.org,
  ORG_COOKIE_OPTIONS: {},
}));
vi.mock("@/lib/channels-server", () => ({ isChannelInCurrentOrg: async () => true }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => undefined }));

const route = await import("../app/api/models/availability/route");
const { MODEL_ID_RE, availabilityBlocker, coerceAdminModels, latestProbes, parseAvailabilityRequest } = await import("../lib/models-admin");
const { CUSTOMER_SECTIONS, isOperatorOnlySection, navGroupsFor, sectionAllowed } = await import("../lib/navigation");
const { appRedirect, isSection } = await import("../lib/channels");

function customerAdmin() {
  state.user = { id: "u-bob" };
  state.org = { supported: true, orgs: [CUSTOMER_ORG], current: CUSTOMER_ORG };
  state.platformAdmin = false;
}

function operator() {
  state.user = { id: "u-op" };
  state.org = { supported: true, orgs: [CUSTOMER_ORG], current: CUSTOMER_ORG };
  state.platformAdmin = true;
}

function post(body: unknown) {
  return route.POST(
    new Request("http://localhost/api/models/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.user = null;
  state.org = { supported: true, orgs: [], current: null };
  state.platformAdmin = false;
  state.adminRows = { data: [VERIFIED, UNVERIFIED, GATED], error: null };
  state.update = { data: [{ id: VERIFIED.id, availability: "beta" }], error: null };
  rpcCalls.length = 0;
  updates.length = 0;
});

describe("POST /api/models/availability — who may call it", () => {
  it("refuses a signed-out caller with 401 and touches nothing", async () => {
    const res = await post({ id: VERIFIED.id, availability: "beta" });
    expect(res.status).toBe(401);
    expect(rpcCalls.filter((c) => c.fn === "model_registry_admin")).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("refuses a customer organization's owner with 403 before any registry call", async () => {
    customerAdmin();
    const res = await post({ id: VERIFIED.id, availability: "ga" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(rpcCalls.map((c) => c.fn)).not.toContain("model_registry_admin");
    expect(updates).toHaveLength(0);
  });

  it("maps the database's own refusal (42501 from model_registry_admin) to 403, with no write", async () => {
    operator();
    state.adminRows = { data: null, error: { code: "42501", message: "platform admin only" } };
    const res = await post({ id: VERIFIED.id, availability: "beta" });
    expect(res.status).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it("treats an UPDATE that RLS filtered to zero rows as refused", async () => {
    operator();
    state.update = { data: [], error: null };
    const res = await post({ id: VERIFIED.id, availability: "beta" });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/models/availability — the operator path", () => {
  it("reads through model_registry_admin() and updates only availability for that id", async () => {
    operator();
    const res = await post({ id: VERIFIED.id, availability: "beta" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: VERIFIED.id, availability: "beta" });
    expect(rpcCalls.find((c) => c.fn === "model_registry_admin")).toEqual({ fn: "model_registry_admin", args: undefined });
    expect(updates).toEqual([{ table: "model_registry", values: { availability: "beta" }, eq: ["id", VERIFIED.id], select: "id,availability" }]);
  });

  it("sends nothing but availability, whatever else the body carries", async () => {
    operator();
    await post({ id: VERIFIED.id, availability: "ga", verified_at: "2026-01-01", spec: {}, credit_unit: "x" });
    expect(updates[0]?.values).toEqual({ availability: "ga" });
  });

  it.each([
    ["uppercase", "FLUX"],
    ["sql", "x'; drop table model_registry;--"],
    ["one char", "a"],
    ["leading dot", ".flux"],
    ["too long", "a".repeat(41)],
    ["number", 42],
    ["missing", undefined],
  ])("rejects a bad model id (%s) with 400 before the database", async (_label, id) => {
    operator();
    const res = await post({ id, availability: "beta" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_model_id" });
    expect(rpcCalls.map((c) => c.fn)).not.toContain("model_registry_admin");
    expect(updates).toHaveLength(0);
  });

  it.each(["GA", "public", "", null, "verified", 1])("rejects availability %j with 400", async (availability) => {
    operator();
    const res = await post({ id: VERIFIED.id, availability });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_availability" });
    expect(updates).toHaveLength(0);
  });

  it("rejects a body that is not JSON or not an object", async () => {
    operator();
    expect((await post("{nope")).status).toBe(400);
    expect((await post([VERIFIED.id, "beta"])).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("refuses beta/ga for an unverified model with 409 not_verified, and never writes", async () => {
    operator();
    for (const to of ["beta", "ga"]) {
      const res = await post({ id: UNVERIFIED.id, availability: to });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "not_verified" });
    }
    expect(updates).toHaveLength(0);
  });

  it("still lets an unverified model be hidden or disabled", async () => {
    operator();
    state.update = { data: [{ id: UNVERIFIED.id, availability: "disabled" }], error: null };
    const res = await post({ id: UNVERIFIED.id, availability: "disabled" });
    expect(res.status).toBe(200);
    expect(updates[0]?.values).toEqual({ availability: "disabled" });
  });

  it("refuses beta/ga while vendor terms are open", async () => {
    operator();
    const res = await post({ id: GATED.id, availability: "ga" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "terms_gate" });
  });

  it("404s an id the registry does not have", async () => {
    operator();
    const res = await post({ id: "no-such-model", availability: "hidden" });
    expect(res.status).toBe(404);
    expect(updates).toHaveLength(0);
  });

  it("reports a CHECK violation from the database as 409", async () => {
    operator();
    state.update = { data: null, error: { code: "23514", message: "model_registry_verified_before_sale" } };
    const res = await post({ id: VERIFIED.id, availability: "ga" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "rejected" });
  });
});

describe("models-admin helpers", () => {
  it("mirrors 0035's id CHECK", () => {
    expect(MODEL_ID_RE.source).toBe("^[a-z0-9][a-z0-9.-]{1,39}$");
    expect(parseAvailabilityRequest({ id: "gpt-image-1", availability: "ga" })).toEqual({ ok: true, id: "gpt-image-1", availability: "ga" });
    expect(parseAvailabilityRequest(null)).toEqual({ ok: false, error: "bad_request" });
  });

  it("keeps spec out of what reaches the client, except the gate and removed flag", () => {
    const [m] = coerceAdminModels([{ ...GATED, spec: { terms_gate: "x", removed_from_file: true, pricing: { usd: 1 }, notes: "internal" } }]);
    expect(m.termsGate).toBe("x");
    expect(m.removedFromFile).toBe(true);
    expect(JSON.stringify(m)).not.toMatch(/usd|internal/);
  });

  it("drops rows with an unknown availability", () => {
    expect(coerceAdminModels([{ ...VERIFIED, availability: "public" }])).toEqual([]);
  });

  it("picks the newest probe per model", () => {
    const p = latestProbes([
      { model_id: "a1", ok: false, error_code: "auth", capability: "t2i", created_at: "2026-09-30T10:00:00+00:00" },
      { model_id: "a1", ok: true, error_code: null, capability: "t2i", created_at: "2026-09-29T10:00:00+00:00" },
    ]);
    expect(p.a1).toEqual({ ok: false, errorCode: "auth", capability: "t2i", at: "2026-09-30T10:00:00+00:00" });
  });

  it("names the blocker the database would raise", () => {
    expect(availabilityBlocker({ verifiedAt: null, termsGate: null, creditUnit: "u" }, "beta")).toBe("not_verified");
    expect(availabilityBlocker({ verifiedAt: "t", termsGate: "g", creditUnit: "u" }, "ga")).toBe("terms_gate");
    expect(availabilityBlocker({ verifiedAt: "t", termsGate: null, creditUnit: null }, "ga")).toBe("no_credit_unit");
    expect(availabilityBlocker({ verifiedAt: null, termsGate: "g", creditUnit: null }, "hidden")).toBeNull();
  });
});

describe("Models section navigation", () => {
  const keys = (op: boolean) => navGroupsFor(op).flatMap((g) => g.items.map((i) => i.key));

  it("is in the operator's rail and never in a customer's", () => {
    expect(keys(true)).toContain("models");
    expect(keys(false)).not.toContain("models");
    expect(CUSTOMER_SECTIONS).not.toContain("models");
  });

  it("is operator-only: sectionAllowed refuses it for customers", () => {
    expect(isSection("models")).toBe(true);
    expect(isOperatorOnlySection("models")).toBe(true);
    expect(sectionAllowed("models", false)).toBe(false);
    expect(sectionAllowed("models", true)).toBe(true);
  });

  it("bounces a customer who opens it by URL to their landing screen", () => {
    const channels = [{ id: "c1", slug: "mine", name: "Mine" }] as never;
    expect(appRedirect({ path: "/mine/models", honestSlug: "mine", selection: "c1" as never, channels, operator: false })).toBe("/mine/create");
    expect(appRedirect({ path: "/mine/models", honestSlug: "mine", selection: "c1" as never, channels, operator: true })).toBeNull();
  });
});
