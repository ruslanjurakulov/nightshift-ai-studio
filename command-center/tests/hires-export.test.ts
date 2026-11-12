import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 1440p and 4K exports (migration 0132, NIGHTSHIFT_HIRES_EXPORT): the pure half (tiers, caps, the quote's shape, the frame
 * list) and the two routes (the quote; the export request with a paid frame).
 *
 * What would break without these: a paid frame accepted while its switch is off; a paid frame sent without the number the
 * person confirmed, or with one the route made up; a price shown that the server did not compute (or half computed); the
 * tiers or caps drifting from the worker's and the database's (tests/test_editor_hires_export_migration.py compares the
 * three); a refusal shown with the wrong sentence; and the quote route existing while either switch is off.
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
  audits: [] as { action: string; target?: string; detail?: Record<string, unknown> }[],
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
vi.mock("@/lib/server/audit", () => ({ logAudit: async (e: (typeof h.audits)[number]) => void h.audits.push(e) }));
vi.mock("@/lib/server/editor-guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/editor-guard")>()),
  editorRateLimited: async () => null,
}));

const exportsRoute = await import("../app/api/editor/projects/[id]/exports/route");
const quoteRoute = await import("../app/api/editor/projects/[id]/exports/quote/route");
const {
  aboveFree,
  hasSpeedCurve,
  HIRES_EXPORT_PRESETS,
  HIRES_MAX_FPS,
  HIRES_MAX_S,
  hiresTier,
  overHiresCap,
  overHiresFps,
  parseHiresQuote,
  quoteBlocker,
} = await import("../lib/hiresExport/limits");
const { hiresExportEnabled } = await import("../lib/hiresExport/flag");
const { otherFrames, parseExportFrames, framePresetById, frameProblems, PROJECT_FRAME } = await import("../lib/multiRatioExport/frames");
const { toModel } = await import("../lib/editor");
const { mapEditorError, EDITOR_ERRORS, EXPORT_REASONS } = await import("../lib/editor");
const { canRetry } = await import("../lib/editorExportStatus");
const { en } = await import("../lib/i18n/en");
const { ru } = await import("../lib/i18n/ru");
const { uz } = await import("../lib/i18n/uz");

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

const DBQUOTE = {
  paid: true, tier: "2160p", max_s: 180, max_fps: 30, fps: 30, too_fast: false, minutes: 1, credits_per_minute: 12.5, credits: 12.5, hold: 12.5,
  speed_curve: false,
  frame: "youtube_2160p", width: 3840, height: 2160, duration_s: 6, too_long: false, on_sale: true, may_pay: true,
  exempt: false, available: 100,
};

beforeEach(() => {
  h.user = { id: "u1", email: "me@example.com" };
  h.rpc = {};
  h.calls = [];
  h.audits = [];
  vi.stubEnv("NIGHTSHIFT_MULTI_RATIO_EXPORT", "on");
  vi.stubEnv("NIGHTSHIFT_HIRES_EXPORT", "on");
});
afterEach(() => vi.unstubAllEnvs());

describe("the tiers and caps", () => {
  it("are by pixels, so a frame and its 9:16 twin are one tier", () => {
    expect(HIRES_EXPORT_PRESETS.map((p) => hiresTier(p.width, p.height))).toEqual(["1440p", "1440p", "2160p", "2160p"]);
    expect(hiresTier(1920, 1080)).toBeNull();
    expect(hiresTier(1080, 1920)).toBeNull();
    expect(hiresTier(1920, 1082)).toBe("1440p");
    expect(hiresTier(2560, 1442)).toBe("2160p");
    expect(hiresTier(3840, 2162)).toBeNull();
    for (const bad of [[1920.5, 1080], ["3840", "2160"], [null, 2], [-3840, -2160], [0, 0]] as [unknown, unknown][])
      expect(hiresTier(...bad)).toBeNull();
  });

  it("cap a paid frame at 300 s (1440p) and 180 s (4K), and never a free one", () => {
    expect(HIRES_MAX_S).toEqual({ "1440p": 300, "2160p": 180 });
    expect(overHiresCap(2560, 1440, 300)).toBe(false);
    expect(overHiresCap(1440, 2560, 300.01)).toBe(true);
    expect(overHiresCap(3840, 2160, 180)).toBe(false);
    expect(overHiresCap(2160, 3840, 181)).toBe(true);
    expect(overHiresCap(3840, 2160, Number.NaN)).toBe(true);
    expect(overHiresCap(1920, 1080, 1800)).toBe(false);
    for (const p of HIRES_EXPORT_PRESETS) expect(p.maxDurationS).toBe(HIRES_MAX_S[hiresTier(p.width, p.height)!]);
  });

  it("hold 4K to 30 fps and 1440p to 60 (a cross-faded 9:16 4K60 render ran out of the worker's memory)", () => {
    expect(HIRES_MAX_FPS).toEqual({ "1440p": 60, "2160p": 30 });
    expect(overHiresFps(3840, 2160, 30)).toBe(false);
    expect(overHiresFps(2160, 3840, 50)).toBe(true);
    expect(overHiresFps(3840, 2160, 60)).toBe(true);
    expect(overHiresFps(2560, 1440, 60)).toBe(false);
    expect(overHiresFps(1920, 1080, 60)).toBe(false);
    expect(overHiresFps(3840, 2160, Number.NaN)).toBe(true);
    for (const p of HIRES_EXPORT_PRESETS) expect(p.fps).toBeLessThanOrEqual(HIRES_MAX_FPS[hiresTier(p.width, p.height)!]);
  });
});

