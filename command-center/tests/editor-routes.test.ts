import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/editor/projects, /api/editor/projects/<id> and …/<id>/exports
 * (migration 0054).
 *
 * What would break without these: a document the renderer would refuse (a
 * speed of 3, a clip past its own end, a 600-character title card) reaching the
 * database; a new project built from another organization's video; a refusal
 * turning into a 500 or a fake success; an export request that carries
 * anything but the revision (the database copies the SAVED document); and a
 * route reaching for the service key, which would skip every RLS policy and
 * same-org check 0054 has. Nothing here may price, hold or charge credits.
 *
 * The database is faked at the edges the routes touch: the session, the org
 * context, rpc() and the table builder. Every call is recorded.
 */

vi.mock("server-only", () => ({}));

type Err = { code?: string; message?: string };
type Result = { data: unknown; error: Err | null };
const ORG = "0a000000-0000-4000-8000-00000000000a";
const PID = "0b000000-0000-4000-8000-00000000000b";
const VID = "0c000000-0000-4000-8000-00000000000c";

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
      return typeof r === "function" ? r(rec.chain) : (r ?? { data: null, error: null });
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

const projects = await import("../app/api/editor/projects/route");
const project = await import("../app/api/editor/projects/[id]/route");
const exportsRoute = await import("../app/api/editor/projects/[id]/exports/route");

const VIDEO_ROW = {
  id: VID,
  kind: "video",
  mime: "video/mp4",
  bytes: 1000,
  width: 1280,
  height: 720,
  duration_s: "12.5",
  source: "upload",
  original_name: "beach.mp4",
  variants: ["thumb", "proxy"],
  version: 1,
  created_at: "2026-10-01T00:00:00Z",
};

function goodDoc(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    tracks: [
      { id: "v1", kind: "V", clips: [{ id: "c1", asset_id: VID, start_s: 0, in_s: 1, out_s: 9, speed: 2, audio: true, ...over }] },
      { id: "t1", kind: "T", clips: [{ id: "x1", start_s: 0, end_s: 2, text: "Hi" }] },
    ],
  };
}

const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/editor/projects", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const rpcCalls = (name?: string) => h.calls.filter((c) => c.kind === "rpc" && (!name || c.name === name));

beforeEach(() => {
  h.user = { id: "u1", email: "me@example.com" };
  h.current = { id: ORG };
  h.rpc = {};
  h.table = {};
  h.calls = [];
  h.audits = [];
});

