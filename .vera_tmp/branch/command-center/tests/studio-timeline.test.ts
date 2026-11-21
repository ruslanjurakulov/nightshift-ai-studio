// @vitest-environment jsdom
/**
 * Nightshift Studio's Timeline, the pure part (lib/studio/timeline.ts). What would break without these: a scene that was never shot
 * drawn as if it had a picture; effects or ambience lanes filled with sample clips; a quote without a total read as 0 credits; a
 * shortcut that fires while a person types (the canvas once ate Space in its composer); and a poll loop that dies after one failed
 * read (the canvas once stopped refreshing for good).
 */
import { describe, expect, it, vi } from "vitest";
import { FILM, S1, S2, filmJson, sceneJson } from "./films-fixtures";
import {
  assembleLabel,
  coerceQuote,
  coerceStart,
  coerceTimelineFilm,
  keyAction,
  layoutTimeline,
  chosenShots,
  segmentAt,
  CHAIN_SKIP_S,
  reorder,
  sceneAt,
  shortcutAllowed,
  startOnce,
  startPolling,
  timecode,
} from "../lib/studio/timeline";

const CLIP = "c1000000-0000-4000-8000-0000000000c1";
const NARR = "c2000000-0000-4000-8000-0000000000c2";
const MUSIC = "c3000000-0000-4000-8000-0000000000c3";
const CLIP2 = "c4000000-0000-4000-8000-0000000000c4";
const CLIP3 = "c5000000-0000-4000-8000-0000000000c5";
const take = (over: Record<string, unknown>) => ({
  id: crypto.randomUUID(), scene_id: S1, version: 1, shot_index: 1, kind: "clip", status: "completed", duration_s: 5.5, result_asset_id: CLIP, ...over,
});