describe("above 1080p and speed curves", () => {
  it("above 1080p is by pixels and fails closed", () => {
    for (const [w, h] of [[1920, 1080], [1080, 1920], [1280, 720]]) expect(aboveFree(w, h), `${w}x${h}`).toBe(false);
    for (const [w, h] of [[1920, 1082], [2560, 1440], [3840, 2160], [4096, 4096]]) expect(aboveFree(w, h), `${w}x${h}`).toBe(true);
    for (const bad of [[null, 1080], ["1920", "1080"], [0, 0], [1920.5, 1080]] as [unknown, unknown][]) expect(aboveFree(...bad)).toBe(true);
  });

  it("a speed curve is found where the database looks: any clip of any track of the saved document", () => {
    expect(hasSpeedCurve({ tracks: [{ clips: [{ id: "a" }] }, { clips: [{ id: "b", speed_curve: [] }] }] })).toBe(true);
    expect(hasSpeedCurve({ tracks: [{ clips: [{ id: "a", speed: 2 }] }] })).toBe(false);
    expect(hasSpeedCurve({ tracks: [null, "x", { clips: "no" }] })).toBe(false);
    expect(hasSpeedCurve({})).toBe(false);
  });
});

describe("editor parity 2a's large-frame rules in the paid sizes", () => {
  // A mask on a cross-faded clip is refused above 2560x1440 (modules/timeline.py LARGE_FRAME_PX): the editor checks each size
  // as the worker does, so the 4K sizes are blocked and the 1440p ones are not.
  const A = "11111111-1111-4111-8111-111111111111";
  const masked = toModel({
    version: 1, width: 1920, height: 1080, fps: 30,
    tracks: [{ id: "v1", kind: "V", clips: [
      { id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 3 },
      { id: "c2", asset_id: A, start_s: 2.5, in_s: 3, out_s: 6, mask: { shape: "ellipse" }, transition: { type: "crossfade", duration_s: 0.5 } },
    ] }],
  } as never);
  it("blocks 4K and leaves 1440p", () => {
    expect(frameProblems(masked, "youtube_2160p").length).toBeGreaterThan(0);
    expect(frameProblems(masked, "vertical_2160p").length).toBeGreaterThan(0);
    expect(frameProblems(masked, "youtube_1440p")).toEqual([]);
    expect(frameProblems(masked, "vertical_1440p")).toEqual([]);
    expect(frameProblems(masked, "youtube_1080p")).toEqual([]);
  });
});

