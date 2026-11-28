/**
 * GET /api/films/[id]/live with 0246 (take and assembly progress) and 0248 (typical take durations). What would break without
 * these: the new columns read with anything but the person's own session; a database without 0246 or 0248 turning the whole
 * answer into an error instead of the shape before them; an unknown percent arriving as 0 or a figure outside 0..100 shown at
 * all; a vendor word that is not a word (an error text, an id) passed to the view; a median without n.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ user: vi.fn(), client: vi.fn(), admin: vi.fn(), org: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getUser: h.user, createClient: h.client }));
vi.mock("@/lib/auth/org-roles", () => ({ isPlatformAdmin: h.admin }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: h.org }));

const { filmJson, FILM, ORG, withOrgSwitch } = await import("./films-fixtures");
const live = await import("../app/api/films/[id]/live/route");
const { coerceFilmLive } = await import("../lib/studio/liveGraph");

const req = () => new Request(`https://app.test/api/films/${FILM}/live`);
const params = { params: Promise.resolve({ id: FILM }) };

/** A PostgREST builder that answers by the select list: `refuse` lists the columns whose presence makes it a 42703. */
function table(rows: unknown[], refuse: string[], seen: string[]) {
  return {
    select(cols: string) {
      seen.push(cols);
      const answer = refuse.some((c) => cols.split(",").includes(c))
        ? { data: null, error: { code: "42703", message: "column does not exist" } }
        : { data: rows.map((r) => Object.fromEntries(cols.split(",").filter((c) => c in (r as object)).map((c) => [c, (r as Record<string, unknown>)[c]]))), error: null };
      const chain = {
        eq: () => chain,
        order: () => chain,
        limit: async () => answer,
      };
      return chain;
    },
  };
}

let segCols: string[];
let takeCols: string[];
function setup({ refuse = [] as string[], typical = { data: [] as unknown, error: null as unknown } } = {}) {
  segCols = [];
  takeCols = [];
  const segRows = [{ id: "s1", status: "running", assembly_status: "running", assembly_progress: 42.5, assembly_progress_at: "2026-11-28T10:00:00Z" }];
  const takeRows = [
    { id: "t1", error_code: null, progress: 37.25, vendor_state: "running", progress_at: "2026-11-28T10:00:00Z" },
    { id: "t2", error_code: null, progress: null, vendor_state: null, progress_at: null },
    { id: "t3", error_code: null, progress: 140, vendor_state: "Task failed: key sk-123", progress_at: null },
  ];
  h.rpc.mockReset().mockImplementation(async (name: string) => (name === "film_take_typical_seconds" ? typical : { data: filmJson(), error: null }));
  h.from.mockReset().mockImplementation((t: string) =>
    t === "film_segments" ? table(segRows, refuse, segCols) : t === "film_takes" ? table(takeRows, refuse, takeCols) : table([], [], []),
  );
  h.client.mockReset().mockResolvedValue({ rpc: h.rpc, from: withOrgSwitch((t) => h.from(t)) });
}

beforeEach(() => {
  vi.stubEnv("NIGHTSHIFT_FILM_STUDIO", "on");
  h.user.mockReset().mockResolvedValue({ id: "u1" });
  h.admin.mockReset().mockResolvedValue(false);
  h.org.mockReset().mockResolvedValue({ supported: true, orgs: [], current: { id: ORG, role: "editor" } });
});

describe("the live answer carries 0246 and 0248, read through the person's own session", () => {
  it("returns the progress columns and the medians, and asks 0248 for this film only", async () => {
    setup({ typical: { data: [{ model: "vid-clip", capability: "i2v", median_s: 92.5, n: 4 }], error: null } });
    const r = await live.GET(req(), params);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(segCols[0]).toContain("assembly_progress,assembly_progress_at");
    expect(takeCols[0]).toContain("progress,vendor_state,progress_at");
    expect(body.typical).toEqual([{ model: "vid-clip", capability: "i2v", median_s: 92.5, n: 4 }]);
    expect(h.rpc).toHaveBeenCalledWith("film_take_typical_seconds", { p_film: FILM });
    // The session client is the only client: there is no service client in this route at all.
    expect(h.client).toHaveBeenCalled();
    const view = coerceFilmLive(body)!;
    expect(view.segments![0].assemblyProgress).toBe(42.5);
    expect(view.progress!.get("t1")).toEqual({ progress: 37.25, vendorState: "running", at: "2026-11-28T10:00:00Z" });
    // Unknown is null, never 0.
    expect(view.progress!.get("t2")).toEqual({ progress: null, vendorState: null, at: null });
    // Out of range is dropped, never clamped; a "word" that is free text is dropped.
    expect(view.progress!.get("t3")).toEqual({ progress: null, vendorState: null, at: null });
    expect(view.typical).toEqual([{ model: "vid-clip", capability: "i2v", medianS: 92.5, n: 4 }]);
  });

  it("a database without 0246 answers the shapes before it: progress then reads not known, never an error", async () => {
    setup({ refuse: ["progress", "assembly_progress"], typical: { data: null, error: { code: "PGRST202", message: "no function" } } });
    const r = await live.GET(req(), params);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(segCols).toHaveLength(2);
    expect(Array.isArray(body.segments)).toBe(true);
    expect(Array.isArray(body.takes)).toBe(true);
    expect(body.typical).toBeNull();
    const view = coerceFilmLive(body)!;
    expect(view.progress).toBeNull();
    expect(view.typical).toBeNull();
    expect(view.segments![0].assemblyProgress).toBeNull();
  });

  it("a median row with no n, no model or a duration that is not positive is left out", () => {
    const base = { film: filmJson(), segments: [], takes: [] };
    const view = coerceFilmLive({
      ...base,
      typical: [
        { model: "a", capability: "i2v", median_s: 10, n: 3 },
        { model: "b", capability: "i2v", median_s: 10 },
        { capability: "i2v", median_s: 10, n: 5 },
        { model: "c", capability: "t2i", median_s: 0, n: 5 },
        { model: "d", capability: "t2i", median_s: 8, n: 2.5 },
      ],
    })!;
    expect(view.typical).toEqual([{ model: "a", capability: "i2v", medianS: 10, n: 3 }]);
  });
});
