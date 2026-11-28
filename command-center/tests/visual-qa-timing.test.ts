/**
 * The timing harness's analysis (tools/visual-qa/timing/analysis.mjs) decides whether the live-creation targets pass, so a bug
 * here would report "no blank, no reload" for a screen that is blank and reloads. These pin the three judgements: unchanged
 * stretches, the first-seen event table, and the reload counter.
 */
import { describe, expect, it } from "vitest";
import {
  changeTimes,
  checkTargets,
  countReloads,
  eventTable,
  renderReport,
  unchangedStretches,
} from "../../tools/visual-qa/timing/analysis.mjs";

type S = { t: number; docId?: string; url?: string; counts?: Record<string, number>; texts?: Record<string, string | null>; regions?: Record<string, string | null>; error?: string };
const sample = (t: number, over: Partial<S> = {}): S => ({ t, docId: "d1", url: "/x", counts: {}, texts: {}, regions: {}, ...over });

/** One sample every 100 ms from `from` to `to`, with `at(t)` deciding what is on screen. */
function run(from: number, to: number, at: (t: number) => Partial<S>): S[] {
  const out: S[] = [];
  for (let t = from; t <= to; t += 100) out.push(sample(t, at(t)));
  return out;
}

describe("unchangedStretches", () => {
  it("finds a frozen stretch inside a work window and ranks the longest first (ties: earliest first)", () => {
    // Changes at 1.0 s and 6.0 s and 7.5 s; the work window is 0 .. 9 s.
    const samples = run(0, 9000, (t) => ({ regions: { board: t < 1000 ? "a" : t < 6000 ? "b" : t < 7500 ? "c" : "d" } }));
    const got = unchangedStretches(samples, [{ name: "w", from: 0, to: 9000 }], { thresholdMs: 1000 });
    expect(got.map((s: { from: number; to: number; ms: number }) => [s.from, s.to, s.ms])).toEqual([
      [1000, 6000, 5000],
      [6000, 7500, 1500],
      [7500, 9000, 1500],
    ]);
  });

  it("does not count the person's own pause between windows against the app", () => {
    const samples = run(0, 10000, () => ({ regions: { board: "same" } }));
    const got = unchangedStretches(samples, [{ name: "a", from: 0, to: 2000 }, { name: "b", from: 8000, to: 10000 }], { thresholdMs: 1000 });
    expect(got.map((s: { window: string; ms: number }) => [s.window, s.ms])).toEqual([["a", 2000], ["b", 2000]]);
  });

  it("tells a frozen board apart from a busy panel when narrowed to one region", () => {
    const samples = run(0, 5000, (t) => ({ regions: { board: "frozen", panel: String(Math.floor(t / 500)) } }));
    const w = [{ name: "w", from: 0, to: 5000 }];
    expect(unchangedStretches(samples, w, { thresholdMs: 1000 })).toEqual([]);
    expect(unchangedStretches(samples, w, { thresholdMs: 1000, only: "board" })[0]).toMatchObject({ region: "board", ms: 5000 });
  });

  it("skips the blank samples between documents instead of reading them as a change", () => {
    const samples = [sample(0, { regions: { board: "a" } }), { t: 100, error: "Execution context was destroyed" }, sample(200, { regions: { board: "a" } })];
    expect(changeTimes(samples)).toEqual([]);
    // A new document is a change even when the region looks the same.
    expect(changeTimes([sample(0), sample(100, { docId: "d2" })])).toEqual([100]);
    // A same-document URL change (history.replaceState) is not something on the page.
    expect(changeTimes([sample(0), sample(100, { url: "/x?brain=1" })])).toEqual([]);
  });
});