describe("the frame list with paid frames", () => {
  it("offers paid frames only when the switch says so, and never the project's own size twice", () => {
    const m = { width: 1920, height: 1080 };
    expect(otherFrames(m)).not.toContain("youtube_2160p");
    expect(otherFrames(m, { hires: true }).slice(-4)).toEqual(["youtube_1440p", "vertical_1440p", "youtube_2160p", "vertical_2160p"]);
    // A project whose own frame is 4K cannot export its own size free: the paid 4K format is its way, so it IS offered.
    expect(otherFrames({ width: 3840, height: 2160 }, { hires: true })).toContain("youtube_2160p");
    expect(otherFrames({ width: 3840, height: 2160 }, { hires: true })).toContain("youtube_1080p");
  });

  it("parses a paid frame only with the switch, in the list's order, and refuses the whole request otherwise", () => {
    expect(parseExportFrames(["youtube_2160p"])).toBeNull();
    expect(parseExportFrames(["youtube_2160p", PROJECT_FRAME], { hires: true })).toEqual([PROJECT_FRAME, "youtube_2160p"]);
    expect(parseExportFrames(["vertical_2160p", "square_1080", "youtube_1440p"], { hires: true })).toEqual([
      "square_1080", "youtube_1440p", "vertical_2160p",
    ]);
    for (const bad of [["youtube_4k"], ["YOUTUBE_2160P"], ["3840x2160"], ["youtube_2160p", "youtube_2160p"], [{ id: "youtube_2160p" }]])
      expect(parseExportFrames(bad, { hires: true }), JSON.stringify(bad)).toBeNull();
    expect(framePresetById("vertical_2160p")).toMatchObject({ width: 2160, height: 3840 });
    expect(framePresetById("nope")).toBeNull();
  });
});

describe("the quote", () => {
  it("is read whole from the database's answer or not at all", () => {
    const q = parseHiresQuote(DBQUOTE)!;
    expect(q).toEqual({
      frame: "youtube_2160p", tier: "2160p", durationS: 6, minutes: 1, maxS: 180, tooLong: false, maxFps: 30, tooFast: false, fps: 30,
      onSale: true, creditsPerMinute: 12.5, credits: 12.5, hold: 12.5, speedCurve: false, available: 100, exempt: false, mayPay: true,
    });
    // The route's camelCase answer reads the same.
    expect(parseHiresQuote(q)).toEqual(q);
    // Numeric columns may come as strings from PostgREST.
    expect(parseHiresQuote({ ...DBQUOTE, credits: "12.50", credits_per_minute: "12.50", available: "100.00" })?.credits).toBe(12.5);
    for (const bad of [
      null, [], "x", { ...DBQUOTE, frame: "square_1080" }, { ...DBQUOTE, tier: "8k" }, { ...DBQUOTE, paid: false },
      { ...DBQUOTE, on_sale: "yes" }, { ...DBQUOTE, minutes: null }, { ...DBQUOTE, max_fps: undefined }, { ...DBQUOTE, credits: null },
      { ...DBQUOTE, credits: "abc" }, { ...DBQUOTE, hold: null }, { ...DBQUOTE, hold: undefined }, { ...DBQUOTE, hold: 12 },
    ])
      expect(parseHiresQuote(bad), JSON.stringify(bad)).toBeNull();
    // Not on sale: no number is kept even if one came along.
    const off = parseHiresQuote({ ...DBQUOTE, on_sale: false, credits: null, credits_per_minute: null, hold: null })!;
    expect([off.onSale, off.credits, off.creditsPerMinute, off.hold]).toEqual([false, null, null, null]);
    // The platform's job minimum raises the hold, never the charge.
    const floor = parseHiresQuote({ ...DBQUOTE, credits: 4, hold: 30 })!;
    expect([floor.credits, floor.hold]).toEqual([4, 30]);
    expect(parseHiresQuote({ ...DBQUOTE, speed_curve: true })!.speedCurve).toBe(true);
  });

  it("names what blocks Export, in this order", () => {
    const q = parseHiresQuote(DBQUOTE)!;
    expect(quoteBlocker(q)).toBeNull();
    expect(quoteBlocker({ ...q, onSale: false, credits: null })).toBe("not_on_sale");
    expect(quoteBlocker({ ...q, speedCurve: true, tooLong: true })).toBe("hires_speed_curve");
    expect(quoteBlocker({ ...q, tooLong: true })).toBe("hires_too_long");
    expect(quoteBlocker({ ...q, tooFast: true, fps: 60 })).toBe("hires_fps");
    expect(quoteBlocker({ ...q, mayPay: false })).toBe("forbidden");
    expect(quoteBlocker({ ...q, available: 12.49 })).toBe("insufficient_credits");
    expect(quoteBlocker({ ...q, available: 12.5 })).toBeNull();
    // What must be available is the HOLD (the charge raised to job_minimum), not only the charge.
    expect(quoteBlocker({ ...q, credits: 4, hold: 30, available: 29.99 })).toBe("insufficient_credits");
    expect(quoteBlocker({ ...q, credits: 4, hold: 30, available: 30 })).toBeNull();
    expect(quoteBlocker({ ...q, exempt: true, available: null })).toBeNull();
  });
});

