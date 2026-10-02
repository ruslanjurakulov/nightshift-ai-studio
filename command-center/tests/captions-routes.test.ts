import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/captions/tracks and /api/captions/tracks/<id> (migration 0072).
 *
 * What would break without these: a route reading with anything but the
 * member's own session (the service key skips the RLS policy that hides a
 * transcript until its job has completed and keeps another organization's
 * out); a malformed id reaching the database; a missing migration turning into
 * a 500 or an empty list that reads as "no transcripts"; a delete answering
 * differently for another organization's track than for a made-up one; and a
 * route that prices, holds or starts anything — reading and hiding a
 * transcript are free.
 */

vi.mock("server-only", () => ({}));

type Err = { code?: string; message?: string };
type Result = { data: unknown; error: Err | null };
const TRACK = "44444444-4444-4444-8444-444444444444";
const ASSET = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as { id: string; email: string } | null,
  rpc: {} as Record<string, Result>,
  table: {} as Record<string, Result>,
  calls: [] as { kind: string; name: string; args?: unknown; chain: { m: string; a: unknown[] }[] }[],
  audits: [] as { action: string; target?: string }[],
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
  rpc: (name: string, args: unknown) => {
    const rec = { kind: "rpc", name, args, chain: [] as { m: string; a: unknown[] }[] };
    h.calls.push(rec);
    return builder(rec, () => h.rpc[name] ?? { data: null, error: null });
  },
  from: (name: string) => {
    const rec = { kind: "from", name, chain: [] as { m: string; a: unknown[] }[] };
    h.calls.push(rec);
    return builder(rec, () => h.table[name] ?? { data: null, error: null });
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, getUser: async () => h.user }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async (e: { action: string; target?: string }) => void h.audits.push(e) }));

const list = await import("../app/api/captions/tracks/route");
const one = await import("../app/api/captions/tracks/[id]/route");

const ROW = { id: TRACK, language: "uz", duration_s: "95.000", word_count: 2, created_at: "2026-10-01T10:00:00Z", asset_id: ASSET };
const get = (url: string) => new Request(`http://x${url}`);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  h.user = { id: "u1", email: "me@example.com" };
  h.rpc = {};
  h.table = {};
  h.calls = [];
  h.audits = [];
});

describe("GET /api/captions/tracks?asset_id=", () => {
  it("is for signed-in members only", async () => {
    h.user = null;
    expect((await list.GET(get(`/api/captions/tracks?asset_id=${ASSET}`))).status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses an id that is not a uuid before reading anything", async () => {
    for (const bad of ["", "x", "../../etc/passwd", `${ASSET}' or 1=1`]) {
      expect((await list.GET(get(`/api/captions/tracks?asset_id=${encodeURIComponent(bad)}`))).status).toBe(400);
    }
    expect((await list.GET(get("/api/captions/tracks"))).status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("reads the summaries (never the words) of one recording, newest first, under the member's session", async () => {
    h.table.caption_tracks = { data: [ROW, { id: "bad" }], error: null };
    const res = await list.GET(get(`/api/captions/tracks?asset_id=${ASSET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tracks: [{ id: TRACK, language: "uz", durationS: 95, wordCount: 2, createdAt: "2026-10-01T10:00:00Z", assetId: ASSET }],
    });
    const [c] = h.calls;
    expect(c).toMatchObject({ kind: "from", name: "caption_tracks" });
    const select = c.chain.find((x) => x.m === "select")!.a[0] as string;
    expect(select).not.toContain("words");
    expect(c.chain.some((x) => x.m === "eq" && x.a[0] === "asset_id" && x.a[1] === ASSET)).toBe(true);
    expect(c.chain.some((x) => x.m === "order" && x.a[0] === "created_at")).toBe(true);
  });

  it("a missing table is 'not available', never an empty list; another failure is 502", async () => {
    h.table.caption_tracks = { data: null, error: { code: "42P01", message: 'relation "caption_tracks" does not exist' } };
    expect((await list.GET(get(`/api/captions/tracks?asset_id=${ASSET}`))).status).toBe(503);
    h.table.caption_tracks = { data: null, error: { code: "XX000", message: "boom" } };
    expect((await list.GET(get(`/api/captions/tracks?asset_id=${ASSET}`))).status).toBe(502);
  });
});

describe("GET /api/captions/tracks/<id>", () => {
  it("returns the track with its words", async () => {
    h.table.caption_tracks = { data: { ...ROW, words: [{ t: "Salom", s: 0, e: 1 }, { t: "dunyo", s: 1, e: 2 }] }, error: null };
    const res = await one.GET(get("/x"), ctx(TRACK));
    expect(res.status).toBe(200);
    expect((await res.json()).track.words).toHaveLength(2);
  });

  it("another organization's track, an unfinished job's and a made-up id are the same 404", async () => {
    h.table.caption_tracks = { data: null, error: null };
    const a = await one.GET(get("/x"), ctx(TRACK));
    const b = await one.GET(get("/x"), ctx("not-a-uuid"));
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(await a.json()).toEqual(await b.json());
  });

  it("needs a session", async () => {
    h.user = null;
    expect((await one.GET(get("/x"), ctx(TRACK))).status).toBe(401);
    expect((await one.DELETE(get("/x"), ctx(TRACK))).status).toBe(401);
  });
});

describe("DELETE /api/captions/tracks/<id>", () => {
  it("hides it through the database function and records who did", async () => {
    h.rpc.delete_caption_track = { data: true, error: null };
    const res = await one.DELETE(get("/x"), ctx(TRACK));
    expect(res.status).toBe(200);
    expect(h.calls[0]).toMatchObject({ kind: "rpc", name: "delete_caption_track", args: { p_track: TRACK } });
    expect(h.audits).toEqual([{ action: "captions.delete", target: TRACK }]);
  });

  it("another organization's track and a made-up one read alike; a member without the right is forbidden", async () => {
    h.rpc.delete_caption_track = { data: null, error: { code: "P0002", message: "not_found" } };
    expect((await one.DELETE(get("/x"), ctx(TRACK))).status).toBe(404);
    h.rpc.delete_caption_track = { data: null, error: { code: "42501", message: "forbidden" } };
    expect((await one.DELETE(get("/x"), ctx(TRACK))).status).toBe(403);
    h.rpc.delete_caption_track = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    expect((await one.DELETE(get("/x"), ctx(TRACK))).status).toBe(503);
    h.rpc.delete_caption_track = { data: null, error: { code: "XX000", message: "boom" } };
    expect((await one.DELETE(get("/x"), ctx(TRACK))).status).toBe(502);
    expect(h.audits).toEqual([]);
    expect((await one.DELETE(get("/x"), ctx("nope"))).status).toBe(404);
  });
});

describe("what the routes never do", () => {
  it("name the service key, price, hold or start a job", () => {
    for (const f of ["app/api/captions/tracks/route.ts", "app/api/captions/tracks/[id]/route.ts"]) {
      const src = readFileSync(join(__dirname, "..", f), "utf8");
      expect(src).not.toMatch(/SERVICE_KEY|service_role|serviceKey/i);
      expect(src).not.toMatch(/create_creative_job|quote_creative_job|reserve_credits|capture_credits/);
    }
  });
});
