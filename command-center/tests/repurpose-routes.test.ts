import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/videos/<id>/repurpose (migration 0080): the quote and the priced press.
 *
 * What would break without these: a route reading or pressing with anything
 * but the person's own session (the service key would skip every check the
 * database makes); a malformed id or clip reaching the database; a press that
 * carries a price, a window or a unit the browser chose; a press accepted on the
 * Actions backend (nothing there holds the master) and held for nobody; another
 * organization's video answering differently from a made-up one; a replayed
 * press audited twice; a database error leaking its words.
 */

vi.mock("server-only", () => ({}));

type Err = { code?: string; message?: string; details?: string | null };
type Result = { data: unknown; error: Err | null };
const VID = "run-0123456789abcdef0123";

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as { id: string; email: string } | null,
  rpc: {} as Record<string, Result>,
  table: {} as Record<string, Result>,
  calls: [] as { kind: string; name: string; args?: unknown }[],
  audits: [] as { action: string; target?: string; channelId?: string; detail?: Record<string, unknown> }[],
}));

function builder(result: () => Result): unknown {
  const q: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      return () => q;
    },
  });
  return q;
}

const client = {
  rpc: (name: string, args: unknown) => {
    h.calls.push({ kind: "rpc", name, args });
    return builder(() => h.rpc[name] ?? { data: null, error: null });
  },
  from: (name: string) => {
    h.calls.push({ kind: "from", name });
    return builder(() => h.table[name] ?? { data: null, error: null });
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, getUser: async () => h.user }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async (e: { action: string }) => void h.audits.push(e) }));

const route = await import("../app/api/videos/[id]/repurpose/route");

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string, qs = "clips=s000-s002,s004-s004") => route.GET(new Request(`http://x/api/videos/${id}/repurpose?${qs}`), ctx(id));
const post = (id: string, body: unknown, raw?: string) =>
  route.POST(new Request(`http://x/api/videos/${id}/repurpose`, { method: "POST", body: raw ?? JSON.stringify(body) }), ctx(id));

const CLIPS = [{ first: "s000", last: "s002" }, { first: "s004", last: "s004" }];
const GOOD = { clips: CLIPS, max_credits: 8, idempotency_key: "repurpose:abcdef12345" };
const PRICED = {
  status: "priced", credits: 8, clip_credits: 4, may_start: true,
  clips: [{ position: 1, first: "s000", last: "s002", scene_ids: ["s000", "s001", "s002"], start_s: 0, end_s: 33, duration_s: 33 }],
};

beforeEach(() => {
  h.user = { id: "u1", email: "me@example.com" };
  h.rpc = {};
  h.table = {};
  h.calls = [];
  h.audits = [];
  vi.stubEnv("NIGHTSHIFT_RUN_BACKEND", "queue");
});
afterEach(() => vi.unstubAllEnvs());

