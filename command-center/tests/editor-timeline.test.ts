/**
 * The editor's pure half (lib/editor.ts, migration 0054): the validator twin
 * of modules/timeline.py, judged on the same documents as the Python one
 * (samples/timeline_doc_cases.json at the repository root), and the
 * free tools as data — trim, split, speed, clip sound, text — always
 * producing a document the renderer accepts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPORT_MAX_S,
  MAX_EDITOR_CLIPS,
  MAX_EDITOR_TEXTS,
  MAX_TEXT,
  SPEEDS,
  SPEED_MAX,
  SPEED_MIN,
  addClip,
  addText,
  canSplit,
  clipAt,
  clipEnd,
  coerceExports,
  docAssetIds,
  docAssetProblems,
  editorErrorWord,
  formatTime,
  layout,
  mapEditorError,
  modelDuration,
  moveClip,
  newDocForAsset,
  parseTitle,
  removeClip,
  setClipAudio,
  setSpeed,
  splitClip,
  textWarnings,
  toDoc,
  toModel,
  trimClip,
  updateText,
  validateTimeline,
  type TimelineDoc,
} from "@/lib/editor";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const cases = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "samples", "timeline_doc_cases.json"),
    "utf8",
  ),
) as {
  cases: {
    name: string;
    valid: boolean;
    doc: unknown;
    /** asset id → its kind in the project's organization, or "other_org". */
    assets?: Record<string, string>;
  }[];
};

/** The files a case's member could read: their own organization's only. */
function readable(assets: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(assets).filter(([, kind]) => kind !== "other_org"),
  );
}

function start(): TimelineDoc {
  return newDocForAsset({ id: A, durationS: 10, width: 1920, height: 1080 })!;
}

describe("validateTimeline agrees with modules/timeline.py", () => {
  it.each(cases.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    let problems = validateTimeline(c.doc);
    // A case with files is judged on them too, as the save route does.
    if (!problems.length && c.assets)
      problems = docAssetProblems(c.doc as TimelineDoc, readable(c.assets));
    expect(problems.length === 0, problems.join("; ")).toBe(c.valid);
  });

  it("speed bounds are the renderer's", () => {
    expect([SPEED_MIN, SPEED_MAX]).toEqual([0.5, 2]);
    expect(SPEEDS[0]).toBe(SPEED_MIN);
    expect(SPEEDS[SPEEDS.length - 1]).toBe(SPEED_MAX);
  });
});

describe("a new project", () => {
  it("is the whole video with its sound, in the video's orientation", () => {
    const doc = start();
    expect(validateTimeline(doc)).toEqual([]);
    expect(doc.tracks[0].clips[0]).toMatchObject({
      asset_id: A,
      in_s: 0,
      out_s: 10,
      speed: 1,
      audio: true,
    });
    expect([doc.width, doc.height]).toEqual([1920, 1080]);
    expect(
      newDocForAsset({ id: A, durationS: 5, width: 720, height: 1280 }),
    ).toMatchObject({ width: 1080, height: 1920 });
    expect(
      newDocForAsset({ id: A, durationS: 5, width: 500, height: 500 }),
    ).toMatchObject({ width: 1080, height: 1080 });
  });

  it("refuses a video with no known length, and caps one longer than an export", () => {
    expect(
      newDocForAsset({ id: A, durationS: null, width: 1, height: 1 }),
    ).toBeNull();
    expect(
      newDocForAsset({ id: A, durationS: 0, width: 1, height: 1 }),
    ).toBeNull();
    expect(
      newDocForAsset({ id: A, durationS: 99999, width: 1, height: 1 })!
        .tracks[0].clips[0].out_s,
    ).toBe(EXPORT_MAX_S);
  });
});

describe("trim", () => {
  it("clamps to the source and keeps a minimum length, rippling the clips after it", () => {
    let m = addClip(toModel(start()), { id: B, durationS: 4 });
    m = trimClip(m, "c1", "in", 2, 10);
    m = trimClip(m, "c1", "out", 99, 10);
    expect(m.clips[0]).toMatchObject({ in_s: 2, out_s: 10 });
    expect(m.clips[1].start_s).toBe(8);
    m = trimClip(m, "c1", "in", 9.99, 10);
    expect(m.clips[0].in_s).toBeCloseTo(9.9, 6);
    m = trimClip(m, "c1", "in", -5, 10);
    expect(m.clips[0].in_s).toBe(0);
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });
});

