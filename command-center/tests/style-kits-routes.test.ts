import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/style-kits and /api/characters (migration 0047).
 *
 * What would break without these: a malformed body reaching the database (or
 * worse, half-validated), a refusal from the database turning into a 500 or a
 * fake success, another organization's kit being "deleted" with a 200, and a
 * route quietly reaching for the service key — which would skip every RLS
 * policy and same-org check 0047 has.
 *
 * The database is faked at the edges the routes touch: the session, the org
 * context, rpc() and the table builder. Every call is recorded.
 */

vi.mock("server-only", () => ({}));

type Result = { data: unknown; error: { code?: string; message?: string } | null };
const ORG = "0a000000-0000-4000-8000-00000000000a";
const KIT = "0b000000-0000-4000-8000-00000000000b";
const A = (n: number) => `0c000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as { id: string; email: string } | null,
  current: null as { id: string } | null,
  rpc: { data: null, error: null } as Result,
  table: { data: [], error: null } as Result,
  calls: [] as { kind: string; name: string; args?: unknown; chain: { m: string; a: unknown[] }[] }[],
  audits: [] as unknown[],
}));

function builder(rec: { chain: { m: string; a: unknown[] }[] }, result: () => Result): unknown {
  const q: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      return (...a: unknown[]) => {
        rec.chain.push({ m: String(prop), a });
        return q;
      };
    },
  });
  return q;
}

type Call = (typeof h.calls)[number];

const client = {
  rpc: (name: string, args: unknown) => {
    const rec: Call = { kind: "rpc", name, args, chain: [] };
    h.calls.push(rec);
    return builder(rec, () => h.rpc);
  },
  from: (name: string) => {
    const rec: Call = { kind: "from", name, chain: [] };
    h.calls.push(rec);
    return builder(rec, () => h.table);
  },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => client,
  getUser: async () => h.user,
}));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => ({ supported: true, orgs: [], current: h.current }),
}));
vi.mock("@/lib/server/audit", () => ({ logAudit: async (e: unknown) => void h.audits.push(e) }));

const kits = await import("../app/api/style-kits/route");
const kit = await import("../app/api/style-kits/[id]/route");
const attach = await import("../app/api/style-kits/attach/route");
const chars = await import("../app/api/characters/route");
const char = await import("../app/api/characters/[id]/route");

function req(url: string, method: string, body?: unknown) {
  return new Request(`http://x${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function out(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  h.user = { id: "u1", email: "me@example.com" };
  h.current = { id: ORG };
  h.rpc = { data: null, error: null };
  h.table = { data: [], error: null };
  h.calls.length = 0;
  h.audits.length = 0;
});

const KIT_BODY = { name: "Warm", description: "grain", asset_ids: [A(1), A(2), A(3)] };

describe("signed out", () => {
  it("every route answers 401 and touches nothing", async () => {
    h.user = null;
    const all = [
      kits.GET(req("/api/style-kits", "GET")),
      kits.POST(req("/api/style-kits", "POST", KIT_BODY)),
      kit.PATCH(req(`/api/style-kits/${KIT}`, "PATCH", KIT_BODY), params(KIT)),
      kit.DELETE(req(`/api/style-kits/${KIT}`, "DELETE"), params(KIT)),
      attach.POST(req("/api/style-kits/attach", "POST", { channel_id: "chan-a", kit_id: KIT })),
      chars.GET(req("/api/characters", "GET")),
      chars.POST(req("/api/characters", "POST", { name: "hero", asset_ids: [A(1)] })),
      char.PATCH(req(`/api/characters/${KIT}`, "PATCH", { name: "hero", asset_ids: [A(1)] }), params(KIT)),
      char.DELETE(req(`/api/characters/${KIT}`, "DELETE"), params(KIT)),
    ];
    for (const r of await Promise.all(all)) expect(r.status).toBe(401);
    expect(h.calls).toEqual([]);
  });
});