describe("GET — the quote", () => {
  it("is for signed-in people only", async () => {
    h.user = null;
    expect((await get(VID)).status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a bad video id or bad clips before anything is asked", async () => {
    expect((await get("../etc/passwd")).status).toBe(404);
    for (const qs of ["", "clips=", "clips=s000", "clips=s000-s002;s004-s005", `clips=${"s000-s001,".repeat(6)}`, "clips=x-y"]) {
      expect((await get(VID, qs)).status).toBe(400);
    }
    expect(h.calls).toHaveLength(0);
  });

  it("asks the database, with the person's own session, for exactly the pairs named", async () => {
    h.rpc.quote_repurpose = { data: PRICED, error: null };
    const res = await get(VID);
    expect(res.status).toBe(200);
    expect(h.calls).toEqual([{ kind: "rpc", name: "quote_repurpose", args: { p_video: VID, p_clips: CLIPS } }]);
    const body = await res.json();
    expect(body.queue).toBe(true);
    expect(body.quote).toMatchObject({ status: "priced", credits: 8, clipCredits: 4, mayStart: true });
  });

  it("says whether the queue backend is on, so the button can say it is not available", async () => {
    vi.stubEnv("NIGHTSHIFT_RUN_BACKEND", "actions");
    h.rpc.quote_repurpose = { data: PRICED, error: null };
    expect((await (await get(VID)).json()).queue).toBe(false);
  });

  it("reads another organization's video exactly as a video that does not exist", async () => {
    h.rpc.quote_repurpose = { data: null, error: { code: "42501", message: "forbidden" } };
    const res = await get(VID);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("an unset price is unpriced with no number; a missing migration is 503, not a price", async () => {
    h.rpc.quote_repurpose = { data: { status: "unpriced", credits: null, may_start: true, clips: [] }, error: null };
    expect((await (await get(VID)).json()).quote).toMatchObject({ status: "unpriced", credits: null });
    h.rpc.quote_repurpose = { data: null, error: { code: "42883", message: "function public.quote_repurpose does not exist" } };
    const res = await get(VID);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "repurpose_unavailable" });
  });
});

describe("POST — the press", () => {
  it("is for signed-in people only", async () => {
    h.user = null;
    expect((await post(VID, GOOD)).status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses malformed requests before anything is held", async () => {
    expect((await post("../x", GOOD)).status).toBe(404);
    expect((await post(VID, null, "not json")).status).toBe(400);
    expect((await post(VID, null, "[1]")).status).toBe(400);
    expect((await post(VID, { ...GOOD, idempotency_key: "short" })).status).toBe(400);
    expect((await post(VID, { ...GOOD, max_credits: -1 })).status).toBe(400);
    expect((await post(VID, { ...GOOD, max_credits: "8" })).status).toBe(400);
    for (const clips of [[], "x", [{ first: "s000" }], Array(6).fill(CLIPS[0]), [{ first: "../", last: "s001" }]]) {
      const res = await post(VID, { ...GOOD, clips });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_clips" });
    }
    expect(h.calls).toHaveLength(0);
  });

  it("is refused on the Actions backend, before anything is held", async () => {
    for (const backend of ["actions", "", "QUEUE-ish"]) {
      vi.stubEnv("NIGHTSHIFT_RUN_BACKEND", backend);
      const res = await post(VID, GOOD);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "queue_required" });
    }
    expect(h.calls).toHaveLength(0);
  });

  it("sends the database only the pairs, the confirmed price and the key — never a window, a unit or a price of its own", async () => {
    h.rpc.request_repurpose = { data: { id: "r1", status: "queued", clip_count: 2, credits_held: "8.00", replayed: false }, error: null };
    h.table.videos = { data: { channel_id: "news" }, error: null };
    const res = await post(VID, { ...GOOD, clips: [{ first: "s000", last: "s002", start_s: 1, end_s: 999, price: 0, unit: "x" }], price: 0 });
    expect(res.status).toBe(200);
    expect(h.calls[0]).toEqual({
      kind: "rpc", name: "request_repurpose",
      args: { p_video: VID, p_clips: [{ first: "s000", last: "s002" }], p_max_credits: 8, p_idem: "repurpose:abcdef12345" },
    });
    expect(await res.json()).toEqual({ ok: true, id: "r1", status: "queued", clip_count: 2, credits_reserved: 8, replayed: false });
  });

  it("audits a new press once, with names and counts only, under the video's own channel", async () => {
    h.rpc.request_repurpose = { data: { id: "r1", status: "queued", clip_count: 2, credits_held: 8, replayed: false }, error: null };
    h.table.videos = { data: { channel_id: "news" }, error: null };
    await post(VID, GOOD);
    expect(h.audits).toEqual([
      { channelId: "news", action: "video.repurpose", target: VID, detail: { clip_count: 2, request_id: "r1", credits_reserved: 8 } },
    ]);
  });

  it("a replayed press is the same request and is not audited again", async () => {
    h.rpc.request_repurpose = { data: { id: "r1", status: "queued", clip_count: 2, credits_held: 8, replayed: true }, error: null };
    const res = await post(VID, GOOD);
    expect((await res.json()).replayed).toBe(true);
    expect(h.audits).toHaveLength(0);
  });

  it("the operator's own organization is included: no credits are reported", async () => {
    h.rpc.request_repurpose = { data: { id: "r1", status: "queued", clip_count: 1, credits_held: null, replayed: false }, error: null };
    h.table.videos = { data: { channel_id: "default" }, error: null };
    const res = await post(VID, { ...GOOD, max_credits: null });
    expect((await res.json()).credits_reserved).toBeNull();
    expect(h.calls[0]).toMatchObject({ args: { p_max_credits: null } });
    expect(h.audits[0].detail).not.toHaveProperty("credits_reserved");
  });

  const refusals: Array<[string, Err, number, Record<string, unknown>]> = [
    ["not an admin here / no such video", { code: "42501", message: "forbidden" }, 403, { error: "forbidden" }],
    ["insufficient credits", { code: "NS402", message: "insufficient credits", details: "available=3 needed=8" }, 402, { error: "insufficient_credits", needed: 8, available: 3 }],
    ["a changed price", { code: "NS409", message: "price_changed", details: "credits=9" }, 409, { error: "price_changed", credits: 9 }],
    ["a press already running", { code: "NS409", message: "in_progress" }, 409, { error: "in_progress" }],
    ["a reused key", { code: "NS409", message: "idempotency_conflict" }, 409, { error: "idempotency_conflict" }],
    ["an unset price", { code: "NS400", message: "unpriced" }, 409, { error: "unpriced" }],
    ["a master that cannot be cut", { code: "NS400", message: "clips_unavailable", details: "gate_blocked" }, 409, { error: "clips_unavailable", reason: "gate_blocked" }],
    ["no price confirmed", { code: "22023", message: "price_required", details: "credits=8" }, 409, { error: "price_required", credits: 8 }],
  ];
  for (const [name, error, status, body] of refusals) {
    it(`maps ${name}`, async () => {
      h.rpc.request_repurpose = { data: null, error };
      const res = await post(VID, GOOD);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
      expect(h.audits).toHaveLength(0);
    });
  }

  it("never leaks the database's own words", async () => {
    h.rpc.request_repurpose = { data: null, error: { code: "XX000", message: "relation \"secret\" at /var/db exploded" } };
    const res = await post(VID, GOOD);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret|\/var/);
  });
});

describe("the route's source", () => {
  const src = readFileSync(join(__dirname, "..", "app", "api", "videos", "[id]", "repurpose", "route.ts"), "utf-8");

  it("uses the signed-in session only: no service key, no admin client", () => {
    expect(src).not.toMatch(/SERVICE_KEY|service_role|createAdminClient|getServiceClient|supabase-js/i);
    expect(src).toContain('from "@/lib/supabase/server"');
  });

  it("calls exactly the two browser functions", () => {
    expect([...src.matchAll(/\.rpc\("(\w+)"/g)].map((m) => m[1]).sort()).toEqual(["quote_repurpose", "request_repurpose"]);
  });
});