describe("GET .../exports/quote", () => {
  it("does not exist while either switch is off", async () => {
    for (const [multi, hires] of [["", "on"], ["on", ""], ["", ""], ["on", "enabled"]]) {
      vi.stubEnv("NIGHTSHIFT_MULTI_RATIO_EXPORT", multi);
      vi.stubEnv("NIGHTSHIFT_HIRES_EXPORT", hires);
      const res = await getQuote("rev=1&frame=youtube_2160p");
      expect(res.status, `${multi}/${hires}`).toBe(404);
    }
    expect(h.calls).toEqual([]);
    expect(hiresExportEnabled("on")).toBe(true);
    expect(hiresExportEnabled(undefined)).toBe(false);
  });

  it("asks the database under the caller's session and sends its numbers on, and nothing else", async () => {
    h.rpc.quote_editor_export = { data: DBQUOTE, error: null };
    const res = await getQuote("rev=3&frame=youtube_2160p");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.calls).toEqual([{ name: "quote_editor_export", args: { p_project: PID, p_rev: 3, p_frame: "youtube_2160p" } }]);
    expect((await res.json()).quote).toEqual(parseHiresQuote(DBQUOTE));
  });

  it("refuses a made-up frame, a bad revision and a stranger before the database", async () => {
    for (const qs of ["rev=1&frame=youtube_4k", "rev=1&frame=PROJECT", "rev=1&frame=3840x2160", "rev=0&frame=youtube_2160p", "rev=x&frame=youtube_2160p",
      "rev=1.5&frame=youtube_2160p", "frame=youtube_2160p", "rev=1"]) {
      const res = await getQuote(qs);
      expect(res.status, qs).toBe(400);
    }
    h.user = null;
    expect((await getQuote("rev=1&frame=youtube_2160p")).status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it("says the database's refusal in its word, and a quote it cannot read as failed", async () => {
    for (const [err, word, status] of [
      [{ code: "P0002", message: "not_found" }, "not_found", 404],
      [{ code: "NS409", message: "stale_revision" }, "stale_revision", 409],
      [{ code: "PGRST202", message: "Could not find the function" }, "not_available", 503],
    ] as [Err, string, number][]) {
      h.rpc.quote_editor_export = { data: null, error: err };
      const res = await getQuote("rev=1&frame=youtube_2160p");
      expect([res.status, (await res.json()).error]).toEqual([status, word]);
    }
    h.rpc.quote_editor_export = { data: { ...DBQUOTE, frame: "youtube_1440p" }, error: null };
    expect((await getQuote("rev=1&frame=youtube_2160p")).status).toBe(502);
    h.rpc.quote_editor_export = { data: { ...DBQUOTE, credits: "lots" }, error: null };
    expect((await getQuote("rev=1&frame=youtube_2160p")).status).toBe(502);
  });
});

describe("POST .../exports with a paid frame", () => {
  it("is an unknown frame while the hires switch is off", async () => {
    vi.stubEnv("NIGHTSHIFT_HIRES_EXPORT", "");
    const res = await post({ rev: 1, frames: ["youtube_2160p"], maxCredits: { youtube_2160p: 50 } });
    expect([res.status, (await res.json()).error]).toEqual([400, "bad_request"]);
    expect(h.calls).toEqual([]);
  });

  it("needs the confirmed number of every paid frame, or refuses the whole request before the database", async () => {
    for (const maxCredits of [undefined, {}, { youtube_2160p: "50" }, { youtube_2160p: -1 }, { youtube_2160p: null },
      { youtube_2160p: Number.POSITIVE_INFINITY }, { youtube_1440p: 50 }, [50], { youtube_2160p: 1e9 }]) {
      const res = await post({ rev: 1, frames: ["square_1080", "youtube_2160p"], maxCredits });
      expect([res.status, (await res.json()).error], JSON.stringify(maxCredits)).toEqual([400, "quote_required"]);
    }
    expect(h.calls).toEqual([]);
  });

  it("sends the paid frame to the four-argument function with that number, and a free frame as always", async () => {
    let n = 0;
    h.rpc.request_editor_export = () => ({ data: E(++n), error: null });
    const res = await post({ rev: 2, frames: ["youtube_2160p", "square_1080"], maxCredits: { youtube_2160p: 12.5 } });
    expect(res.status).toBe(201);
    expect(h.calls).toEqual([
      { name: "request_editor_export", args: { p_project: PID, p_rev: 2, p_frame: "square_1080" } },
      { name: "request_editor_export", args: { p_project: PID, p_rev: 2, p_frame: "youtube_2160p", p_max_credits: 12.5 } },
    ]);
    expect(h.audits.map((a) => a.detail)).toEqual([
      { project: PID, rev: 2, frame: "square_1080" },
      { project: PID, rev: 2, frame: "youtube_2160p", maxCredits: 12.5 },
    ]);
  });

  it("answers each paid refusal with its own word, beside a free frame that was queued", async () => {
    for (const [err, word] of [
      [{ code: "NS403", message: "not_on_sale" }, "not_on_sale"],
      [{ code: "NS409", message: "price_changed" }, "price_changed"],
      [{ code: "NS402", message: "insufficient_credits" }, "insufficient_credits"],
      [{ code: "NS400", message: "hires_too_long" }, "hires_too_long"],
      [{ code: "NS400", message: "hires_fps" }, "hires_fps"],
      [{ code: "NS429", message: "parallel_runs" }, "parallel_runs"],
      [{ code: "42501", message: "forbidden" }, "forbidden"],
    ] as [Err, string][]) {
      h.calls = [];
      h.rpc.request_editor_export = (args) => (args.p_max_credits === undefined ? { data: E(1), error: null } : { data: null, error: err });
      const res = await post({ rev: 1, frames: ["vertical_1080p", "vertical_2160p"], maxCredits: { vertical_2160p: 3 } });
      const body = await res.json();
      expect(res.status, word).toBe(201);
      expect(body.exports, word).toEqual([
        { frame: "vertical_1080p", id: E(1), status: "queued" },
        { frame: "vertical_2160p", error: word },
      ]);
    }
  });
});

describe("words and sentences", () => {
  it("map the database's paid refusals to words with a sentence in three languages", () => {
    expect(mapEditorError({ code: "NS402", message: "insufficient_credits" })).toEqual({ error: "insufficient_credits", status: 402 });
    expect(mapEditorError({ code: "NS403", message: "not_on_sale" })).toEqual({ error: "not_on_sale", status: 403 });
    expect(mapEditorError({ code: "NS409", message: "price_changed" })).toEqual({ error: "price_changed", status: 409 });
    expect(mapEditorError({ code: "NS400", message: "hires_too_long" })).toEqual({ error: "hires_too_long", status: 400 });
    expect(mapEditorError({ code: "NS429", message: "parallel_runs" })).toEqual({ error: "parallel_runs", status: 429 });
    expect(mapEditorError({ code: "NS400", message: "hires_fps" })).toEqual({ error: "hires_fps", status: 400 });
    expect(mapEditorError({ code: "NS400", message: "hires_speed_curve" })).toEqual({ error: "hires_speed_curve", status: 400 });
    expect(mapEditorError({ code: "NS400", message: "hires_needs_paid_export" })).toEqual({ error: "hires_needs_paid_export", status: 400 });
    for (const d of [en, ru, uz]) {
      for (const w of EDITOR_ERRORS) expect(d.editor.errors[w], w).toBeTruthy();
      for (const w of EXPORT_REASONS) expect(d.editor.exportReasons[w], w).toBeTruthy();
      expect(Object.keys(d.editor.exportHires)).toEqual(Object.keys(en.editor.exportHires));
      expect(Object.keys(d.editor.exportHires.names)).toEqual(HIRES_EXPORT_PRESETS.map((p) => p.id));
      for (const v of Object.values(d.editor.exportHires)) if (typeof v === "string") expect(v).not.toMatch(/ — | – |--/);
    }
  });

  it("never offers a quiet retry of a paid export that the switch, the hold or the rate ended", () => {
    expect(canRetry("hires_off")).toBe(false);
    expect(canRetry("credits_released")).toBe(false);
    expect(canRetry("hires_fps")).toBe(false);
    expect(canRetry("hires_needs_paid_export")).toBe(false);
    expect(canRetry("hires_speed_curve")).toBe(false);
    expect(canRetry("hires_length_mismatch")).toBe(false);
    expect(canRetry("timed_out")).toBe(true);
  });
});