describe("POST /api/style-kits", () => {
  it("calls save_style_kit as the user with the cleaned input and the open org", async () => {
    h.rpc = { data: KIT, error: null };
    const r = await out(await kits.POST(req("/api/style-kits", "POST", { ...KIT_BODY, name: " Warm\u0007 " })));
    expect(r).toEqual({ status: 201, body: { id: KIT } });
    expect(h.calls).toEqual([
      {
        kind: "rpc",
        name: "save_style_kit",
        args: { p_org: ORG, p_kit: null, p_name: "Warm", p_description: "grain", p_assets: [A(1), A(2), A(3)] },
        chain: [],
      },
    ]);
    expect(h.audits).toEqual([{ action: "style_kit.create", target: KIT, detail: { references: 3 } }]);
  });

  it.each([
    ["not JSON", "{", "bad_request"],
    ["two images", { ...KIT_BODY, asset_ids: [A(1), A(2)] }, "too_few_references"],
    ["a path for an id", { ...KIT_BODY, asset_ids: [A(1), A(2), "../x"] }, "invalid_reference"],
    ["a long name", { ...KIT_BODY, name: "n".repeat(61) }, "invalid_name"],
    ["a bad org", { ...KIT_BODY, org_id: "not-a-uuid" }, "bad_request"],
  ])("refuses %s with 400 before the database", async (_l, body, word) => {
    const r = await out(await kits.POST(req("/api/style-kits", "POST", body)));
    expect(r).toEqual({ status: 400, body: { error: word } });
    expect(h.calls).toEqual([]);
  });

  it("needs an organization", async () => {
    h.current = null;
    expect(await out(await kits.POST(req("/api/style-kits", "POST", KIT_BODY)))).toEqual({
      status: 400,
      body: { error: "org_required" },
    });
  });

  it.each([
    [{ code: "NS400", message: "invalid_reference" }, 400, "invalid_reference"],
    [{ code: "42501", message: "forbidden" }, 403, "forbidden"],
    [{ code: "NS429", message: "limit_reached" }, 409, "limit_reached"],
    [{ code: "PGRST202", message: "Could not find the function" }, 503, "not_available"],
  ])("maps the database's refusal %j", async (error, status, word) => {
    h.rpc = { data: null, error };
    expect(await out(await kits.POST(req("/api/style-kits", "POST", KIT_BODY)))).toEqual({ status, body: { error: word } });
    expect(h.audits).toEqual([]);
  });

  it("an answer that is not an id is a failure, not a success", async () => {
    h.rpc = { data: { weird: true }, error: null };
    expect((await kits.POST(req("/api/style-kits", "POST", KIT_BODY))).status).toBe(502);
  });
});

