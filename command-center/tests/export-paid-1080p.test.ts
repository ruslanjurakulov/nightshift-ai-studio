import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Exports up to 1080p sold by the started minute (migration 0136), the routes and the quote's shape.
 *
 * What would break without these: a free size quoted as a price (or a sold one as free); the project's own frame or a free
 * size with a confirmed number sent to the free functions (they hold nothing), or one WITHOUT a number sent to the paid one;
 * a number that is not one passed on; the paid overload reached while NIGHTSHIFT_HIRES_EXPORT is off; and the database's
 * export_needs_quote without its word.
 */

vi.mock("server-only", () => ({}));

type Err = { code?: string; message?: string };
type Result = { data: unknown; error: Err | null };
const PID = "0b000000-0000-4000-8000-00000000000b";
const E = (n: number) => `0d000000-0000-4000-8000-00000000000${n}`;

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as { id: string; email: string } | null,
  rpc: {} as Record<string, Result | ((args: Record<string, unknown>) => Result)>,
  calls: [] as { name: string; args: Record<string, unknown> }[],
}));

const client = {
  rpc: (name: string, args: Record<string, unknown>) => {
    h.calls.push({ name, args });
    const r = h.rpc[name];
    return Promise.resolve(typeof r === "function" ? r(args) : (r ?? { data: null, error: null }));
  },
  from: () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "maybeSingle"]) q[m] = () => q;
    (q as { then: unknown }).then = (res: (v: Result) => unknown) => Promise.resolve({ data: { width: 1920, height: 1080 }, error: null }).then(res);
    return q;
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, getUser: async () => h.user }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => undefined }));
vi.mock("@/lib/server/editor-guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/editor-guard")>()),
  editorRateLimited: async () => null,
}));

const exportsRoute = await import("../app/api/editor/projects/[id]/exports/route");
const quoteRoute = await import("../app/api/editor/projects/[id]/exports/quote/route");
const { parseExportQuote, isQuotableFrame } = await import("../lib/hiresExport/limits");
const { mapEditorError } = await import("../lib/editor");

const ctx = { params: Promise.resolve({ id: PID }) };
const post = (body: unknown) =>
  exportsRoute.POST(
    new Request(`http://localhost/api/editor/projects/${PID}/exports`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify(body),
    }),
    ctx,
  );
const getQuote = (qs: string) => quoteRoute.GET(new Request(`http://localhost/api/editor/projects/${PID}/exports/quote?${qs}`), ctx);

const SOLD = (frame: string) => ({
  paid: true, tier: "1080p", max_s: 1800, max_fps: 60, fps: 30, too_fast: false, minutes: 1, credits_per_minute: 1, credits: 1, hold: 30,
  speed_curve: false, curve_sold: true, frame, width: 1920, height: 1080, duration_s: 6, too_long: false, on_sale: true, may_pay: true, exempt: false,
  available: 100,
});

beforeEach(() => {
  h.user = { id: "u1", email: "me@example.com" };
  h.rpc = {};
  h.calls = [];
  vi.stubEnv("NIGHTSHIFT_MULTI_RATIO_EXPORT", "on");
  vi.stubEnv("NIGHTSHIFT_HIRES_EXPORT", "on");
});
afterEach(() => vi.unstubAllEnvs());