describe("split", () => {
  it("cuts at the playhead and continues the source at the clip's speed", () => {
    let m = setSpeed(toModel(start()), "c1", 2); // 0..10 s of source over 5 s
    expect(canSplit(m, "c1", 2)).toBe(true);
    const out = splitClip(m, "c1", 2)!;
    m = out.model;
    expect(
      m.clips.map((c) => [c.id, c.in_s, c.out_s, c.speed, c.audio]),
    ).toEqual([
      ["c1", 0, 4, 2, true],
      [out.newId, 4, 10, 2, true],
    ]);
    expect(modelDuration(m)).toBe(5);
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });

  it("refuses the edges and a point outside the clip", () => {
    const m = toModel(start());
    for (const t of [0, 10, 11, 0.05, 9.95])
      expect(canSplit(m, "c1", t), String(t)).toBe(false);
    expect(splitClip(m, "c1", 10)).toBeNull();
  });

  it("stops at the clip cap (each clip's sound is one more input of the mix)", () => {
    let m = toModel(
      newDocForAsset({ id: A, durationS: 1000, width: 1, height: 1 })!,
    );
    // Keep cutting a second off the end of the first (long) clip.
    for (let i = 1; i < MAX_EDITOR_CLIPS; i += 1)
      m = splitClip(m, m.clips[0].id, clipEnd(layout(m.clips)[0]) - 1)!.model;
    expect(m.clips).toHaveLength(MAX_EDITOR_CLIPS);
    expect(canSplit(m, m.clips[0].id, 0.5)).toBe(false);
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });
});

describe("speed and sound", () => {
  it("speeds change the clip's length on the timeline, clamped to 0.5–2", () => {
    let m = addClip(toModel(start()), { id: B, durationS: 4 });
    m = setSpeed(m, "c1", 0.5);
    expect(clipEnd(layout(m.clips)[0])).toBe(20);
    expect(layout(m.clips)[1].start_s).toBe(20);
    expect(setSpeed(m, "c1", 9).clips[0].speed).toBe(2);
    expect(setSpeed(m, "c1", 0.1).clips[0].speed).toBe(0.5);
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });

  it("the clip's sound is a switch", () => {
    const m = setClipAudio(toModel(start()), "c1", false);
    expect(toDoc(m).tracks[0].clips[0].audio).toBe(false);
  });

  it("clips laid end to end never overlap, whatever the rounding", () => {
    let m = toModel(start());
    const odd = [0.75, 1.25, 1.5, 0.5, 2, 1.333, 0.777];
    for (let i = 0; i < 20; i += 1) {
      m = addClip(m, { id: B, durationS: 1.001 + i * 0.137 });
      m = setSpeed(m, m.clips[m.clips.length - 1].id, odd[i % odd.length]);
    }
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });

  it("move and delete keep the picture contiguous, and the last clip stays", () => {
    let m = addClip(toModel(start()), { id: B, durationS: 4 });
    m = moveClip(m, m.clips[1].id, -1);
    expect(m.clips.map((c) => c.asset_id)).toEqual([B, A]);
    expect(m.clips[1].start_s).toBe(4);
    m = removeClip(m, m.clips[0].id);
    expect(m.clips[0].start_s).toBe(0);
    expect(removeClip(m, m.clips[0].id)).toBe(m);
  });
});

