import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/media/folders, /api/media/folders/<id>, /api/media/move and the
 * folder / search narrowing of GET /api/media (migration 0049).
 *
 * What would break without these: a malformed body reaching the database (or
 * worse, half-validated), a refusal from the database turning into a 500 or a
 * fake success, a search box that turns "%" into "match everything", the
 * library going blank on a deployment where 0049 is not applied yet, and a
 * route quietly reaching for the service key — which would skip every RLS
 * policy and same-org check 0049 has.
 *
 * The database is faked at the edges the routes touch: the session, the org
 * context, rpc() and the table builder. Every call is recorded.
 */

vi.mock("server-only", () => ({}));

type Err = { code?: string; message?: string };
type Result = { data: unknown; error: Err | null };
const ORG = "0a000000-0000-4000-8000-00000000000a";
const FOLDER = "0b000000-0000-4000-8000-00000000000b";
const A = (n: number) => `0c000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as { id: string; email: string } | null,
  current: null as { id: string } | null,
  rpc: {} as Record<string, Result>,
  table: {} as Record<string, Result | ((chain: { m: string; a: unknown[] }[]) => Result)>,
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
const OK: Result = { data: [], error: null };

const client = {
  rpc: (name: string, args: unknown) => {
    const rec: Call = { kind: "rpc", name, args, chain: [] };
    h.calls.push(rec);
    return builder(rec, () => h.rpc[name] ?? { data: null, error: null });
  },
  from: (name: string) => {
    const rec: Call = { kind: "from", name, chain: [] };
    h.calls.push(rec);
    return builder(rec, () => {
      const r = h.table[name];
      return typeof r === "function" ? r(rec.chain) : (r ?? OK);
    });
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

const folders = await import("../app/api/media/folders/route");
const folder = await import("../app/api/media/folders/[id]/route");
const move = await import("../app/api/media/move/route");
const library = await import("../app/api/media/route");

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
  h.rpc = {};
  h.table = {};
  h.calls.length = 0;
  h.audits.length = 0;
});

const MOVE_BODY = { folder_id: FOLDER, asset_ids: [A(1), A(2)] };

describe("signed out", () => {
  it("every route answers 401 and touches nothing", async () => {
    h.user = null;
    const all = [
      folders.GET(req("/api/media/folders", "GET")),
      folders.POST(req("/api/media/folders", "POST", { name: "Brand" })),
      folder.PATCH(req(`/api/media/folders/${FOLDER}`, "PATCH", { name: "Brand" }), params(FOLDER)),
      folder.DELETE(req(`/api/media/folders/${FOLDER}`, "DELETE"), params(FOLDER)),
      move.POST(req("/api/media/move", "POST", MOVE_BODY)),
    ];
    for (const r of await Promise.all(all)) expect(r.status).toBe(401);
    expect(h.calls).toEqual([]);
  });
});

describe("POST /api/media/folders", () => {
  it("calls save_media_folder as the user with the cleaned name and the open org", async () => {
    h.rpc.save_media_folder = { data: FOLDER, error: null };
    const r = await out(await folders.POST(req("/api/media/folders", "POST", { name: "  Brand\u0007   photos " })));
    expect(r).toEqual({ status: 201, body: { id: FOLDER, name: "Brand photos" } });
    expect(h.calls).toEqual([
      { kind: "rpc", name: "save_media_folder", args: { p_org: ORG, p_folder: null, p_name: "Brand photos" }, chain: [] },
    ]);
    expect(h.audits).toEqual([{ action: "media.folder_create", target: FOLDER, detail: { org: ORG } }]);
  });

  it.each([
    ["not JSON", "{", "bad_request"],
    ["an empty name", { name: "   " }, "invalid_name"],
    ["a long name", { name: "n".repeat(61) }, "invalid_name"],
    ["a name that is not text", { name: 7 }, "invalid_name"],
    ["a bad org", { name: "Brand", org_id: "not-a-uuid" }, "bad_request"],
  ])("refuses %s with 400 before the database", async (_l, body, word) => {
    expect(await out(await folders.POST(req("/api/media/folders", "POST", body)))).toEqual({ status: 400, body: { error: word } });
    expect(h.calls).toEqual([]);
  });

  it("needs an organization", async () => {
    h.current = null;
    expect(await out(await folders.POST(req("/api/media/folders", "POST", { name: "Brand" })))).toEqual({
      status: 400,
      body: { error: "org_required" },
    });
  });

  it.each([
    [{ code: "NS409", message: "name_taken" }, 409, "name_taken"],
    [{ code: "NS429", message: "limit_reached" }, 409, "limit_reached"],
    [{ code: "42501", message: "forbidden" }, 403, "forbidden"],
    [{ code: "PGRST202", message: "Could not find the function" }, 503, "not_available"],
    [{ code: "XX000", message: "boom" }, 502, "failed"],
  ])("maps the database's refusal %j", async (error, status, word) => {
    h.rpc.save_media_folder = { data: null, error };
    expect(await out(await folders.POST(req("/api/media/folders", "POST", { name: "Brand" })))).toEqual({ status, body: { error: word } });
    expect(h.audits).toEqual([]);
  });

  it("an answer that is not an id is a failure, not a success", async () => {
    h.rpc.save_media_folder = { data: { weird: true }, error: null };
    expect((await folders.POST(req("/api/media/folders", "POST", { name: "Brand" }))).status).toBe(502);
  });
});

describe("PATCH and DELETE /api/media/folders/<id>", () => {
  it("PATCH lets the database take the org from the folder", async () => {
    h.rpc.save_media_folder = { data: FOLDER, error: null };
    const r = await out(await folder.PATCH(req(`/api/media/folders/${FOLDER}`, "PATCH", { name: "Renamed", org_id: A(9) }), params(FOLDER)));
    expect(r).toEqual({ status: 200, body: { id: FOLDER, name: "Renamed" } });
    expect(h.calls[0].args).toEqual({ p_org: null, p_folder: FOLDER, p_name: "Renamed" });
  });

  it("another org's folder is a 404 from the database, passed on", async () => {
    h.rpc.save_media_folder = { data: null, error: { code: "P0002", message: "not_found" } };
    h.rpc.delete_media_folder = { data: null, error: { code: "P0002", message: "not_found" } };
    expect(await out(await folder.PATCH(req(`/api/media/folders/${FOLDER}`, "PATCH", { name: "x" }), params(FOLDER)))).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    expect((await folder.DELETE(req(`/api/media/folders/${FOLDER}`, "DELETE"), params(FOLDER))).status).toBe(404);
    expect(h.audits).toEqual([]);
  });

  it("a malformed id never reaches the database", async () => {
    expect((await folder.PATCH(req("/api/media/folders/x", "PATCH", { name: "x" }), params("../x"))).status).toBe(400);
    expect((await folder.DELETE(req("/api/media/folders/x", "DELETE"), params("x"))).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it("DELETE runs delete_media_folder under the session and needs its 'true'", async () => {
    h.rpc.delete_media_folder = { data: true, error: null };
    expect(await out(await folder.DELETE(req(`/api/media/folders/${FOLDER}`, "DELETE"), params(FOLDER)))).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(h.calls).toEqual([{ kind: "rpc", name: "delete_media_folder", args: { p_org: null, p_folder: FOLDER }, chain: [] }]);
    h.rpc.delete_media_folder = { data: null, error: null };
    expect((await folder.DELETE(req(`/api/media/folders/${FOLDER}`, "DELETE"), params(FOLDER))).status).toBe(502);
  });
});

describe("POST /api/media/move", () => {
  it("calls move_media_assets with the org, the folder and the de-duplicated ids", async () => {
    h.rpc.move_media_assets = { data: 2, error: null };
    const r = await out(await move.POST(req("/api/media/move", "POST", { ...MOVE_BODY, asset_ids: [A(1), A(2), A(1)] })));
    expect(r).toEqual({ status: 200, body: { ok: true, moved: 2, folder_id: FOLDER } });
    expect(h.calls).toEqual([
      { kind: "rpc", name: "move_media_assets", args: { p_org: ORG, p_folder: FOLDER, p_assets: [A(1), A(2)] }, chain: [] },
    ]);
    expect(h.audits).toEqual([{ action: "media.move", target: FOLDER, detail: { org: ORG, files: 2, moved: 2 } }]);
  });

  it("folder_id null takes the files out of their folder", async () => {
    h.rpc.move_media_assets = { data: 1, error: null };
    await move.POST(req("/api/media/move", "POST", { folder_id: null, asset_ids: [A(1)] }));
    expect(h.calls[0].args).toEqual({ p_org: ORG, p_folder: null, p_assets: [A(1)] });
  });

  it.each([
    ["not JSON", "{", "bad_request"],
    ["no folder_id", { asset_ids: [A(1)] }, "bad_request"],
    ["a path for a folder", { folder_id: "../../x", asset_ids: [A(1)] }, "bad_request"],
    ["no files", { folder_id: null, asset_ids: [] }, "no_assets"],
    ["201 files", { folder_id: null, asset_ids: Array.from({ length: 201 }, (_, i) => A(i)) }, "too_many_assets"],
    ["a made-up id shape", { folder_id: null, asset_ids: [A(1), "1 or 1=1"] }, "invalid_asset"],
    ["a bad org", { ...MOVE_BODY, org_id: "nope" }, "bad_request"],
  ])("refuses %s with 400 before the database", async (_l, body, word) => {
    expect(await out(await move.POST(req("/api/media/move", "POST", body)))).toEqual({ status: 400, body: { error: word } });
    expect(h.calls).toEqual([]);
  });

  it.each([
    [{ code: "NS400", message: "invalid_asset" }, 400, "invalid_asset"],
    [{ code: "P0002", message: "not_found" }, 404, "not_found"],
    [{ code: "42501", message: "forbidden" }, 403, "forbidden"],
    [{ code: "42883", message: "function does not exist" }, 503, "not_available"],
  ])("maps the database's refusal %j", async (error, status, word) => {
    h.rpc.move_media_assets = { data: null, error };
    expect(await out(await move.POST(req("/api/media/move", "POST", MOVE_BODY)))).toEqual({ status, body: { error: word } });
    expect(h.audits).toEqual([]);
  });

  it("an answer that is not a count is a failure, not a success", async () => {
    h.rpc.move_media_assets = { data: "2", error: null };
    expect((await move.POST(req("/api/media/move", "POST", MOVE_BODY))).status).toBe(502);
  });
});

describe("GET /api/media/folders", () => {
  it("lists the asked org's folders with counts, by name", async () => {
    h.table.media_folders = { data: [{ id: A(2), name: "zeta" }, { id: A(1), name: "Alpha" }], error: null };
    h.rpc.media_folder_counts = { data: [{ folder_id: A(2), assets: 4 }, { folder_id: null, assets: 1 }], error: null };
    const r = await out(await folders.GET(req(`/api/media/folders?org=${ORG}`, "GET")));
    expect(r).toEqual({
      status: 200,
      body: {
        org: ORG,
        folders: [
          { id: A(1), name: "Alpha", count: 0 },
          { id: A(2), name: "zeta", count: 4 },
        ],
        total: 5,
        unfiled: 1,
      },
    });
    const read = h.calls.find((c) => c.name === "media_folders")!;
    expect(read.chain).toContainEqual({ m: "eq", a: ["org_id", ORG] });
    expect(h.calls.find((c) => c.name === "media_folder_counts")?.args).toEqual({ p_org: ORG });
  });

  it("a missing migration is 503 not_available, a failed read 502 — never an empty list", async () => {
    h.table.media_folders = { data: null, error: { code: "42P01", message: "relation does not exist" } };
    expect(await out(await folders.GET(req("/api/media/folders", "GET")))).toEqual({ status: 503, body: { error: "not_available" } });
    h.table.media_folders = { data: null, error: { code: "XX000", message: "boom" } };
    expect(await out(await folders.GET(req("/api/media/folders", "GET")))).toEqual({ status: 502, body: { error: "read_failed" } });
  });

  it("an unreadable count is not a zero", async () => {
    h.table.media_folders = { data: [{ id: A(1), name: "Alpha" }], error: null };
    h.rpc.media_folder_counts = { data: null, error: { code: "XX000", message: "boom" } };
    const r = await out(await folders.GET(req("/api/media/folders", "GET")));
    expect(r.body.folders).toEqual([{ id: A(1), name: "Alpha", count: null }]);
    expect(r.body.total).toBeNull();
  });
});

describe("GET /api/media narrowed by folder and search", () => {
  const assetRow = (n: number, folderId: string | null) => ({
    id: A(n),
    kind: "image",
    mime: "image/png",
    bytes: 10,
    source: "upload",
    original_name: `f${n}.png`,
    variants: [],
    version: 1,
    created_at: "2026-09-01T00:00:00Z",
    folder_id: folderId,
  });

  // A row as PostgREST returns it before 0049: no folder_id key at all.
  const withoutFolder = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== "folder_id"));

  it("reads one folder's files, with the search escaped for ilike", async () => {
    h.table.media_assets = { data: [assetRow(1, FOLDER)], error: null };
    h.table.media_folders = { data: [{ id: FOLDER, name: "Brand" }], error: null };
    h.rpc.media_folder_counts = { data: [{ folder_id: FOLDER, assets: 1 }], error: null };
    const r = await out(await library.GET(req(`/api/media?org=${ORG}&folder=${FOLDER}&q=${encodeURIComponent("50%_*off")}`, "GET")));
    expect(r.status).toBe(200);
    expect(r.body.folder).toBe(FOLDER);
    expect(r.body.query).toBe("50%_off");
    expect((r.body.assets as { folderId: string }[])[0].folderId).toBe(FOLDER);
    const read = h.calls.find((c) => c.name === "media_assets")!;
    expect(read.chain).toContainEqual({ m: "eq", a: ["folder_id", FOLDER] });
    expect(read.chain).toContainEqual({ m: "ilike", a: ["original_name", "%50\\%\\_off%"] });
    expect(read.chain).toContainEqual({ m: "eq", a: ["org_id", ORG] });
    expect((r.body.folders as { folders: unknown[] }).folders).toEqual([{ id: FOLDER, name: "Brand", count: 1 }]);
  });

  it("a malformed folder never reaches the database", async () => {
    expect((await library.GET(req(`/api/media?org=${ORG}&folder=..%2Fx`, "GET"))).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it("before 0049 the library reads exactly as it did: no folder filter, no folders", async () => {
    h.table.media_assets = (chain) =>
      String(chain.find((c) => c.m === "select")?.a[0]).includes("folder_id")
        ? { data: null, error: { code: "42703", message: "column media_assets.folder_id does not exist" } }
        : { data: [withoutFolder(assetRow(1, null))], error: null };
    h.table.media_folders = { data: null, error: { code: "42P01", message: "relation does not exist" } };
    const r = await out(await library.GET(req(`/api/media?org=${ORG}&folder=${FOLDER}`, "GET")));
    expect(r.status).toBe(200);
    expect((r.body.assets as unknown[]).length).toBe(1);
    expect(r.body.folder).toBeNull();
    expect((r.body.folders as { available: boolean }).available).toBe(false);
    const reads = h.calls.filter((c) => c.name === "media_assets");
    expect(reads).toHaveLength(2);
    expect(reads[1].chain.some((c) => c.m === "eq" && c.a[0] === "folder_id")).toBe(false);
  });

  it("a full page says so, so the page can say there are more", async () => {
    h.table.media_assets = { data: Array.from({ length: 200 }, (_, i) => assetRow(i + 1, null)), error: null };
    const r = await out(await library.GET(req(`/api/media?org=${ORG}`, "GET")));
    expect(r.body.truncated).toBe(true);
  });
});

describe("never the service key", () => {
  const files = [
    "app/api/media/folders/route.ts",
    "app/api/media/folders/[id]/route.ts",
    "app/api/media/move/route.ts",
    "app/api/media/route.ts",
    "lib/server/media-folders.ts",
    "lib/server/media.ts",
    "lib/media-folders.ts",
    "components/media/folderApi.ts",
  ];
  it.each(files)("%s uses only the session client", (f) => {
    const src = readFileSync(join(__dirname, "..", f), "utf8");
    expect(src).not.toMatch(/SERVICE_ROLE|service_role|serviceRole|createServiceClient|SUPABASE_SECRET/i);
  });
});
