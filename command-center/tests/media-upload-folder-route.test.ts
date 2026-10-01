import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Uploading into a folder (migration 0051), server half: POST
 * /api/media/uploads passes the open folder to request_upload, and GET
 * /api/media says which folder each upload in flight is going to.
 *
 * What would break without these: a folder id the route never checked
 * reaching the database; a call with no folder suddenly needing 0051 (every
 * upload on a deployment that has not applied it would fail); a deployment
 * without 0051 silently dropping the folder (the file in All files, the person
 * told nothing); the database's folder refusals turning into a generic error;
 * and the library going blank because media_uploads has no folder_id yet.
 */

vi.mock("server-only", () => ({}));

type Err = { code?: string; message?: string; details?: string };
type Result = { data: unknown; error: Err | null };
const ORG = "0a000000-0000-4000-8000-00000000000a";
const FOLDER = "0b000000-0000-4000-8000-00000000000b";
const TICKET = "0c000000-0000-4000-8000-00000000000c";

const h = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  rpc: (() => ({ data: null, error: null })) as (name: string, args: Record<string, unknown>) => Result,
  table: (() => ({ data: [], error: null })) as (name: string, chain: { m: string; a: unknown[] }[]) => Result,
  calls: [] as { kind: string; name: string; args?: Record<string, unknown>; chain: { m: string; a: unknown[] }[] }[],
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

const client = {
  rpc: (name: string, args: Record<string, unknown>) => {
    const rec = { kind: "rpc", name, args, chain: [] as { m: string; a: unknown[] }[] };
    h.calls.push(rec);
    return builder(rec, () => h.rpc(name, args));
  },
  from: (name: string) => {
    const rec = { kind: "from", name, chain: [] as { m: string; a: unknown[] }[] };
    h.calls.push(rec);
    return builder(rec, () => h.table(name, rec.chain));
  },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => client,
  getUser: async () => h.user,
}));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => {} }));

const { POST } = await import("../app/api/media/uploads/route");
const { mapMediaError, coerceUploads } = await import("../lib/media");
const { loadMediaLibrary } = await import("../lib/server/media");

const TICKET_ANSWER = (folder: string | null): Result => ({
  data: { ticket: TICKET, kind: "image", mime: "image/png", name: "a.png", max_bytes: 5, folder_id: folder },
  error: null,
});

let dirs: string;
beforeEach(() => {
  dirs = mkdtempSync(join(tmpdir(), "media-upload-folder-"));
  mkdirSync(join(dirs, "m"));
  mkdirSync(join(dirs, "s"));
  vi.stubEnv("NIGHTSHIFT_MEDIA_DIR", join(dirs, "m"));
  vi.stubEnv("NIGHTSHIFT_MEDIA_STAGING_DIR", join(dirs, "s"));
  h.user = { id: "u1" };
  h.calls = [];
  h.rpc = (_name, args) => TICKET_ANSWER((args.p_folder_id as string | undefined) ?? null);
  h.table = () => ({ data: [], error: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dirs, { recursive: true, force: true });
});

const post = (body: unknown) =>
  POST(new Request("https://x/api/media/uploads", { method: "POST", body: JSON.stringify(body) }));
const rpcs = () => h.calls.filter((c) => c.kind === "rpc");
const BASE = { org_id: ORG, filename: "a.png", mime: "image/png", bytes: 5 };

describe("POST /api/media/uploads with a folder", () => {
  it("without a folder sends exactly the five arguments every database version takes", async () => {
    const res = await post(BASE);
    expect(res.status).toBe(200);
    expect(Object.keys(rpcs()[0].args ?? {}).sort()).toEqual(["p_bytes", "p_filename", "p_mime", "p_org", "p_project_id"]);
    const body = await res.json();
    expect(body.folder_id).toBeNull();
    // Nothing was asked, so nothing is claimed either way.
    expect(body.folder_applied).toBeNull();
  });

  it("with the open folder, asks the database to file the upload there", async () => {
    const res = await post({ ...BASE, folder_id: FOLDER });
    expect(res.status).toBe(200);
    expect(rpcs()).toHaveLength(1);
    expect(rpcs()[0]).toMatchObject({ name: "request_upload", args: { p_org: ORG, p_folder_id: FOLDER, p_project_id: null } });
    expect(await res.json()).toMatchObject({ ticket: TICKET, folder_id: FOLDER, folder_applied: true });
  });

  it("refuses a folder id that is not an id, before the database", async () => {
    for (const bad of ["../x", "not-a-uuid", 12, { id: FOLDER }]) {
      const res = await post({ ...BASE, folder_id: bad });
      expect(res.status).toBe(400);
    }
    expect(rpcs()).toEqual([]);
  });

  it("says the database's folder refusals as their own words", async () => {
    h.rpc = () => ({ data: null, error: { code: "P0002", message: "no such folder in this organization", details: "reason=folder_not_found" } });
    let res = await post({ ...BASE, folder_id: FOLDER });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "folder_not_found" });

    h.rpc = () => ({ data: null, error: { code: "42501", message: "only an editor…", details: "reason=folder_forbidden" } });
    res = await post({ ...BASE, folder_id: FOLDER });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "folder_forbidden" });
    // A refusal is final: the route does not quietly retry into All files.
    expect(rpcs()).toHaveLength(2);
  });

  it("before 0051, uploads to All files and says so instead of dropping the folder silently", async () => {
    h.rpc = (_n, args) =>
      "p_folder_id" in args
        ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.request_upload(...)" } }
        : TICKET_ANSWER(null);
    const res = await post({ ...BASE, folder_id: FOLDER });
    expect(res.status).toBe(200);
    expect(rpcs().map((c) => "p_folder_id" in (c.args ?? {}))).toEqual([true, false]);
    expect(await res.json()).toMatchObject({ ticket: TICKET, folder_id: null, folder_applied: false });
  });

  it("before 0038 it is still 'not available', not a fake success", async () => {
    h.rpc = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const res = await post({ ...BASE, folder_id: FOLDER });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "not_available" });
  });
});

