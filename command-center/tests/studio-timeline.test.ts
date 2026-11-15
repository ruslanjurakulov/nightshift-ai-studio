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
const take = (over: Record<string, unknown>) => ({
  id: crypto.randomUUID(), scene_id: S1, version: 1, shot_index: 1, kind: "clip", status: "completed", duration_s: 5.5, result_asset_id: CLIP, ...over,
});

describe("lanes from film_json", () => {
  it("a scene without a chosen, finished take is a draft block at its PLANNED length; a shot scene is its measured length", () => {
    const raw = filmJson({}, [
      sceneJson(S1, 0, { current_version: 1, planned_seconds: 8, takes: [take({})] }),
      sceneJson(S2, 1, { planned_seconds: 6, takes: [take({ scene_id: S2, status: "running", result_asset_id: null })] }),
    ]);
    const film = coerceTimelineFilm(raw)!;
    const { clips, duration } = layoutTimeline(film);
    const v1 = clips.filter((c) => c.track === "V1");
    expect(v1[0]).toMatchObject({ draft: false, length: 5.5, measured: true, assetId: CLIP, start: 0 });
    expect(v1[1]).toMatchObject({ draft: true, length: 6, measured: false, assetId: null, start: 5.5 });
    expect(duration).toBe(11.5);
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
    const full = layoutTimeline(coerceTimelineFilm(raw)!).clips;
    expect(full.find((c) => c.track === "A1")).toMatchObject({ assetId: NARR, length: 7 });
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
  it("never inside an input, a text area, something editable, or the inspector", () => {
    document.body.innerHTML = `<input id="i"><textarea id="t"></textarea><div contenteditable="true"><span id="ce">x</span></div>
      <section id="insp"><button id="b">Level</button></section><div id="lane"></div>`;
    const $ = (id: string) => document.getElementById(id);
    const insp = $("insp");
    expect(shortcutAllowed($("i"), insp)).toBe(false);
    expect(shortcutAllowed($("t"), insp)).toBe(false);
    expect(shortcutAllowed($("ce"), insp)).toBe(false);
    expect(shortcutAllowed($("b"), insp)).toBe(false);
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
  it("survives a failed read: the next read is scheduled after a rejection and after a throw, until stopped", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const read = vi.fn(async () => {
        n += 1;
        if (n === 1) throw new Error("network");
        if (n === 2) return Promise.reject(new Error("502"));
        return "ok";
      });
      const poll = startPolling(read, 1000);
      for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(1000);
      expect(read).toHaveBeenCalledTimes(4);
      poll.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(read).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