describe("POST /api/editor/projects", () => {
  it("builds the first document from the org's own video and stores it through create_editor_project", async () => {
    h.table.media_assets = { data: VIDEO_ROW, error: null };
    h.rpc.create_editor_project = { data: PID, error: null };
    const res = await projects.POST(req("POST", { title: "  Beach  day ", asset_id: VID }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: PID });
    const read = h.calls.find((c) => c.kind === "from" && c.name === "media_assets")!;
    expect(read.chain).toEqual(
      expect.arrayContaining([
        { m: "eq", a: ["id", VID] },
        { m: "eq", a: ["org_id", ORG] },
        { m: "is", a: ["deleted_at", null] },
      ]),
    );
    const [call] = rpcCalls("create_editor_project");
    const args = call.args as { p_org: string; p_title: string; p_doc: { tracks: { clips: unknown[] }[]; width: number } };
    expect(args.p_org).toBe(ORG);
    expect(args.p_title).toBe("Beach day");
    expect(args.p_doc.width).toBe(1920);
    expect(args.p_doc.tracks[0].clips[0]).toEqual({ id: "c1", asset_id: VID, start_s: 0, in_s: 0, out_s: 12.5, speed: 1, audio: true });
    expect(h.audits).toHaveLength(1);
  });

  it("another organization's video (RLS returns no row) reads like a made-up one", async () => {
    h.table.media_assets = { data: null, error: null };
    const res = await projects.POST(req("POST", { title: "x", asset_id: VID }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_asset" });
    expect(rpcCalls()).toHaveLength(0);
  });

  it("refuses a bad body before the database, and needs a session", async () => {
    for (const body of [{ title: "", asset_id: VID }, { title: "x", asset_id: "../etc" }, "not json", [1]]) {
      const res = await projects.POST(req("POST", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    h.user = null;
    expect((await projects.POST(req("POST", { title: "x", asset_id: VID }))).status).toBe(401);
    expect(rpcCalls()).toHaveLength(0);
  });

  it("maps the database's limit", async () => {
    h.table.media_assets = { data: VIDEO_ROW, error: null };
    h.rpc.create_editor_project = { data: null, error: { code: "NS429", message: "limit_reached" } };
    const res = await projects.POST(req("POST", { title: "x", asset_id: VID }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "limit_reached" });
  });
});

describe("PUT /api/editor/projects/<id>", () => {
  const MUS = "0e000000-0000-4000-8000-00000000000e";
  const PIC = "0f000000-0000-4000-8000-00000000000f";
  beforeEach(() => {
    // What the member's own session can read of the files the document names.
    h.table.media_assets = {
      data: [
        { id: VID, kind: "video" },
        { id: MUS, kind: "audio" },
        { id: PIC, kind: "image" },
      ],
      error: null,
    };
  });
  const withSound = (asset: string) => {
    const doc = goodDoc();
    (doc.tracks as unknown[]).splice(1, 0, {
      id: "a1",
      kind: "A",
      clips: [{ id: "m1", asset_id: asset, start_s: 0, in_s: 0, out_s: 3, gain_db: -6, fade_in_s: 1, fade_out_s: 1 }],
    });
    return doc;
  };

  it("sends music on its own track to the database", async () => {
    h.rpc.save_editor_project = { data: 2, error: null };
    const res = await project.PUT(req("PUT", { base_rev: 1, doc: withSound(MUS) }), params(PID));
    expect(res.status).toBe(200);
    const read = h.calls.find((c) => c.kind === "from" && c.name === "media_assets")!;
    // Read under the member's session (RLS), for exactly the document's files.
    expect(read.chain.find((c) => c.m === "in")?.a).toEqual(["id", [VID, MUS]]);
    expect(rpcCalls("save_editor_project")).toHaveLength(1);
  });

  it.each([
    ["a video on the music track", VID, "invalid_doc"],
    ["an image on the music track", PIC, "invalid_doc"],
    // Another organization's file reads like a made-up one: not there.
    ["a file this member cannot read", "0d000000-0000-4000-8000-0000000000aa", "invalid_asset"],
  ])("refuses %s before the database", async (_name, asset, word) => {
    const res = await project.PUT(req("PUT", { base_rev: 1, doc: withSound(asset) }), params(PID));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(word);
    expect(rpcCalls()).toHaveLength(0);
  });

  it("refuses a sound on the picture track, and fails closed when files cannot be read", async () => {
    const res = await project.PUT(req("PUT", { base_rev: 1, doc: goodDoc({ asset_id: MUS }) }), params(PID));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_doc");
    h.table.media_assets = { data: null, error: { code: "57014", message: "timeout" } };
    const down = await project.PUT(req("PUT", { base_rev: 1, doc: goodDoc() }), params(PID));
    expect(down.status).toBe(502);
    expect(rpcCalls()).toHaveLength(0);
  });

  it("sends a valid document with its base revision", async () => {
    h.rpc.save_editor_project = { data: 4, error: null };
    const res = await project.PUT(req("PUT", { base_rev: 3, title: null, doc: goodDoc() }), params(PID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: PID, rev: 4 });
    expect(rpcCalls("save_editor_project")[0].args).toEqual({ p_project: PID, p_base_rev: 3, p_title: null, p_doc: goodDoc() });
  });

  it.each([
    ["speed 3", goodDoc({ speed: 3 })],
    ["speed 0.25", goodDoc({ speed: 0.25 })],
    ["out before in", goodDoc({ in_s: 9, out_s: 1 })],
    ["a path smuggled in", goodDoc({ path: "/etc/passwd" })],
    ["audio as text", goodDoc({ audio: "yes" })],
    ["not a document", { tracks: "x" }],
  ])("refuses %s before the database", async (_name, doc) => {
    const res = await project.PUT(req("PUT", { base_rev: 1, doc }), params(PID));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_doc");
    expect(rpcCalls()).toHaveLength(0);
  });

  it("refuses text the renderer would refuse", async () => {
    const doc = goodDoc();
    (doc.tracks[1].clips[0] as { text: string }).text = "x".repeat(501);
    const res = await project.PUT(req("PUT", { base_rev: 1, doc }), params(PID));
    expect(res.status).toBe(400);
    expect(rpcCalls()).toHaveLength(0);
  });

  it("refuses an oversized body by its declared length and its real size", async () => {
    const big = await project.PUT(req("PUT", { base_rev: 1, doc: goodDoc() }, { "content-length": "999999999" }), params(PID));
    expect(big.status).toBe(413);
    const doc = goodDoc();
    (doc as Record<string, unknown>).captions = { cues: Array.from({ length: 3000 }, (_, i) => ({ id: `k${i}`, start_s: i, end_s: i + 0.5, text: "x".repeat(80) })) };
    const real = await project.PUT(req("PUT", { base_rev: 1, doc }), params(PID));
    expect(real.status).toBe(413);
    expect(rpcCalls()).toHaveLength(0);
  });

  it("maps a stale revision and another org's project", async () => {
    h.rpc.save_editor_project = { data: null, error: { code: "NS409", message: "stale_revision" } };
    let res = await project.PUT(req("PUT", { base_rev: 1, doc: goodDoc() }), params(PID));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale_revision" });
    h.rpc.save_editor_project = { data: null, error: { code: "P0002", message: "not_found" } };
    res = await project.PUT(req("PUT", { base_rev: 1, doc: goodDoc() }), params(PID));
    expect(res.status).toBe(404);
  });

  it("needs a whole-number base revision and a uuid", async () => {
    expect((await project.PUT(req("PUT", { base_rev: "1", doc: goodDoc() }), params(PID))).status).toBe(400);
    expect((await project.PUT(req("PUT", { base_rev: 0, doc: goodDoc() }), params(PID))).status).toBe(400);
    expect((await project.PUT(req("PUT", { base_rev: 1, doc: goodDoc() }), params("../x"))).status).toBe(404);
    expect(rpcCalls()).toHaveLength(0);
  });
});

describe("POST /api/editor/projects/<id>/exports", () => {
  it("asks for a render of the saved revision and nothing else", async () => {
    h.rpc.request_editor_export = { data: "0d000000-0000-4000-8000-00000000000d", error: null };
    const res = await exportsRoute.POST(req("POST", { rev: 3, doc: goodDoc(), credits: 0 }), params(PID));
    expect(res.status).toBe(201);
    expect(rpcCalls()).toHaveLength(1);
    expect(rpcCalls("request_editor_export")[0].args).toEqual({ p_project: PID, p_rev: 3 });
  });

  it("maps the free-export limits", async () => {
    for (const [code, message, status] of [
      ["NS409", "export_in_progress", 409],
      ["NS429", "daily_limit", 429],
      ["NS400", "too_long", 400],
      ["NS409", "stale_revision", 409],
    ] as const) {
      h.rpc.request_editor_export = { data: null, error: { code, message } };
      const res = await exportsRoute.POST(req("POST", { rev: 1 }), params(PID));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: message });
    }
  });
});

describe("the routes' sources", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  const files = [
    "app/api/editor/projects/route.ts",
    "app/api/editor/projects/[id]/route.ts",
    "app/api/editor/projects/[id]/exports/route.ts",
    "lib/server/editor.ts",
    "components/editor/TimelineEditor.tsx",
    "components/editor/editorApi.ts",
  ];

  it.each(files)("%s never holds the service key, credits or a publish path", (f) => {
    const src = read(f);
    expect(src).not.toMatch(/SERVICE_KEY|service_role|createServiceClient/);
    expect(src).not.toMatch(/reserve_credits|capture_credits|credit_prices|publish_requests|review_intents/);
  });

  it("the migration charges nothing and publishes nothing", () => {
    const sql = read("../supabase/migrations/0054_editor_projects.sql")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/credit_reservations|credit_transactions|reserve_credits|publish_requests|review_intents|videos\b/);
    expect(sql).toMatch(/grant execute on function public\.claim_editor_export\(text\) to service_role;/);
    expect(sql).not.toMatch(/grant execute on function public\.(claim_editor_export|finish_editor_export|editor_export_assets)[^;]*to authenticated/);
  });
});