describe("the quote of a size up to 1080p", () => {
  it("is free while the price is NULL, and said with no number", async () => {
    for (const frame of ["project", "square_1080", "youtube_1080p"]) {
      h.rpc.quote_editor_export = { data: { frame, width: 1920, height: 1080, paid: false, duration_s: 6 }, error: null };
      const res = await getQuote(`rev=1&frame=${frame}`);
      expect([res.status, await res.json()], frame).toEqual([200, { free: true, frame }]);
    }
  });

  it("is the paid tiers' quote once it is sold: 1 charged, 30 held", async () => {
    h.rpc.quote_editor_export = { data: SOLD("project"), error: null };
    const res = await getQuote("rev=1&frame=project");
    const body = await res.json();
    expect(body.quote).toMatchObject({ frame: "project", tier: "1080p", credits: 1, hold: 30, minutes: 1 });
    expect(h.calls).toEqual([{ name: "quote_editor_export", args: { p_project: PID, p_rev: 1, p_frame: "project" } }]);
  });

  it("is failed when the database answers for another frame, or a paid size as free", async () => {
    h.rpc.quote_editor_export = { data: { frame: "square_1080", paid: false }, error: null };
    expect((await getQuote("rev=1&frame=project")).status).toBe(502);
    h.rpc.quote_editor_export = { data: SOLD("square_1080"), error: null };
    expect((await getQuote("rev=1&frame=project")).status).toBe(502);
    // Parsed the same way in the browser: free only for a size up to 1080p; a sold one never a paid tier, a paid one never 1080p.
    expect(parseExportQuote({ free: true, frame: "youtube_2160p" }, "youtube_2160p")).toBeNull();
    expect(parseExportQuote({ free: true, frame: "project" }, "project")).toEqual({ free: true, frame: "project" });
    expect(parseExportQuote({ quote: { ...SOLD("square_1080"), tier: "1440p" } }, "square_1080")).toBeNull();
    expect(parseExportQuote({ quote: { ...SOLD("youtube_2160p"), tier: "1080p" } }, "youtube_2160p")).toBeNull();
    expect(parseExportQuote({ quote: SOLD("square_1080") }, "square_1080")).toMatchObject({ free: false, quote: { credits: 1, hold: 30 } });
    for (const v of ["project", "square_1080", "youtube_1440p"]) expect(isQuotableFrame(v)).toBe(true);
    for (const v of ["PROJECT", "own", "3840x2160", "", null]) expect(isQuotableFrame(v)).toBe(false);
  });
});

describe("POST .../exports while sizes up to 1080p are sold", () => {
  it("sends a size with a confirmed number to the four-argument function, the project's own as 'project'", async () => {
    let n = 0;
    h.rpc.request_editor_export = () => ({ data: E(++n), error: null });
    const res = await post({ rev: 3, frames: ["project", "square_1080"], maxCredits: { project: 1, square_1080: 1 } });
    expect(res.status).toBe(201);
    expect(h.calls.map((c) => c.args)).toEqual([
      { p_project: PID, p_rev: 3, p_frame: "project", p_max_credits: 1 },
      { p_project: PID, p_rev: 3, p_frame: "square_1080", p_max_credits: 1 },
    ]);
  });

  it("sends a size without a number to the free function, as always, and passes its refusal on with its word", async () => {
    h.rpc.request_editor_export = { data: null, error: { code: "NS409", message: "export_needs_quote" } };
    const res = await post({ rev: 3, frames: ["project", "square_1080"] });
    const body = await res.json();
    expect(h.calls.map((c) => c.args)).toEqual([{ p_project: PID, p_rev: 3 }, { p_project: PID, p_rev: 3, p_frame: "square_1080" }]);
    expect([res.status, body.error]).toEqual([409, "export_needs_quote"]);
    expect(mapEditorError({ code: "NS409", message: "export_needs_quote" })).toEqual({ error: "export_needs_quote", status: 409 });
  });

  it("refuses a number that is not one, for any size, before the database", async () => {
    for (const maxCredits of [{ project: "1" }, { square_1080: -1 }, { project: null }, { square_1080: Number.NaN }, { project: 1e9 }]) {
      const res = await post({ rev: 3, frames: ["project", "square_1080"], maxCredits });
      expect([res.status, (await res.json()).error], JSON.stringify(maxCredits)).toEqual([400, "quote_required"]);
    }
    expect(h.calls).toEqual([]);
  });

  it("ignores confirmed numbers while NIGHTSHIFT_HIRES_EXPORT is off: the free calls it always made", async () => {
    vi.stubEnv("NIGHTSHIFT_HIRES_EXPORT", "");
    h.rpc.request_editor_export = { data: E(1), error: null };
    await post({ rev: 3, frames: ["project", "square_1080"], maxCredits: { project: 1, square_1080: 1 } });
    expect(h.calls.map((c) => c.args)).toEqual([{ p_project: PID, p_rev: 3 }, { p_project: PID, p_rev: 3, p_frame: "square_1080" }]);
  });

  it("leaves the plain request (no frames) the two-argument call it always was", async () => {
    h.rpc.request_editor_export = { data: E(1), error: null };
    await post({ rev: 3, maxCredits: { project: 1 } });
    expect(h.calls.map((c) => c.args)).toEqual([{ p_project: PID, p_rev: 3 }]);
  });
});
