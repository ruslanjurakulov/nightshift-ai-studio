import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The parent link of an edited picture (migration 0128), server half: POST /api/media/uploads passes the picture an edit was made from to
 * request_upload's seven-argument overload, only while the image editor's flag is on, and never lets the link cost the person their edit.
 *
 * What would break without these: a parent id the route never checked reaching the database; a parent sent while the editor is off; a
 * deployment without 0128 failing every editor save (or, worse, dropping the link without saying so); a made-up or foreign picture failing
 * the save instead of saving unlinked, or answering differently from a made-up one (an oracle across organizations); a real refusal
 * (quota, folder) being retried into a successful unlinked upload; and the plain upload (no parent) changing at all.
 */

vi.mock("server-only", () => ({}));

type Err = { code?: string; message?: string; details?: string };
type Result = { data: unknown; error: Err | null };
const ORG = "0a000000-0000-4000-8000-00000000000a";
const FOLDER = "0b000000-0000-4000-8000-00000000000b";
const TICKET = "0c000000-0000-4000-8000-00000000000c";
const PARENT = "0d000000-0000-4000-8000-00000000000d";

const h = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  rpc: (() => ({ data: null, error: null })) as (name: string, args: Record<string, unknown>) => Result,
  audits: [] as Record<string, unknown>[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.calls.push({ name, args });
      return h.rpc(name, args);
    },
  }),
  getUser: async () => h.user,
}));
vi.mock("@/lib/server/audit", () => ({ logAudit: async (a: Record<string, unknown>) => void h.audits.push(a) }));

const { POST } = await import("../app/api/media/uploads/route");
const { mapMediaError } = await import("../lib/media");

const ticket = (args: Record<string, unknown>): Result => ({
  data: {
    ticket: TICKET,
    kind: "image",
    mime: "image/png",
    name: "a.png",
    max_bytes: 5,
    folder_id: (args.p_folder_id as string | null | undefined) ?? null,
    ...("p_parent_asset_id" in args ? { parent_asset_id: args.p_parent_asset_id } : {}),
  },
  error: null,
});
const missing: Result = { data: null, error: { code: "PGRST202", message: "Could not find the function public.request_upload(...)" } };
const parentGone: Result = { data: null, error: { code: "P0002", message: "no such picture in this organization", details: "reason=parent_not_found" } };

let dirs: string;
beforeEach(() => {
  dirs = mkdtempSync(join(tmpdir(), "media-upload-parent-"));
  mkdirSync(join(dirs, "m"));
  mkdirSync(join(dirs, "s"));
  vi.stubEnv("NIGHTSHIFT_MEDIA_DIR", join(dirs, "m"));
  vi.stubEnv("NIGHTSHIFT_MEDIA_STAGING_DIR", join(dirs, "s"));
  vi.stubEnv("NIGHTSHIFT_IMAGE_EDITOR", "on");
  h.user = { id: "u1" };
  h.calls = [];
  h.audits = [];
  h.rpc = (_name, args) => ticket(args);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dirs, { recursive: true, force: true });
});

const post = (body: unknown) =>
  POST(new Request("https://x/api/media/uploads", { method: "POST", headers: { origin: "https://x" }, body: JSON.stringify(body) }));
const BASE = { org_id: ORG, filename: "a-edited.png", mime: "image/png", bytes: 5 };
const argNames = (i: number) => Object.keys(h.calls[i].args).sort();