describe("eventTable", () => {
  it("lists DOM events at the first sample that shows them, marks once, and never-seen events as null at the end", () => {
    const samples = run(0, 3000, (t) => ({ counts: { cards: t >= 1200 ? 3 : 0, nodes: 0 }, texts: { input: t >= 2000 ? "" : "typed" } }));
    const marks = [
      { t: 800, name: "ns:plan:first-card", source: "page" },
      { t: 900, name: "ns:plan:first-card", source: "page" },
      { t: 100, name: "send_pressed", source: "script" },
    ];
    const rows = eventTable({
      samples,
      marks,
      navigations: [{ t: 2500, url: "/x?view=live", document: true }, { t: 2600, url: "/x?brain=1", document: false }],
      defs: [
        { name: "cards", count: "cards" },
        { name: "three cards", count: "cards", min: 3 },
        { name: "canvas node", count: "nodes" },
        { name: "input cleared", text: "input", match: /^$/, after: 100 },
      ],
    });
    expect(rows.map((r: { name: string; t: number | null; source: string }) => [r.name, r.t, r.source])).toEqual([
      ["send_pressed", 100, "script"],
      ["ns:plan:first-card", 800, "mark"],
      ["cards", 1200, "dom"],
      ["three cards", 1200, "dom"],
      ["input cleared", 2000, "dom"],
      ["document load /x?view=live", 2500, "nav"],
      ["canvas node", null, "dom"],
    ]);
  });
});

describe("countReloads", () => {
  const navs = [
    { t: 0, url: "/night-owl/studio", document: true },
    { t: 4000, url: "/night-owl/studio?brain=1", document: false },
    { t: 9000, url: "/night-owl/studio?view=live&film=f", document: true },
  ];
  it("counts only new documents after Create, not the first load or history.replaceState", () => {
    expect(countReloads(navs, { after: 8000 })).toBe(1);
    expect(countReloads(navs.slice(0, 2), { after: 3000 })).toBe(0);
  });
});

describe("checkTargets", () => {
  it("fails a window whose expected event never happens, even when something else on screen changed", () => {
    const samples = run(0, 6000, (t) => ({ counts: { dots: t >= 100 ? 1 : 0 }, regions: { board: "frozen", panel: t >= 100 ? "b" : "a" } }));
    const windows = [{ name: "send", from: 0, to: 6000, expect: ["plan card"] }];
    const table = eventTable({ samples, defs: [{ name: "plan card", count: "cards" }] });
    const got = checkTargets({ windows, table, samples, navigations: [{ t: 5000, url: "/live", document: true }], createAt: 4000, stretchRegions: [null, "board"] });
    expect(got.firstEvent.rows[0]).toMatchObject({ ms: null, anyChangeMs: 100, ok: false });
    expect(got.stretch.rows.find((r: { region: string }) => r.region === "board")).toMatchObject({ ms: 6000, ok: false });
    expect(got.reloads).toMatchObject({ count: 1, ok: false });
    expect(renderReport({ title: "t", table, windows, stretches: [], checks: got })).toContain("| never (any screen change: 0.10 s) | NO |");
  });

  it("passes when the event lands within a second, nothing freezes over 3 s and Create stays on the page", () => {
    const samples = run(0, 6000, (t) => ({ counts: { cards: t >= 400 ? Math.floor(t / 1000) + 1 : 0 } }));
    const windows = [{ name: "send", from: 0, to: 6000, expect: ["plan card"] }];
    const table = eventTable({ samples, defs: [{ name: "plan card", count: "cards" }] });
    const got = checkTargets({ windows, table, samples, navigations: [{ t: 0, url: "/s", document: true }], createAt: 5000 });
    expect(got.firstEvent.ok && got.stretch.ok && got.reloads.ok).toBe(true);
    expect(got.firstEvent.rows[0].ms).toBe(400);
  });

  it("reports reloads as unknown, not zero, when Create was never reached", () => {
    const got = checkTargets({ windows: [], table: [], samples: [], navigations: [], createAt: null });
    expect(got.reloads).toMatchObject({ count: null, ok: false });
  });
});