describe("mapping and reading", () => {
  it("keeps the old meanings of 42501 and P0002 when the refusal is not about a folder", () => {
    expect(mapMediaError({ code: "42501", message: "only a member…" })).toEqual({ error: "forbidden", status: 403 });
    expect(mapMediaError({ code: "P0002", message: "no such upload" })).toEqual({ error: "not_found", status: 404 });
  });

  it("an upload's folder is read only when it is an id", () => {
    const [a, b, c] = coerceUploads([
      { id: TICKET, original_name: "a.png", status: "uploaded", declared_bytes: 5, folder_id: FOLDER },
      { id: TICKET.replace("c", "d"), original_name: "b.png", status: "uploaded", declared_bytes: 5, folder_id: "../x" },
      { id: TICKET.replace("c", "e"), original_name: "c.png", status: "uploaded", declared_bytes: 5 },
    ]);
    expect([a.folderId, b.folderId, c.folderId]).toEqual([FOLDER, null, null]);
  });

  it("GET reads each upload's folder, and before 0051 reads the uploads as before", async () => {
    const withFolder = (chain: { m: string; a: unknown[] }[]) => chain.some((x) => x.m === "select" && String(x.a[0]).includes("folder_id"));
    const upload = { id: TICKET, original_name: "a.png", status: "uploaded", declared_bytes: 5, received_bytes: 5 };
    h.table = (name) =>
      name === "media_uploads" ? { data: [{ ...upload, folder_id: FOLDER }], error: null } : { data: [], error: null };
    let lib = await loadMediaLibrary(ORG);
    expect(lib.available).toBe(true);
    expect(lib.uploads.map((u) => u.folderId)).toEqual([FOLDER]);

    h.calls = [];
    h.table = (name, chain) =>
      name !== "media_uploads"
        ? { data: [], error: null }
        : withFolder(chain)
          ? { data: null, error: { code: "42703", message: "column media_uploads.folder_id does not exist" } }
          : { data: [upload], error: null };
    lib = await loadMediaLibrary(ORG);
    expect(lib.available).toBe(true);
    expect(lib.error).toBeUndefined();
    expect(lib.uploads.map((u) => [u.id, u.folderId])).toEqual([[TICKET, null]]);
    expect(h.calls.filter((c) => c.kind === "from" && c.name === "media_uploads")).toHaveLength(2);
  });
});