describe("POST /api/media/uploads with a parent", () => {
  it("asks the database to link the upload to the picture, with all seven arguments, and says so", async () => {
    const res = await post({ ...BASE, parent_asset_id: PARENT });
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      name: "request_upload",
      args: { p_org: ORG, p_project_id: null, p_folder_id: null, p_parent_asset_id: PARENT },
    });
    expect(argNames(0)).toEqual(["p_bytes", "p_filename", "p_folder_id", "p_mime", "p_org", "p_parent_asset_id", "p_project_id"]);
    expect(await res.json()).toMatchObject({ ok: true, ticket: TICKET, parent_applied: true, parent_asset_id: PARENT });
    expect(h.audits[0]).toMatchObject({ action: "media.upload_request", detail: { parent: PARENT } });
  });

  it("claims what the database answered, not what was asked", async () => {
    h.rpc = (_n, args) => {
      const r = ticket(args);
      (r.data as Record<string, unknown>).parent_asset_id = null;
      return r;
    };
    const body = await (await post({ ...BASE, parent_asset_id: PARENT })).json();
    expect(body.parent_asset_id).toBeNull();
  });

  it("without a parent sends exactly the arguments it always did, and claims nothing", async () => {
    const res = await post(BASE);
    expect(argNames(0)).toEqual(["p_bytes", "p_filename", "p_mime", "p_org", "p_project_id"]);
    expect(await res.json()).toMatchObject({ parent_asset_id: null, parent_applied: null });
    const withFolder = await post({ ...BASE, folder_id: FOLDER });
    expect(h.calls[1].args).toMatchObject({ p_folder_id: FOLDER });
    expect("p_parent_asset_id" in h.calls[1].args).toBe(false);
    expect(await withFolder.json()).toMatchObject({ parent_applied: null });
  });

  it("carries the open folder along with the parent", async () => {
    const res = await post({ ...BASE, folder_id: FOLDER, parent_asset_id: PARENT });
    expect(h.calls[0].args).toMatchObject({ p_folder_id: FOLDER, p_parent_asset_id: PARENT });
    expect(await res.json()).toMatchObject({ folder_id: FOLDER, folder_applied: true, parent_applied: true });
  });

  it("refuses a parent that is not an id, before the database", async () => {
    for (const bad of ["../x", "not-a-uuid", 12, { id: PARENT }, [PARENT], ""]) {
      const res = await post({ ...BASE, parent_asset_id: bad });
      expect(res.status).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });

  it("ignores a parent while the image editor is off: nothing is forwarded, and the answer says no link", async () => {
    for (const off of ["", "off", "0", "no"]) {
      vi.stubEnv("NIGHTSHIFT_IMAGE_EDITOR", off);
      h.calls = [];
      const res = await post({ ...BASE, parent_asset_id: PARENT });
      expect(res.status).toBe(200);
      expect(h.calls).toHaveLength(1);
      expect("p_parent_asset_id" in h.calls[0].args).toBe(false);
      expect(await res.json()).toMatchObject({ ticket: TICKET, parent_applied: false, parent_asset_id: null });
    }
  });

  it("before 0128 saves without the link and says so, instead of failing the edit", async () => {
    h.rpc = (_n, args) => ("p_parent_asset_id" in args ? missing : ticket(args));
    const res = await post({ ...BASE, parent_asset_id: PARENT });
    expect(res.status).toBe(200);
    expect(h.calls.map((c) => "p_parent_asset_id" in c.args)).toEqual([true, false]);
    expect(await res.json()).toMatchObject({ ticket: TICKET, parent_applied: false, parent_asset_id: null });
    expect(h.audits[0]).toMatchObject({ detail: { parent: null } });
  });

  it("before 0128 and 0051, the folder is dropped and said, and the parent too", async () => {
    h.rpc = (_n, args) => ("p_folder_id" in args ? missing : ticket(args));
    const res = await post({ ...BASE, folder_id: FOLDER, parent_asset_id: PARENT });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ folder_id: null, folder_applied: false, parent_applied: false });
  });

  it("a picture that is not the caller's to link (foreign, deleted, made up) saves unlinked, with one and the same answer", async () => {
    h.rpc = (_n, args) => ("p_parent_asset_id" in args ? parentGone : ticket(args));
    const a = await post({ ...BASE, parent_asset_id: PARENT });
    const b = await post({ ...BASE, parent_asset_id: "0e000000-0000-4000-8000-00000000000e" });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
    expect(h.calls.map((c) => "p_parent_asset_id" in c.args)).toEqual([true, false, true, false]);
  });

  it("every other refusal is final: no retry into an unlinked upload", async () => {
    const refusals: [Err, number, string][] = [
      [{ code: "NS507", message: "not enough storage", details: "used=1 pending=0 limit=2 requested=3" }, 507, "quota_exceeded"],
      [{ code: "NS415", message: "type", details: "reason=unsupported_type" }, 415, "unsupported_type"],
      [{ code: "42501", message: "only a member…" }, 403, "forbidden"],
      [{ code: "P0002", message: "no such folder", details: "reason=folder_not_found" }, 404, "folder_not_found"],
    ];
    for (const [err, status, word] of refusals) {
      h.calls = [];
      h.rpc = () => ({ data: null, error: err });
      const res = await post({ ...BASE, folder_id: FOLDER, parent_asset_id: PARENT });
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ error: word });
      expect(h.calls).toHaveLength(1);
    }
  });

  it("before 0038 it is still 'not available', not a fake success", async () => {
    h.rpc = () => missing;
    const res = await post({ ...BASE, parent_asset_id: PARENT });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "not_available" });
  });

  it("signed out: nothing is asked of the database", async () => {
    h.user = null;
    expect((await post({ ...BASE, parent_asset_id: PARENT })).status).toBe(401);
    expect(h.calls).toEqual([]);
  });
});

describe("mapMediaError for the parent", () => {
  it("names the parent refusal, and leaves every older P0002 and 42501 alone", () => {
    expect(mapMediaError({ code: "P0002", message: "x", details: "reason=parent_not_found" })).toEqual({ error: "parent_not_found", status: 404 });
    expect(mapMediaError({ code: "P0002", message: "x", details: "reason=folder_not_found" })).toEqual({ error: "folder_not_found", status: 404 });
    expect(mapMediaError({ code: "P0002", message: "no such upload" })).toEqual({ error: "not_found", status: 404 });
    expect(mapMediaError({ code: "42501", message: "only a member…" })).toEqual({ error: "forbidden", status: 403 });
  });
});
