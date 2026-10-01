import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Open in editor": POST /api/editor/send, GET /api/editor/projects and the
 * pure functions that build the document (lib/editor.ts).
 *
 * What would break without these: a generated file going into ANOTHER
 * organization's project (a person in two organizations can read both
 * organizations' files, so the route pins the file to the project's own
 * organization); a refusal turning into a fake success or a 500; a send that
 * overwrites a save somebody made in between; a send that starts an export,
 * spends credits or publishes (it only writes a document); and the documents
 * themselves drifting from what modules/timeline.py will render (the same
 * cases are judged by tests/test_editor_open_in_editor.py).
 */

vi.mock("server-only", () => ({}));

type Err = { code?: string; message?: string };
type Result = { data: unknown; error: Err | null };
type Chain = { m: string; a: unknown[] }[];
const ORG = "0a000000-0000-4000-8000-00000000000a";
const OTHER_ORG = "0d000000-0000-4000-8000-00000000000d";
const PID = "0b000000-0000-4000-8000-00000000000b";
const NEW_ID = "0e000000-0000-4000-8000-00000000000e";
const VID = "0c000000-0000-4000-8000-00000000000c";
const IMG = "0f000000-0000-4000-8000-00000000000f";
const SND = "10000000-0000-4000-8000-000000000010";

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as { id: string; email: string } | null,
  current: null as { id: string } | null,
  rpc: {} as Record<string, Result | (() => Result)>,
  table: {} as Record<string, Result | ((chain: Chain) => Result)>,
  calls: [] as { kind: string; name: string; args?: unknown; chain: Chain }[],
  audits: [] as { action?: string; detail?: Record<string, unknown> }[],
}));

function builder(rec: { chain: Chain }, result: () => Result): unknown {
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
    return builder(rec, () => {
      const r = h.rpc[name];
      return typeof r === "function" ? r() : (r ?? { data: null, error: null });
    });
  },
  from: (name: string) => {
    const rec: Call = { kind: "from", name, chain: [] };
    h.calls.push(rec);
    return builder(rec, () => {
      const r = h.table[name];
      return typeof r === "function" ? r(rec.chain) : (r ?? { data: null, error: null });
    });
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, getUser: async () => h.user }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, orgs: [], current: h.current }) }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async (e: { action?: string }) => void h.audits.push(e) }));

const send = await import("../app/api/editor/send/route");
const projects = await import("../app/api/editor/projects/route");
const lib = await import("@/lib/editor");
type Doc = import("@/lib/editor").TimelineDoc;

const row = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  mime: kind === "video" ? "video/mp4" : kind === "image" ? "image/png" : "audio/mpeg",
  bytes: 1000,
  width: kind === "audio" ? null : 1280,
  height: kind === "audio" ? null : 720,
  duration_s: kind === "image" ? null : "12.5",
  source: "generation",
  original_name: `${kind}.bin`,
  variants: [],
  version: 1,
  created_at: "2026-10-01T00:00:00Z",
  ...extra,
});

const existingDoc = () => lib.newDocForAsset({ id: VID, durationS: 8, width: 1920, height: 1080 })!;
const PROJECT_ROW = (doc: unknown = existingDoc(), rev = 3, org = ORG) => ({
  id: PID,
  org_id: org,
  title: "Trip",
  rev,
  doc,
  updated_at: "2026-10-01T00:00:00Z",
});

/** media_assets as RLS + the route's own org pin would answer: a file is only returned for its own organization. */
function library(files: { id: string; org: string; kind: string }[]) {
  return (chain: Chain): Result => {
    const id = chain.find((c) => c.m === "eq" && c.a[0] === "id")?.a[1];
    const org = chain.find((c) => c.m === "eq" && c.a[0] === "org_id")?.a[1];
    const inIds = chain.find((c) => c.m === "in")?.a[1] as string[] | undefined;
    if (inIds)
      return { data: files.filter((f) => inIds.includes(f.id)).map((f) => ({ id: f.id, kind: f.kind })), error: null };
    // No org filter = RLS alone, which for a member of both organizations shows both.
    const f = files.find((x) => x.id === id && (org === undefined || x.org === org));
    return { data: f ? row(f.id, f.kind) : null, error: null };
  };
}

function setup(over: { files?: { id: string; org: string; kind: string }[]; project?: unknown } = {}) {
  h.table.editor_projects = { data: over.project ?? PROJECT_ROW(), error: null };
  h.table.editor_exports = { data: [], error: null };
  h.table.media_assets = library(over.files ?? [{ id: VID, org: ORG, kind: "video" }, { id: IMG, org: ORG, kind: "image" }, { id: SND, org: ORG, kind: "audio" }]);
  h.rpc.save_editor_project = { data: 4, error: null };
  h.rpc.create_editor_project = { data: NEW_ID, error: null };
}