describe("PATCH and DELETE /api/style-kits/<id>", () => {
  it("PATCH lets the database take the org from the kit", async () => {
    h.rpc = { data: KIT, error: null };
    const r = await out(await kit.PATCH(req(`/api/style-kits/${KIT}`, "PATCH", { ...KIT_BODY, org_id: A(9) }), params(KIT)));
    expect(r.status).toBe(200);
    expect(h.calls[0].args).toMatchObject({ p_org: null, p_kit: KIT });
  });

  it("another org's kit is a 404 from the database, passed on", async () => {
    h.rpc = { data: null, error: { code: "P0002", message: "not_found" } };
    expect((await kit.PATCH(req(`/api/style-kits/${KIT}`, "PATCH", KIT_BODY), params(KIT))).status).toBe(404);
  });

  it("a malformed id never reaches the database", async () => {
    expect((await kit.PATCH(req("/api/style-kits/x", "PATCH", KIT_BODY), params("x"))).status).toBe(400);
    expect((await kit.DELETE(req("/api/style-kits/x", "DELETE"), params("x"))).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it("DELETE that removes no row (RLS hid it) is a 404, not a 200", async () => {
    h.table = { data: [], error: null };
    expect((await kit.DELETE(req(`/api/style-kits/${KIT}`, "DELETE"), params(KIT))).status).toBe(404);
    expect(h.audits).toEqual([]);
  });

  it("DELETE removes by id under the session", async () => {
    h.table = { data: [{ id: KIT }], error: null };
    expect((await kit.DELETE(req(`/api/style-kits/${KIT}`, "DELETE"), params(KIT))).status).toBe(200);
    expect(h.calls[0]).toMatchObject({ kind: "from", name: "style_kits" });
    expect(h.calls[0].chain.map((c) => c.m)).toEqual(["delete", "eq", "select"]);
    expect(h.calls[0].chain[1].a).toEqual(["id", KIT]);
  });
});

describe("POST /api/style-kits/attach", () => {
  it("writes only default_style_kit_id on the named channel", async () => {
    h.table = { data: [{ channel_id: "chan-a" }], error: null };
    const r = await out(await attach.POST(req("/api/style-kits/attach", "POST", { channel_id: "chan-a", kit_id: KIT })));
    expect(r).toEqual({ status: 200, body: { ok: true, channel_id: "chan-a", kit_id: KIT } });
    const call = h.calls[0];
    expect(call.name).toBe("channels");
    const update = call.chain.find((c) => c.m === "update")?.a[0] as Record<string, unknown>;
    expect(Object.keys(update).sort()).toEqual(["default_style_kit_id", "updated_at"]);
    expect(update.default_style_kit_id).toBe(KIT);
  });

  it("null clears; another org's kit is the guard's 404", async () => {
    h.table = { data: [{ channel_id: "chan-a" }], error: null };
    expect((await attach.POST(req("/api/style-kits/attach", "POST", { channel_id: "chan-a", kit_id: null }))).status).toBe(200);
    h.table = { data: null, error: { code: "P0002", message: "not_found" } };
    expect((await attach.POST(req("/api/style-kits/attach", "POST", { channel_id: "chan-a", kit_id: KIT }))).status).toBe(404);
  });

  it("a channel the caller cannot edit updates nothing: 404", async () => {
    h.table = { data: [], error: null };
    expect((await attach.POST(req("/api/style-kits/attach", "POST", { channel_id: "chan-b", kit_id: KIT }))).status).toBe(404);
  });

  it.each([{ channel_id: "a/b", kit_id: KIT }, { channel_id: "chan-a", kit_id: "x" }, { channel_id: "chan-a" }])(
    "refuses %j before the database",
    async (body) => {
      expect((await attach.POST(req("/api/style-kits/attach", "POST", body))).status).toBe(400);
      expect(h.calls).toEqual([]);
    },
  );
});

describe("/api/characters", () => {
  it("POST normalizes the @name and passes the kind", async () => {
    h.rpc = { data: KIT, error: null };
    const r = await out(await chars.POST(req("/api/characters", "POST", { name: "@Hero", kind: "product", asset_ids: [A(1)] })));
    expect(r).toEqual({ status: 201, body: { id: KIT, name: "hero" } });
    expect(h.calls[0].args).toEqual({
      p_org: ORG,
      p_character: null,
      p_name: "hero",
      p_kind: "product",
      p_description: "",
      p_assets: [A(1)],
    });
  });

  it("a taken @name is a 409", async () => {
    h.rpc = { data: null, error: { code: "NS409", message: "name_taken" } };
    expect(await out(await chars.POST(req("/api/characters", "POST", { name: "hero", asset_ids: [A(1)] })))).toEqual({
      status: 409,
      body: { error: "name_taken" },
    });
  });

  it("refuses a bad @name or nine images before the database", async () => {
    for (const body of [
      { name: "Has Space", asset_ids: [A(1)] },
      { name: "hero", asset_ids: Array.from({ length: 9 }, (_, i) => A(i + 1)) },
    ]) {
      expect((await chars.POST(req("/api/characters", "POST", body))).status).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });

  it("DELETE of nothing is a 404", async () => {
    h.table = { data: [], error: null };
    expect((await char.DELETE(req(`/api/characters/${KIT}`, "DELETE"), params(KIT))).status).toBe(404);
  });
});

describe("GET lists", () => {
  it("a missing migration is 503 not_available, a failed read 502 — never an empty list", async () => {
    h.table = { data: null, error: { code: "42P01", message: "relation does not exist" } };
    expect(await out(await kits.GET(req("/api/style-kits", "GET")))).toEqual({ status: 503, body: { error: "not_available" } });
    h.table = { data: null, error: { code: "XX000", message: "boom" } };
    expect(await out(await chars.GET(req("/api/characters", "GET")))).toEqual({ status: 502, body: { error: "read_failed" } });
  });

  it("reads only the asked org's rows", async () => {
    h.table = { data: [], error: null };
    const r = await out(await kits.GET(req(`/api/style-kits?org=${ORG}`, "GET")));
    expect(r).toEqual({ status: 200, body: { org: ORG, kits: [] } });
    for (const c of h.calls) expect(c.chain).toContainEqual({ m: "eq", a: ["org_id", ORG] });
  });
});

describe("never the service key", () => {
  const files = [
    "app/api/style-kits/route.ts",
    "app/api/style-kits/[id]/route.ts",
    "app/api/style-kits/attach/route.ts",
    "app/api/characters/route.ts",
    "app/api/characters/[id]/route.ts",
    "lib/server/style-kits.ts",
    "lib/style-kits.ts",
  ];
  it.each(files)("%s uses only the session client", (f) => {
    const src = readFileSync(join(__dirname, "..", f), "utf8");
    expect(src).not.toMatch(/SERVICE_ROLE|service_role|serviceRole|createServiceClient|SUPABASE_SECRET/i);
  });
});
