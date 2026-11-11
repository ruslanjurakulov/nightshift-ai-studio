import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/editor/projects/<id>/exports with `frames`, and the editor's read of export rows (migration 0129, behind
 * NIGHTSHIFT_MULTI_RATIO_EXPORT).
 *
 * What would break without these: the switch being off and the route still reading `frames`; a plain export changing
 * by one byte (its call, its answer, its audit line); a width, height or ratio from a client reaching the database; a
 * size outside the closed list reaching it at all; a deployment without 0129 rendering the project's own frame IN
 * PLACE of the size that was asked for, or failing to open the editor because a column is missing; one refused size
 * hiding the sizes that were queued; and the route reaching for the service key or a price.
 *
 * The database is faked at the edges the route touches: the session, rpc() and the table builder. An rpc answer may
 * depend on the arguments, because the two overloads of request_editor_export share a name.
 */

vi.mock("server-only", () => ({}));

type Err = { code?: string; message?: string };
type Result = { data: unknown; error: Err | null };
type Chain = { m: string; a: unknown[] }[];
const PID = "0b000000-0000-4000-8000-00000000000b";
const ORG = "0a000000-0000-4000-8000-00000000000a";
const E = (n: number) => `0d000000-0000-4000-8000-00000000000${n}`;

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as { id: string; email: string } | null,
  rpc: {} as Record<string, Result | ((args: Record<string, unknown>) => Result)>,
  table: {} as Record<string, Result | ((chain: { m: string; a: unknown[] }[]) => Result)>,
  calls: [] as { kind: string; name: string; args?: Record<string, unknown>; chain: { m: string; a: unknown[] }[] }[],
  audits: [] as { action: string; target?: string; detail?: Record<string, unknown> }[],
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

const client = {
  rpc: (name: string, args: Record<string, unknown>) => {
    const rec = { kind: "rpc", name, args, chain: [] as Chain };
    h.calls.push(rec);
    return builder(rec, () => {
      const r = h.rpc[name];
      return typeof r === "function" ? r(args) : (r ?? { data: null, error: null });
    });
  },
  from: (name: string) => {
    const rec = { kind: "from", name, chain: [] as Chain };
    h.calls.push(rec);
    return builder(rec, () => {
      const r = h.table[name];
      return typeof r === "function" ? r(rec.chain) : (r ?? { data: null, error: null });
    });
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, getUser: async () => h.user }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async (e: (typeof h.audits)[number]) => void h.audits.push(e) }));
vi.mock("@/lib/server/media", () => ({ mediaDir: () => null, mediaUrlSecret: () => null, withUrls: (a: unknown) => ({ ...(a as object), viewUrl: null, thumbUrl: null }) }));

const exportsRoute = await import("../app/api/editor/projects/[id]/exports/route");
const { loadEditorProject } = await import("../lib/server/editor");
const { EDITOR_EXPORT_COLUMNS, EDITOR_EXPORT_FRAME_COLUMNS } = await import("../lib/editor");