describe("lanes from film_json", () => {
  it("every scene is its PLANNED length (the worker trims to it); a shot scene is measured only once the library knows its files", () => {
    const raw = filmJson({}, [
      sceneJson(S1, 0, { current_version: 1, planned_seconds: 8, takes: [take({})] }),
      sceneJson(S2, 1, { planned_seconds: 6, takes: [take({ scene_id: S2, status: "running", result_asset_id: null })] }),
    ]);
    const film = coerceTimelineFilm(raw)!;
    // No asset duration yet: shot, but not measured, whatever film_takes.duration_s (5.5) asked for.
    const before = layoutTimeline(film).clips.filter((c) => c.track === "V1");
    expect(before[0]).toMatchObject({ draft: false, length: 8, measured: false, short: false, assetId: CLIP });
    const { clips, duration } = layoutTimeline(film, new Map([[CLIP, 12]]));
    const v1 = clips.filter((c) => c.track === "V1");
    expect(v1[0]).toMatchObject({ draft: false, length: 8, measured: true, short: false, start: 0 });
    expect(v1[1]).toMatchObject({ draft: true, length: 6, measured: false, start: 8 });
    expect(duration).toBe(14);
  });

  it("H1 (Lens round 2): two 8 s scenes with 12 s and 3 s clips: 16 s in all, scene 2 flagged short, the preview follows the trim", () => {
    const raw = filmJson({}, [
      sceneJson(S1, 0, { current_version: 1, planned_seconds: 8, takes: [take({ result_asset_id: CLIP })] }),
      sceneJson(S2, 1, { current_version: 1, planned_seconds: 8, takes: [take({ scene_id: S2, result_asset_id: CLIP2 })] }),
    ]);
    const { clips, duration } = layoutTimeline(coerceTimelineFilm(raw)!, new Map([[CLIP, 12], [CLIP2, 3]]));
    const [a, b] = clips.filter((c) => c.track === "V1");
    expect(duration).toBe(16);
    expect(a).toMatchObject({ start: 0, length: 8, measured: true, short: false });
    expect(a.segments).toEqual([{ assetId: CLIP, start: 0, length: 8, inPoint: 0 }]);
    expect(b).toMatchObject({ start: 8, length: 8, measured: false, short: true });
    expect(segmentAt(a, 7.5)).toMatchObject({ assetId: CLIP, offset: 7.5, measured: true });
  });

  it("H1: a chained shot starts CHAIN_SKIP_S into its file; a scene continued by the next keeps the END of its footage", () => {
    const raw = filmJson({}, [
      sceneJson(S1, 0, { current_version: 1, planned_seconds: 8, shot_count: 2, takes: [take({ result_asset_id: CLIP }), take({ kind: "extend", shot_index: 2, result_asset_id: CLIP2 })] }),
      sceneJson(S2, 1, { current_version: 1, planned_seconds: 4, first_frame: "previous", takes: [take({ scene_id: S2, result_asset_id: CLIP3 })] }),
    ]);
    // Scene 1: 5 s + (6 − 0.042) s of footage, 8 s shown, scene 2 continues it → the window ends at the footage's end.
    const v1 = layoutTimeline(coerceTimelineFilm(raw)!, new Map([[CLIP, 5], [CLIP2, 6], [CLIP3, 4.5]])).clips.filter((c) => c.track === "V1");
    const total = 5 + (6 - CHAIN_SKIP_S);
    const x = total - 8;
    expect(v1[0].segments![0]).toMatchObject({ assetId: CLIP, start: 0, inPoint: x });
    expect(v1[0].segments![0].length).toBeCloseTo(5 - x);
    expect(v1[0].segments![1].assetId).toBe(CLIP2);
    expect(v1[0].segments![1].inPoint).toBeCloseTo(CHAIN_SKIP_S);
    expect(v1[0].segments![1].length).toBeCloseTo(6 - CHAIN_SKIP_S);
    // Scene 2 continues the previous one: its only shot is chained too.
    expect(v1[1].segments![0]).toMatchObject({ assetId: CLIP3, start: 8, inPoint: CHAIN_SKIP_S, length: 4 });
  });

  it("Lens round 4: a cross-fade out that would land on a sliver of the last shot is refused, as scene_too_short is in the worker", () => {
    const S3 = "53000000-0000-4000-8000-000000000003";
    const film = () =>
      coerceTimelineFilm(filmJson({}, [
        sceneJson(S1, 0, { current_version: 1, planned_seconds: 5, shot_count: 2, takes: [take({ result_asset_id: CLIP }), take({ kind: "extend", shot_index: 2, result_asset_id: CLIP2 })] }),
        sceneJson(S3, 1, { current_version: 1, planned_seconds: 4, transition_in: "crossfade", takes: [take({ scene_id: S3, result_asset_id: CLIP3 })] }),
      ]))!;
    // 4.5 s + 0.558 s covers the 5 s slot, but the window ends 0.5 s into shot 2: the cross-fade needs a 1 s last piece, and
    // moving the window 0.5 s later needs 5.5 s of footage. The worker refuses; the Timeline must not draw it ready.
    const refused = layoutTimeline(film(), new Map([[CLIP, 4.5], [CLIP2, 0.6], [CLIP3, 6]])).clips.filter((c) => c.track === "V1");
    expect(refused[0]).toMatchObject({ short: true, measured: false });
    // With 2 s in shot 2 the worker shows the window 0.5 s later, so shot 2 carries a 1 s last piece.
    const ok = layoutTimeline(film(), new Map([[CLIP, 4.5], [CLIP2, 2], [CLIP3, 6]])).clips.filter((c) => c.track === "V1");
    expect(ok[0]).toMatchObject({ short: false, measured: true });
    expect(ok[0].segments).toEqual([
      { assetId: CLIP, start: 0, length: 4, inPoint: 0.5 },
      { assetId: CLIP2, start: 4, length: 1, inPoint: CHAIN_SKIP_S },
    ]);
  });

  it("Lens round 4: a scene that continues one and is continued by the next cannot lose more than SEAM_TOLERANCE_S (continuity_trim)", () => {
    const S3 = "53000000-0000-4000-8000-000000000003";
    const raw = filmJson({}, [
      sceneJson(S1, 0, { current_version: 1, planned_seconds: 4, takes: [take({ result_asset_id: CLIP })] }),
      sceneJson(S2, 1, { current_version: 1, planned_seconds: 4, first_frame: "previous", takes: [take({ scene_id: S2, result_asset_id: CLIP2 })] }),
      sceneJson(S3, 2, { current_version: 1, planned_seconds: 4, first_frame: "previous", takes: [take({ scene_id: S3, result_asset_id: CLIP3 })] }),
    ]);
    const lanes = (mid: number) => layoutTimeline(coerceTimelineFilm(raw)!, new Map([[CLIP, 5], [CLIP2, mid], [CLIP3, 5]])).clips.filter((c) => c.track === "V1");
    // 5 s − 0.042 s leaves 0.958 s too much, and neither end of scene 2 may be trimmed: refused, never drawn ready.
    expect(lanes(5)[1]).toMatchObject({ trim: true, short: false, measured: false });
    // 4.1 s − 0.042 s leaves 0.058 s, within the tolerance: accepted.
    expect(lanes(4.1)[1]).toMatchObject({ trim: false, measured: true });
  });

  it("a completed take of a version that is not the chosen one does not make the scene shot", () => {
    const raw = filmJson({}, [sceneJson(S1, 0, { current_version: 2, takes: [take({ version: 1 })] })]);
    const v1 = layoutTimeline(coerceTimelineFilm(raw)!).clips.filter((c) => c.track === "V1");
    expect(v1[0].draft).toBe(true);
  });

  it("A3 and A4 are always empty, A1 only with a finished narration take, A2 only with a music file that still exists", () => {
    const bare = layoutTimeline(coerceTimelineFilm(filmJson({}, [sceneJson(S1, 0)]))!).clips;
    expect(bare.filter((c) => ["A1", "A2", "A3", "A4"].includes(c.track))).toEqual([]);

    const raw = { ...filmJson({ music_asset_id: MUSIC }, [sceneJson(S1, 0)]), music_missing: false, takes: [take({ scene_id: null, kind: "narration", shot_index: 0, result_asset_id: NARR, duration_s: 7 })] };
    const full = layoutTimeline(coerceTimelineFilm(raw)!, new Map([[NARR, 7]])).clips;
    expect(full.find((c) => c.track === "A1")).toMatchObject({ assetId: NARR, length: 7, measured: true });
    expect(full.find((c) => c.track === "A2")).toMatchObject({ assetId: MUSIC });
    expect(full.filter((c) => c.track === "A3" || c.track === "A4")).toEqual([]);

    const gone = layoutTimeline(coerceTimelineFilm({ ...filmJson({ music_asset_id: MUSIC }, [sceneJson(S1, 0)]), music_missing: true })!).clips;
    expect(gone.find((c) => c.track === "A2")).toBeUndefined();
  });

  it("captions are the scenes' own narration text over the scene's span; a scene with no words has no caption", () => {
    const raw = filmJson({}, [sceneJson(S1, 0, { narration: "The year is 2050." }), sceneJson(S2, 1, { narration: "  " })]);
    const c1 = layoutTimeline(coerceTimelineFilm(raw)!).clips.filter((c) => c.track === "C1");
    expect(c1).toHaveLength(1);
    expect(c1[0]).toMatchObject({ label: "The year is 2050.", start: 0, length: 8 });
  });

  it("not a film_json answer: null, never a guessed timeline", () => {
    expect(coerceTimelineFilm(null)).toBeNull();
    expect(coerceTimelineFilm({ film: { id: FILM } })).toBeNull();
  });

  it("sceneAt, timecode and reorder", () => {
    const { clips } = layoutTimeline(coerceTimelineFilm(filmJson({}, [sceneJson(S1, 0), sceneJson(S2, 1)]))!);
    expect(sceneAt(clips, 9)?.sceneId).toBe(S2);
    expect(sceneAt(clips, 99)).toBeNull();
    expect(timecode(3723.52)).toBe("01:02:03:13");
    expect(reorder(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(reorder(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  });
});

describe("the money: quote_film and start_film answers", () => {
  const priced = { priced: true, total: 16, quote_id: `fq-3-${"a".repeat(32)}`, startable: true, may_start: true, blocked_by: [], refusals: [], assembly_minutes: 8 };

  it("no number before the backend quote, and none when the quote could not price (total null is not 0)", () => {
    expect(assembleLabel(null)).toEqual({ kind: "none" });
    const unpriced = coerceQuote({ priced: false, total: null, quote_id: null, refusals: [{ reason: "unpriced" }], blocked_by: [] })!;
    expect(unpriced.total).toBeNull();
    expect(unpriced.refusal).toBe("unpriced");
    expect(assembleLabel(unpriced)).toEqual({ kind: "none" });
    expect(assembleLabel(coerceQuote(priced))).toEqual({ kind: "credits", total: 16 });
  });

  it("a malformed quote id never becomes a startable quote", () => {
    const q = coerceQuote({ ...priced, quote_id: "fq-x" })!;
    expect(q.priced).toBe(false);
    expect(q.startable).toBe(false);
    expect(assembleLabel(q)).toEqual({ kind: "none" });
  });

  it("blocked reasons are read, unknown ones are 'other', and a blocked quote is not startable whatever the flag says", () => {
    const q = coerceQuote({ ...priced, startable: false, blocked_by: [{ reason: "insufficient_credits" }, { reason: "surprise" }] })!;
    expect(q.blockedBy).toEqual(["insufficient_credits", "other"]);
    expect(q.startable).toBe(false);
  });

  it("start answers: ok, replayed, and named refusals", () => {
    expect(coerceStart({ ok: true, replayed: true })).toEqual({ ok: true, replayed: true });
    expect(coerceStart({ ok: false, reason: "insufficient_credits" })).toEqual({ ok: false, reason: "insufficient_credits" });
    expect(coerceStart({ ok: false, reason: "made_up" })).toEqual({ ok: false, reason: "other" });
    expect(coerceStart(null)).toEqual({ ok: false, reason: "other" });
  });

  it("a double press sends one start, and a retry after a failure reuses the same idempotency key", async () => {
    let release!: () => void;
    const send = vi.fn((idem: string) => new Promise<string>((r) => (release = () => r(idem))));
    let n = 0;
    const s = startOnce(send, () => `film-key-${++n}`);
    const a = s.run();
    const b = s.run();
    expect(send).toHaveBeenCalledTimes(1);
    release();
    expect(await a).toBe("film-key-1");
    expect(await b).toBe("film-key-1");
    send.mockImplementationOnce(() => Promise.reject(new Error("network")));
    await expect(s.run()).rejects.toThrow("network");
    send.mockImplementationOnce((idem: string) => Promise.resolve(idem));
    expect(await s.run()).toBe("film-key-1");
    s.reset();
    send.mockImplementationOnce((idem: string) => Promise.resolve(idem));
    expect(await s.run()).toBe("film-key-2");
  });
});

describe("keyboard", () => {
  it("only on the page or the timeline's own surfaces; never in a field, on a button, a tab, a slider, a dialog or the inspector", () => {
    document.body.innerHTML = `<input id="i"><textarea id="t"></textarea><div contenteditable="true"><span id="ce">x</span></div>
      <section id="insp"><div id="inside">x</div></section>
      <div data-tl-surface=""><div id="lane"></div><button id="btn">Play</button><div role="slider" id="ruler"></div><div role="tab" id="tab"></div></div>
      <div role="dialog"><div id="dlg" data-tl-surface=""></div></div><div id="elsewhere"></div>`;
    const $ = (id: string) => document.getElementById(id);
    const insp = $("insp");
    for (const id of ["i", "t", "ce", "inside", "btn", "ruler", "tab", "dlg", "elsewhere"]) expect([id, shortcutAllowed($(id), insp)]).toEqual([id, false]);
    expect(shortcutAllowed($("lane"), insp)).toBe(true);
    expect(shortcutAllowed(document.body, insp)).toBe(true);
  });

  it("Space, J/K/L, arrows, I/O; nothing with a modifier", () => {
    expect(keyAction({ key: " ", code: "Space", metaKey: false, ctrlKey: false, altKey: false })).toBe("toggle");
    expect(keyAction({ key: "j", code: "KeyJ", metaKey: false, ctrlKey: false, altKey: false })).toBe("back");
    expect(keyAction({ key: "K", code: "KeyK", metaKey: false, ctrlKey: false, altKey: false })).toBe("pause");
    expect(keyAction({ key: "l", code: "KeyL", metaKey: false, ctrlKey: false, altKey: false })).toBe("forward");
    expect(keyAction({ key: "ArrowRight", code: "ArrowRight", metaKey: false, ctrlKey: false, altKey: false })).toBe("nextFrame");
    expect(keyAction({ key: "i", code: "KeyI", metaKey: false, ctrlKey: false, altKey: false })).toBe("markIn");
    expect(keyAction({ key: "o", code: "KeyO", metaKey: false, ctrlKey: false, altKey: false })).toBe("markOut");
    expect(keyAction({ key: "l", code: "KeyL", metaKey: true, ctrlKey: false, altKey: false })).toBeNull();
  });
});

describe("polling", () => {
  it("survives a failed read and backs off; a good read resets the wait; stop ends it", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const read = vi.fn(async () => {
        n += 1;
        if (n === 1) throw new Error("network");
        if (n === 2) return "error" as const;
        return "ok" as const;
      });
      const poll = startPolling(read, 1000);
      await vi.advanceTimersByTimeAsync(1000); // read 1 throws → next in 2000
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1999);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); // read 2 errors → next in 4000
      expect(read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4000); // read 3 ok → back to 1000
      expect(read).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1000);
      expect(read).toHaveBeenCalledTimes(4);
      poll.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stop verdict (project gone, session ended) ends the loop; pause reads nothing until resume, which reads at once", async () => {
    vi.useFakeTimers();
    try {
      const stopper = vi.fn(async () => "stop" as const);
      startPolling(stopper, 1000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stopper).toHaveBeenCalledTimes(1);

      const read = vi.fn(async () => "ok" as const);
      const poll = startPolling(read, 1000);
      poll.pause();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(read).not.toHaveBeenCalled();
      poll.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(1);
      poll.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