const req = (body?: unknown) =>
  new Request("http://localhost/api/editor/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const rpcCalls = (name?: string) => h.calls.filter((c) => c.kind === "rpc" && (!name || c.name === name));
const savedDoc = () => (rpcCalls("save_editor_project")[0]!.args as { p_doc: Doc }).p_doc;

beforeEach(() => {
  h.user = { id: "u1", email: "me@example.com" };
  h.current = { id: ORG };
  h.rpc = {};
  h.table = {};
  h.calls = [];
  h.audits = [];
});

describe("POST /api/editor/send — a new project", () => {
  it("starts a project from a generated picture as a still, and names it", async () => {
    setup();
    const res = await send.POST(req({ asset_id: IMG, title: "  Cover   shot " }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: NEW_ID, created: true });
    const a = rpcCalls("create_editor_project")[0]!.args as { p_org: string; p_title: string; p_doc: Doc };
    expect(a.p_org).toBe(ORG);
    expect(a.p_title).toBe("Cover shot");
    expect(a.p_doc.tracks[0]!.clips[0]).toMatchObject({ asset_id: IMG, in_s: 0, out_s: lib.STILL_DEFAULT_S, audio: false });
    expect(lib.validateTimeline(a.p_doc)).toEqual([]);
    expect(h.audits[0]).toMatchObject({ action: "editor.send_asset", detail: { created: true, kind: "image" } });
  });

  it("starts a project from a generated sound under an empty picture track", async () => {
    setup();
    const res = await send.POST(req({ asset_id: SND, title: "Song" }));
    expect(res.status).toBe(201);
    const a = rpcCalls("create_editor_project")[0]!.args as { p_doc: Doc };
    expect(a.p_doc.tracks.map((t) => [t.kind, t.clips.length])).toEqual([["V", 0], ["A", 1]]);
    expect(lib.validateTimeline(a.p_doc)).toEqual([]);
  });

  it("refuses another organization's file like a made-up one, before anything is written", async () => {
    // The person belongs to both organizations: RLS would show them the file; the org pin must not.
    setup({ files: [{ id: IMG, org: OTHER_ORG, kind: "image" }] });
    const theirs = await send.POST(req({ asset_id: IMG, title: "Mine now" }));
    setup({ files: [] });
    const madeUp = await send.POST(req({ asset_id: IMG, title: "Mine now" }));
    expect(theirs.status).toBe(400);
    expect(await theirs.json()).toEqual({ error: "invalid_asset" });
    expect(madeUp.status).toBe(400);
    expect(rpcCalls("create_editor_project")).toHaveLength(0);
  });

  it("needs a title, a valid asset id and a session", async () => {
    setup();
    expect((await send.POST(req({ asset_id: IMG }))).status).toBe(400);
    expect((await send.POST(req({ asset_id: "nope", title: "x" }))).status).toBe(400);
    expect((await send.POST(req("not json"))).status).toBe(400);
    expect((await send.POST(req([1]))).status).toBe(400);
    h.user = null;
    expect((await send.POST(req({ asset_id: IMG, title: "x" }))).status).toBe(401);
    expect(rpcCalls()).toHaveLength(0);
  });

  it("reads a sound with no known length as unknown, never as zero", async () => {
    setup();
    h.table.media_assets = () => ({ data: row(SND, "audio", { duration_s: null }), error: null });
    const res = await send.POST(req({ asset_id: SND, title: "Song" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_duration" });
    expect(rpcCalls()).toHaveLength(0);
  });

  it("maps the database's refusals (not a member, limit reached)", async () => {
    setup();
    h.rpc.create_editor_project = { data: null, error: { code: "42501", message: "forbidden" } };
    expect((await send.POST(req({ asset_id: IMG, title: "x" }))).status).toBe(403);
    h.rpc.create_editor_project = { data: null, error: { code: "NS429", message: "limit_reached" } };
    const res = await send.POST(req({ asset_id: IMG, title: "x" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "limit_reached" });
    h.rpc.create_editor_project = { data: null, error: { code: "PGRST202", message: "could not find the function" } };
    expect((await send.POST(req({ asset_id: IMG, title: "x" }))).status).toBe(503);
  });
});

describe("POST /api/editor/send — an existing project", () => {
  it("adds a video at the end and saves it as the next revision of the one it read", async () => {
    setup({ files: [{ id: VID, org: ORG, kind: "video" }, { id: SND, org: ORG, kind: "video" }] });
    const res = await send.POST(req({ asset_id: SND, project_id: PID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: PID, rev: 4, created: false });
    const call = rpcCalls("save_editor_project")[0]!.args as { p_project: string; p_base_rev: number; p_title: unknown };
    expect(call).toMatchObject({ p_project: PID, p_base_rev: 3, p_title: null });
    const clips = savedDoc().tracks[0]!.clips;
    expect(clips.map((c) => c.asset_id)).toEqual([VID, SND]);
    expect(clips[1]!.start_s).toBe(8);
    expect(lib.validateTimeline(savedDoc())).toEqual([]);
  });

  it("puts a sound on its own audio track and keeps the texts it already had", async () => {
    const doc = existingDoc();
    doc.tracks.push({ id: "t1", kind: "T", clips: [{ id: "x1", start_s: 0, end_s: 2, text: "Hi" }] });
    setup({ project: PROJECT_ROW(doc) });
    const res = await send.POST(req({ asset_id: SND, project_id: PID }));
    expect(res.status).toBe(200);
    const tracks = savedDoc().tracks;
    expect(tracks.map((t) => t.kind)).toEqual(["V", "A", "T"]);
    expect(tracks[1]!.clips[0]).toMatchObject({ asset_id: SND, start_s: 0 });
    expect(tracks[2]!.clips[0]).toMatchObject({ text: "Hi" });
  });

  it("never lets a file of another organization into a project, even for a member of both", async () => {
    // Project of ORG; the file belongs to OTHER_ORG, which the same person can also read,
    // and OTHER_ORG is even the organization they currently have open.
    h.current = { id: OTHER_ORG };
    setup({ files: [{ id: IMG, org: OTHER_ORG, kind: "image" }] });
    const res = await send.POST(req({ asset_id: IMG, project_id: PID }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_asset" });
    expect(rpcCalls("save_editor_project")).toHaveLength(0);
    // The file was read pinned to the PROJECT's organization.
    const read = h.calls.find((c) => c.kind === "from" && c.name === "media_assets" && c.chain.some((x) => x.m === "eq" && x.a[0] === "id" && x.a[1] === IMG))!;
    expect(read.chain).toEqual(expect.arrayContaining([{ m: "eq", a: ["org_id", ORG] }]));
  });

  it("reads another organization's project as missing, and a made-up one the same", async () => {
    setup();
    h.table.editor_projects = { data: null, error: null };
    const res = await send.POST(req({ asset_id: IMG, project_id: PID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(rpcCalls()).toHaveLength(0);
  });

  it("refuses a body that names a different organization than the project's", async () => {
    setup();
    const res = await send.POST(req({ asset_id: IMG, project_id: PID, org_id: OTHER_ORG }));
    expect(res.status).toBe(400);
    expect(rpcCalls()).toHaveLength(0);
  });

  it("reads again and retries when somebody saved in between, then gives up honestly", async () => {
    setup();
    let n = 0;
    h.rpc.save_editor_project = () =>
      ++n === 1 ? { data: null, error: { code: "NS409", message: "stale_revision" } } : { data: 5, error: null };
    const ok = await send.POST(req({ asset_id: IMG, project_id: PID }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ rev: 5 });
    expect(rpcCalls("save_editor_project")).toHaveLength(2);

    h.calls = [];
    h.rpc.save_editor_project = { data: null, error: { code: "NS409", message: "stale_revision" } };
    const stuck = await send.POST(req({ asset_id: IMG, project_id: PID }));
    expect(stuck.status).toBe(409);
    expect(await stuck.json()).toEqual({ error: "stale_revision" });
    expect(rpcCalls("save_editor_project")).toHaveLength(3);
  });

  it("says so when the project is full instead of dropping the file", async () => {
    const doc = existingDoc();
    const clip = doc.tracks[0]!.clips[0]!;
    doc.tracks[0]!.clips = Array.from({ length: lib.MAX_EDITOR_CLIPS }, (_, i) => ({ ...clip, id: `c${i + 1}`, start_s: i * 8, audio: false }));
    setup({ project: PROJECT_ROW(doc) });
    const res = await send.POST(req({ asset_id: IMG, project_id: PID }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "clips_full" });
    expect(rpcCalls("save_editor_project")).toHaveLength(0);
  });

  it("is refused by the database as forbidden for a non-member, whatever the route read", async () => {
    setup();
    h.rpc.save_editor_project = { data: null, error: { code: "P0002", message: "not_found" } };
    const res = await send.POST(req({ asset_id: IMG, project_id: PID }));
    expect(res.status).toBe(404);
  });

  it("starts no export, spends nothing and publishes nothing", async () => {
    setup();
    await send.POST(req({ asset_id: IMG, project_id: PID }));
    await send.POST(req({ asset_id: IMG, title: "x" }));
    const used = new Set(rpcCalls().map((c) => c.name));
    expect([...used].sort()).toEqual(["create_editor_project", "save_editor_project"]);
  });
});

describe("GET /api/editor/projects", () => {
  const get = (q = "") => projects.GET(new Request(`http://localhost/api/editor/projects${q}`));

  it("lists the organization's projects under the caller's own session", async () => {
    h.table.editor_projects = { data: [{ id: PID, title: "Trip", rev: 2, updated_at: "2026-10-01T00:00:00Z" }], error: null };
    const res = await get(`?org_id=${ORG}`);
    expect(res.status).toBe(200);
    expect((await res.json()).projects).toEqual([{ id: PID, title: "Trip", rev: 2, updatedAt: "2026-10-01T00:00:00Z" }]);
    const read = h.calls.find((c) => c.kind === "from" && c.name === "editor_projects")!;
    expect(read.chain).toEqual(expect.arrayContaining([{ m: "eq", a: ["org_id", ORG] }]));
  });

  it("a failed read is a failure, never an empty list", async () => {
    h.table.editor_projects = { data: null, error: { code: "XX000", message: "boom" } };
    expect((await get(`?org_id=${ORG}`)).status).toBe(502);
    h.table.editor_projects = { data: null, error: { code: "42P01", message: "does not exist" } };
    expect((await get(`?org_id=${ORG}`)).status).toBe(503);
  });

  it("needs a session and a well-formed organization", async () => {
    expect((await get("?org_id=nope")).status).toBe(400);
    h.user = null;
    expect((await get(`?org_id=${ORG}`)).status).toBe(401);
  });
});

describe("the documents a send builds (lib/editor.ts)", () => {
  const cases = JSON.parse(readFileSync(join(__dirname, "..", "..", "samples", "editor_send_cases.json"), "utf8")).cases as {
    name: string;
    asset: { id: string; kind: "video" | "image" | "audio"; duration_s: number | null; width: number | null; height: number | null };
    doc: Doc | null;
    expected: Doc;
  }[];

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    const asset = { id: c.asset.id, kind: c.asset.kind, durationS: c.asset.duration_s, width: c.asset.width, height: c.asset.height };
    const built = c.doc ? lib.appendAssetToDoc(c.doc, asset) : { ok: true as const, doc: lib.newDocForAnyAsset(asset) };
    expect(built.ok).toBe(true);
    expect((built as { doc: Doc }).doc).toEqual(c.expected);
    expect(lib.validateTimeline(c.expected)).toEqual([]);
  });

  it("holds a still for a fixed time and gives it no sound of its own", () => {
    const doc = lib.newDocForAnyAsset({ id: IMG, kind: "image", durationS: null, width: 512, height: 512 })!;
    expect(doc.width).toBe(1080);
    expect(doc.tracks[0]!.clips[0]).toMatchObject({ out_s: lib.STILL_DEFAULT_S, audio: false });
  });

  it("never guesses a length: a video or sound without one is refused", () => {
    expect(lib.newDocForAnyAsset({ id: VID, kind: "video", durationS: null, width: 1, height: 1 })).toBeNull();
    expect(lib.newDocForAnyAsset({ id: SND, kind: "audio", durationS: 0, width: null, height: null })).toBeNull();
    expect(lib.appendAssetToDoc(existingDoc(), { id: SND, kind: "audio", durationS: null })).toEqual({ ok: false, problem: "no_duration" });
    expect(lib.appendAssetToDoc(existingDoc(), { id: VID, kind: "video", durationS: null })).toEqual({ ok: false, problem: "no_duration" });
  });

  it("stops at the sound limit with its own word", () => {
    let doc = existingDoc();
    for (let i = 0; i < lib.MAX_EDITOR_SOUNDS; i += 1) {
      const out = lib.appendAssetToDoc(doc, { id: SND, kind: "audio", durationS: 5 });
      expect(out.ok).toBe(true);
      doc = (out as { doc: Doc }).doc;
    }
    expect(lib.appendAssetToDoc(doc, { id: SND, kind: "audio", durationS: 5 })).toEqual({ ok: false, problem: "sounds_full" });
  });
});

describe("the send's sources", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  it.each(["app/api/editor/send/route.ts", "components/editor/SendToEditor.tsx"])("%s never holds the service key, credits or a publish path", (f) => {
    const src = read(f);
    expect(src).not.toMatch(/SERVICE_KEY|service_role|createServiceClient/);
    expect(src).not.toMatch(/reserve_credits|capture_credits|credit_prices|publish_requests|review_intents|request_editor_export/);
  });
  it("adds no migration: it uses the 0054 functions, which already check membership and organization", () => {
    const route = read("app/api/editor/send/route.ts");
    expect(route).toMatch(/rpc\("save_editor_project"/);
    expect(route).toMatch(/rpc\("create_editor_project"/);
  });
});