describe("text", () => {
  it("each text is its own layer, so two may share time", () => {
    let m = toModel(start());
    const a = addText(m, 1, "Title")!;
    m = a.model;
    const b = addText(m, 2, "Subtitle")!;
    m = b.model;
    const doc = toDoc(m);
    expect(doc.tracks.filter((t) => t.kind === "T")).toHaveLength(2);
    expect(validateTimeline(doc)).toEqual([]);
    expect(toModel(doc).texts.map((t) => t.text)).toEqual([
      "Title",
      "Subtitle",
    ]);
  });

  it("keeps text within bounds: length, size, start before end", () => {
    let m = addText(toModel(start()), 0, "x")!.model;
    const id = m.texts[0].id;
    m = updateText(m, id, {
      text: "y".repeat(MAX_TEXT + 50),
      size: 9999,
      start_s: 5,
      end_s: 1,
    });
    const t = m.texts[0];
    expect(t.text).toHaveLength(MAX_TEXT);
    expect(t.size).toBe(200);
    expect(t.end_s).toBeGreaterThan(t.start_s);
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });

  it("an empty text is flagged before it can fail a save", () => {
    let m = addText(toModel(start()), 0, "x")!.model;
    m = updateText(m, m.texts[0].id, { text: "  " });
    expect(textWarnings(m)).toEqual({ [m.texts[0].id]: "empty" });
    expect(validateTimeline(toDoc(m)).length).toBeGreaterThan(0);
  });

  it("text that would inject into a filter graph is just text in the document", () => {
    const hostile = "a'b,c;[0:v]subtitles=/etc/passwd{\\fs900}";
    const m = addText(toModel(start()), 0, hostile)!.model;
    const doc = toDoc(m);
    expect(validateTimeline(doc)).toEqual([]);
    expect(doc.tracks.find((t) => t.kind === "T")!.clips[0].text).toBe(hostile);
  });

  it("stops at the text cap", () => {
    let m = toModel(start());
    for (let i = 0; i < MAX_EDITOR_TEXTS; i += 1)
      m = addText(m, i * 0.1, `t${i}`)!.model;
    expect(addText(m, 0, "one more")).toBeNull();
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });
});

describe("the preview's clock", () => {
  it("maps timeline time to the source through speed", () => {
    let m = addClip(setSpeed(toModel(start()), "c1", 2), {
      id: B,
      durationS: 4,
    });
    m = trimClip(m, m.clips[1].id, "in", 1, 4);
    expect(clipAt(m, 1)).toMatchObject({ index: 0, sourceS: 2 });
    expect(clipAt(m, 5.5)).toMatchObject({ index: 1, sourceS: 1.5 });
    expect(clipAt(m, 99)).toBeNull();
    expect(formatTime(83.46)).toBe("1:23.4");
  });
});

describe("words", () => {
  it("maps the database's refusals", () => {
    expect(
      mapEditorError({ code: "NS409", message: "stale_revision" }),
    ).toEqual({ error: "stale_revision", status: 409 });
    expect(
      mapEditorError({ code: "NS409", message: "export_in_progress" }),
    ).toEqual({ error: "export_in_progress", status: 409 });
    expect(mapEditorError({ code: "NS429", message: "daily_limit" })).toEqual({
      error: "daily_limit",
      status: 429,
    });
    expect(mapEditorError({ code: "NS400", message: "invalid_asset" })).toEqual(
      { error: "invalid_asset", status: 400 },
    );
    expect(mapEditorError({ code: "NS400", message: "<script>" })).toEqual({
      error: "bad_request",
      status: 400,
    });
    expect(mapEditorError({ code: "P0002", message: "not_found" })).toEqual({
      error: "not_found",
      status: 404,
    });
    expect(mapEditorError({ code: "42501" })).toEqual({
      error: "forbidden",
      status: 403,
    });
    expect(mapEditorError({ code: "PGRST202" })).toEqual({
      error: "not_available",
      status: 503,
    });
    expect(mapEditorError({ code: "XX000", message: "boom" })).toEqual({
      error: "failed",
      status: 502,
    });
    expect(editorErrorWord("nope")).toBe("failed");
  });

  it("shapes exports and never invents a reason", () => {
    const rows = coerceExports([
      {
        id: "e1",
        rev: 2,
        status: "failed",
        reason: "render_failed",
        duration_s: "12.5",
        asset_id: null,
      },
      {
        id: "e2",
        rev: 2,
        status: "failed",
        reason: "ffmpeg said /x",
        duration_s: null,
      },
      { id: "e3", rev: 2, status: "weird" },
      { status: "done" },
    ]);
    expect(rows.map((r) => [r.id, r.reason, r.durationS])).toEqual([
      ["e1", "render_failed", 12.5],
      ["e2", "other", null],
    ]);
  });

  it("cleans a title the way the database does", () => {
    expect(parseTitle("  My\n\tedit ")).toEqual({ ok: true, value: "My edit" });
    expect(parseTitle("   ").ok).toBe(false);
    expect(parseTitle("x".repeat(121)).ok).toBe(false);
  });

  it("lists every asset a document names", () => {
    const m = addClip(toModel(start()), { id: B.toUpperCase(), durationS: 4 });
    expect(docAssetIds(toDoc(m))).toEqual([A, B]);
  });
});