const req = (body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/editor/projects/${PID}/exports`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const params = (id: string = PID) => ({ params: Promise.resolve({ id }) });
const exportCalls = () => h.calls.filter((c) => c.kind === "rpc" && c.name === "request_editor_export");
const post = (body: unknown) => exportsRoute.POST(req(body), params());
const MISSING: Err = { code: "PGRST202", message: "Could not find the function public.request_editor_export(p_frame, p_project, p_rev) in the schema cache" };

/** The database with 0129: each call queues an export; ids count up in the order asked. */
function bothOverloads() {
  let n = 0;
  h.rpc.request_editor_export = () => ({ data: E(++n), error: null });
}
/** The database before 0129: the three-argument call is not found, the two-argument one works. */
function onlyThePlainOne() {
  let n = 0;
  h.rpc.request_editor_export = (args) => ("p_frame" in args ? { data: null, error: MISSING } : { data: E(++n), error: null });
}

beforeEach(() => {
  h.user = { id: "u1", email: "me@example.com" };
  h.rpc = { take_web_rate: { data: true, error: null } };
  h.table = {};
  h.calls = [];
  h.audits = [];
  vi.stubEnv("NIGHTSHIFT_MULTI_RATIO_EXPORT", "on");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("with the switch off, the route is what it was", () => {
  it.each([undefined, "", "0", "off", "false", "no", "enabled"])("NIGHTSHIFT_MULTI_RATIO_EXPORT=%s: `frames` is not read at all", async (value) => {
    if (value === undefined) vi.stubEnv("NIGHTSHIFT_MULTI_RATIO_EXPORT", "");
    else vi.stubEnv("NIGHTSHIFT_MULTI_RATIO_EXPORT", value);
    bothOverloads();
    // Even a `frames` the route would refuse when on (a size, an unknown id) changes nothing: the field is ignored, not checked.
    for (const frames of [["vertical_1080p", "square_1080"], ["8192x8192"], "nonsense", [{ width: 8192, height: 8192 }]]) {
      h.calls = [];
      h.audits = [];
      const res = await post({ rev: 3, frames });
      expect(res.status).toBe(201);
      expect(Object.keys(await res.json()).sort()).toEqual(["id", "status"]);
      expect(exportCalls()).toHaveLength(1);
      expect(exportCalls()[0].args).toEqual({ p_project: PID, p_rev: 3 });
      expect(h.audits).toHaveLength(1);
      expect(h.audits[0].detail).toEqual({ project: PID, rev: 3 });
    }
  });
});

describe("with the switch on", () => {
  it("a request without `frames` is the plain export, byte for byte", async () => {
    bothOverloads();
    const res = await post({ rev: 3 });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: E(1), status: "queued" });
    expect(exportCalls().map((c) => c.args)).toEqual([{ p_project: PID, p_rev: 3 }]);
    expect(h.audits).toEqual([{ action: "editor.export_request", target: E(1), detail: { project: PID, rev: 3 } }]);
  });

  it("only the project's own frame is the two-argument function and nothing else", async () => {
    bothOverloads();
    const res = await post({ rev: 3, frames: ["project"] });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ exports: [{ frame: "project", id: E(1), status: "queued" }] });
    expect(exportCalls().map((c) => c.args)).toEqual([{ p_project: PID, p_rev: 3 }]);
    expect(h.audits[0].detail).toEqual({ project: PID, rev: 3 });
  });

  it("asks for ONE export per size, by id only, the project's own frame first", async () => {
    bothOverloads();
    const res = await post({ rev: 3, frames: ["square_1080", "vertical_1080p", "project"] });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      exports: [
        { frame: "project", id: E(1), status: "queued" },
        { frame: "vertical_1080p", id: E(2), status: "queued" },
        { frame: "square_1080", id: E(3), status: "queued" },
      ],
    });
    // Exactly these arguments: no width, no height, no ratio, nothing else from the body.
    expect(exportCalls().map((c) => c.args)).toEqual([
      { p_project: PID, p_rev: 3 },
      { p_project: PID, p_rev: 3, p_frame: "vertical_1080p" },
      { p_project: PID, p_rev: 3, p_frame: "square_1080" },
    ]);
    // One audit line per export that was queued, each naming its size.
    expect(h.audits.map((a) => [a.action, a.target, a.detail])).toEqual([
      ["editor.export_request", E(1), { project: PID, rev: 3 }],
      ["editor.export_request", E(2), { project: PID, rev: 3, frame: "vertical_1080p" }],
      ["editor.export_request", E(3), { project: PID, rev: 3, frame: "square_1080" }],
    ]);
  });

  it("the project's own size and a format of that same size are refused together, before any export is asked", async () => {
    bothOverloads();
    h.table.editor_projects = { data: { width: 1920, height: 1080 }, error: null };
    for (const frames of [["project", "youtube_1080p"], ["youtube_1080p", "project"], ["project", "vertical_1080p", "youtube_1080p"]]) {
      h.calls = [];
      const res = await post({ rev: 3, frames });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
      expect(exportCalls()).toHaveLength(0);
      // The size is read under the caller's own session, the project's id pinned.
      const read = h.calls.find((c) => c.kind === "from" && c.name === "editor_projects")!;
      expect(read.chain).toEqual(expect.arrayContaining([{ m: "select", a: ["doc->width, doc->height"] }, { m: "eq", a: ["id", PID] }]));
    }
    expect(h.audits).toHaveLength(0);
  });

  it("a format of another size beside the project's own goes through, and a format alone is never compared", async () => {
    bothOverloads();
    h.table.editor_projects = { data: { width: 1920, height: 1080 }, error: null };
    expect((await post({ rev: 3, frames: ["project", "vertical_1080p"] })).status).toBe(201);
    h.calls = [];
    // Without "project" there is nothing to compare: no read, and youtube_1080p alone is one export like any other.
    expect((await post({ rev: 3, frames: ["youtube_1080p"] })).status).toBe(201);
    expect(h.calls.filter((c) => c.kind === "from" && c.name === "editor_projects")).toHaveLength(0);
  });

  it("when the project's size cannot be read the database decides (it refuses the same picture twice itself)", async () => {
    let n = 0;
    h.rpc.request_editor_export = (args) =>
      args.p_frame === "youtube_1080p" ? { data: null, error: { code: "NS409", message: "export_in_progress" } } : { data: E(++n), error: null };
    for (const read of [{ data: null, error: { code: "57014", message: "timeout" } }, { data: null, error: null }]) {
      h.table.editor_projects = read;
      const res = await post({ rev: 3, frames: ["project", "youtube_1080p"] });
      expect(res.status).toBe(201);
      expect((await res.json()).exports[1]).toEqual({ frame: "youtube_1080p", error: "export_in_progress" });
    }
  });

  it("nothing else in the body reaches the database", async () => {
    bothOverloads();
    await post({ rev: 3, frames: ["vertical_1080p"], width: 8192, height: 8192, fps: 240, doc: { width: 8192 }, p_frame: "8192x8192", frame: "9:16", credits: 0 });
    expect(exportCalls().map((c) => c.args)).toEqual([{ p_project: PID, p_rev: 3, p_frame: "vertical_1080p" }]);
  });

  it.each([
    [[]], [["vertical_4k"]], [["1080x1920"]], [["9:16"]], [[" vertical_1080p"]], [["VERTICAL_1080P"]], [[1080, 1920]],
    [[{ width: 1080, height: 1920 }]], [[{ preset: "vertical_1080p", width: 8192, height: 8192 }]], [[["vertical_1080p"]]],
    ["vertical_1080p"], [{ 0: "vertical_1080p" }], [null], [5], [true],
    [["project", "project"]], [["vertical_1080p", "vertical_1080p"]], [["project", "vertical_1080p", "nonsense"]],
    [["project", "youtube_720p", "vertical_1080p", "square_1080"]],
    [["vertical_1080p'; drop table editor_exports; --"]],
  ])("frames=%j is refused whole, before the database is asked", async (frames) => {
    bothOverloads();
    const res = await post({ rev: 3, frames });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
    expect(exportCalls()).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("the revision is still checked first", async () => {
    bothOverloads();
    for (const rev of [undefined, 0, -1, 1.5, "3", null]) {
      const res = await post({ rev, frames: ["vertical_1080p"] });
      expect(res.status).toBe(400);
    }
    expect(exportCalls()).toHaveLength(0);
  });

  it("answers size by size: a refused one does not hide the ones that were queued", async () => {
    let n = 0;
    h.rpc.request_editor_export = (args) =>
      args.p_frame === "square_1080"
        ? { data: null, error: { code: "NS409", message: "export_in_progress" } }
        : { data: E(++n), error: null };
    const res = await post({ rev: 3, frames: ["project", "vertical_1080p", "square_1080"] });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      exports: [
        { frame: "project", id: E(1), status: "queued" },
        { frame: "vertical_1080p", id: E(2), status: "queued" },
        { frame: "square_1080", error: "export_in_progress" },
      ],
    });
    expect(h.audits).toHaveLength(2);
  });

  it.each([
    ["NS429", "daily_limit", 429, "daily_limit"],
    ["NS409", "export_in_progress", 409, "export_in_progress"],
    ["NS409", "stale_revision", 409, "stale_revision"],
    ["NS400", "too_long", 400, "too_long"],
    ["NS400", "invalid_frame", 400, "bad_request"],
    ["P0002", "not_found", 404, "not_found"],
    ["42501", "forbidden", 403, "forbidden"],
  ])("when nothing was queued the first refusal decides: %s %s -> %i %s", async (code, message, status, word) => {
    h.rpc.request_editor_export = { data: null, error: { code, message } };
    const res = await post({ rev: 3, frames: ["vertical_1080p", "square_1080"] });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({
      error: word,
      exports: [{ frame: "vertical_1080p", error: word }, { frame: "square_1080", error: word }],
    });
    expect(h.audits).toHaveLength(0);
  });

  it("an answer that is not an export id is a failure, not a queued export", async () => {
    h.rpc.request_editor_export = { data: "not-a-uuid", error: null };
    const res = await post({ rev: 3, frames: ["vertical_1080p"] });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "failed", exports: [{ frame: "vertical_1080p", error: "failed" }] });
    expect(h.audits).toHaveLength(0);
  });
});

describe("before migration 0129 (the three-argument function does not exist)", () => {
  it("a size is answered not_available and is NEVER rendered in the project's frame instead", async () => {
    onlyThePlainOne();
    const res = await post({ rev: 3, frames: ["vertical_1080p", "square_1080"] });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "not_available",
      exports: [{ frame: "vertical_1080p", error: "not_available" }, { frame: "square_1080", error: "not_available" }],
    });
    // The only calls made were the two that named a frame: no plain export was asked in their place.
    expect(exportCalls().every((c) => "p_frame" in (c.args ?? {}))).toBe(true);
    expect(exportCalls()).toHaveLength(2);
    expect(h.audits).toHaveLength(0);
  });

  it("the project's own frame still goes through, beside the sizes that could not", async () => {
    onlyThePlainOne();
    const res = await post({ rev: 3, frames: ["vertical_1080p", "project"] });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      exports: [{ frame: "project", id: E(1), status: "queued" }, { frame: "vertical_1080p", error: "not_available" }],
    });
    expect(exportCalls().filter((c) => !("p_frame" in (c.args ?? {})))).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it("and a plain export is untouched", async () => {
    onlyThePlainOne();
    const res = await post({ rev: 3 });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: E(1), status: "queued" });
  });

  it.each([{ code: "42883", message: "function public.request_editor_export(uuid, integer, text) does not exist" }, MISSING])(
    "whichever way the database says the function is missing (%j)",
    async (error) => {
      h.rpc.request_editor_export = (args) => ("p_frame" in args ? { data: null, error } : { data: E(1), error: null });
      const res = await post({ rev: 3, frames: ["feed_4x5_1080"] });
      expect(res.status).toBe(503);
      expect((await res.json()).exports).toEqual([{ frame: "feed_4x5_1080", error: "not_available" }]);
    },
  );
});

describe("the gates in front of the database are the plain export's", () => {
  it("signed out, a bad project id and a foreign origin never reach it", async () => {
    bothOverloads();
    h.user = null;
    expect((await post({ rev: 3, frames: ["vertical_1080p"] })).status).toBe(401);
    h.user = { id: "u1", email: "me@example.com" };
    expect((await exportsRoute.POST(req({ rev: 3, frames: ["vertical_1080p"] }), params("../x"))).status).toBe(404);
    expect((await exportsRoute.POST(req({ rev: 3, frames: ["vertical_1080p"] }, { origin: "https://evil.example" }), params())).status).toBe(403);
    expect(exportCalls()).toHaveLength(0);
  });

  it("the per-person rate limit is asked once for the request, whatever the number of sizes", async () => {
    bothOverloads();
    await post({ rev: 3, frames: ["project", "vertical_1080p", "square_1080"] });
    expect(h.calls.filter((c) => c.kind === "rpc" && c.name === "take_web_rate")).toHaveLength(1);
    h.calls = [];
    h.rpc.take_web_rate = { data: false, error: null };
    const res = await post({ rev: 3, frames: ["vertical_1080p"] });
    expect(res.status).toBe(429);
    expect(exportCalls()).toHaveLength(0);
  });
});

describe("the editor's read of export rows", () => {
  const PROJECT_ROW = { id: PID, org_id: ORG, title: "Trip", rev: 2, doc: { version: 1, width: 1920, height: 1080, fps: 30, tracks: [] }, updated_at: "t" };
  const selected = () => h.calls.filter((c) => c.kind === "from" && c.name === "editor_exports").map((c) => c.chain.find((x) => x.m === "select")!.a[0]);

  it("with the switch off reads the columns it always read, and offers no sizes", async () => {
    vi.stubEnv("NIGHTSHIFT_MULTI_RATIO_EXPORT", "");
    h.table.editor_projects = { data: PROJECT_ROW, error: null };
    h.table.editor_exports = { data: [{ id: "e1", rev: 2, status: "done", frame_preset: "square_1080", frame_width: 1080, frame_height: 1080 }], error: null };
    const out = await loadEditorProject(PID);
    expect(out.state).toBe("ok");
    expect(selected()).toEqual([EDITOR_EXPORT_COLUMNS]);
    expect(EDITOR_EXPORT_COLUMNS).toBe("id, rev, status, reason, duration_s, asset_id, created_at, finished_at");
    if (out.state === "ok") expect(out.value.multiRatio).toBe(false);
  });

  it("with it on reads the frame too and says sizes are offered", async () => {
    h.table.editor_projects = { data: PROJECT_ROW, error: null };
    h.table.editor_exports = { data: [{ id: "e1", rev: 2, status: "queued", frame_preset: "vertical_1080p", frame_width: 1080, frame_height: 1920 }], error: null };
    const out = await loadEditorProject(PID);
    expect(selected()).toEqual([EDITOR_EXPORT_FRAME_COLUMNS]);
    expect(EDITOR_EXPORT_FRAME_COLUMNS).toBe(`${EDITOR_EXPORT_COLUMNS}, frame_preset, frame_width, frame_height`);
    expect(out.state).toBe("ok");
    if (out.state === "ok") {
      expect(out.value.multiRatio).toBe(true);
      expect(out.value.exports[0].frame).toEqual({ preset: "vertical_1080p", width: 1080, height: 1920 });
    }
  });

  it.each([
    { code: "42703", message: "column editor_exports.frame_preset does not exist" },
    { code: "PGRST204", message: "Could not find the 'frame_preset' column of 'editor_exports' in the schema cache" },
  ])("before 0129 (%j) falls back to the plain columns: the editor opens and offers the plain export only", async (error) => {
    h.table.editor_projects = { data: PROJECT_ROW, error: null };
    h.table.editor_exports = (chain) =>
      String(chain.find((x) => x.m === "select")!.a[0]).includes("frame_preset")
        ? { data: null, error }
        : { data: [{ id: "e1", rev: 2, status: "done", asset_id: null }], error: null };
    const out = await loadEditorProject(PID);
    expect(selected()).toEqual([EDITOR_EXPORT_FRAME_COLUMNS, EDITOR_EXPORT_COLUMNS]);
    expect(out.state).toBe("ok");
    if (out.state === "ok") {
      expect(out.value.multiRatio).toBe(false);
      expect(out.value.exports.map((e) => e.id)).toEqual(["e1"]);
    }
  });

  it("any other failure of that read is still a failed read, not a silent fallback", async () => {
    h.table.editor_projects = { data: PROJECT_ROW, error: null };
    h.table.editor_exports = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    expect((await loadEditorProject(PID)).state).toBe("read_failed");
    expect(selected()).toEqual([EDITOR_EXPORT_FRAME_COLUMNS]);
  });
});

describe("the sources", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  it.each(["app/api/editor/projects/[id]/exports/route.ts", "lib/multiRatioExport/frames.ts", "lib/multiRatioExport/flag.ts", "components/editor/ExportRatioPicker.tsx"])(
    "%s never holds the service key, credits or a publish path",
    (f) => {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const word of ["SERVICE_ROLE", "service_role", "reserve_credits", "capture_credits", "publish_request", "NEXT_PUBLIC_"]) expect(code).not.toContain(word);
    },
  );

  it("the route reads the switch on every request and the field only behind it", () => {
    const code = read("app/api/editor/projects/[id]/exports/route.ts");
    expect(code).toMatch(/multiRatioExportEnabled\(\) && body/);
    expect(code.match(/\.frames\b/g)).toHaveLength(1);
  });
});
