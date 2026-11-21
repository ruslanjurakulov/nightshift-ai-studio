/**
 * Entrance / exit animations of texts and overlays (modules/timeline.py
 * ANIM_*): the closed lists and limits are the backend's, the validator says
 * no to everything the worker would, and the model keeps the fields through a
 * round trip (so opening and saving a document never drops them). The shared
 * cases (samples/timeline_doc_cases.json) are judged by both validators in
 * editor-timeline.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANIM_DEFAULT_S,
  ANIM_IN,
  ANIM_MAX_S,
  ANIM_MIN_S,
  ANIM_OUT,
  MAX_TYPEWRITER_TEXTS,
  toDoc,
  toModel,
  validateTimeline,
  type TimelineDoc,
} from "@/lib/editor";

const A = "11111111-1111-4111-8111-111111111111";

function doc(extra: {
  text?: Record<string, unknown>;
  overlay?: Record<string, unknown>;
}): TimelineDoc {
  const d: TimelineDoc = {
    version: 1,
    width: 1280,
    height: 720,
    fps: 30,
    tracks: [
      {
        id: "v1",
        kind: "V",
        clips: [{ id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 4 }],
      },
    ],
  };
  if (extra.text)
    d.tracks.push({
      id: "t1",
      kind: "T",
      clips: [{ id: "x1", start_s: 1, end_s: 3, text: "Hi", ...extra.text }],
    });
  if (extra.overlay)
    d.overlays = [
      { id: "o1", asset_id: A, start_s: 1, end_s: 3, ...extra.overlay },
    ];
  return d;
}

describe("the animation lists and limits", () => {
  it("are the backend's closed lists", () => {
    const py = readFileSync(
      join(__dirname, "..", "..", "modules", "timeline.py"),
      "utf8",
    );
    const list = (name: string) =>
      [
        ...(
          new RegExp(`${name} = \\(([^)]*)\\)`).exec(py)![1].matchAll(/"([\w-]+)"/g)
        ),
      ].map((m) => m[1]);
    expect(list("ANIM_OUT")).toEqual([...ANIM_OUT]);
    expect([...ANIM_IN]).toEqual([...ANIM_OUT, "typewriter"]);
    const num = (n: string) =>
      Number(new RegExp(`${n} = ([\\d.]+)`).exec(py)![1]);
    expect(num("MAX_TYPEWRITER_TEXTS")).toBe(MAX_TYPEWRITER_TEXTS);
    expect(/ANIM_MIN_S, ANIM_MAX_S, ANIM_DEFAULT_S = ([\d.]+), ([\d.]+), ([\d.]+)/.exec(py)!.slice(1).map(Number)).toEqual([
      ANIM_MIN_S,
      ANIM_MAX_S,
      ANIM_DEFAULT_S,
    ]);
  });
});

describe("validateTimeline and animations", () => {
  it("accepts every name and refuses the rest", () => {
    for (const n of ANIM_IN)
      expect(validateTimeline(doc({ text: { anim_in: n } })), n).toEqual([]);
    for (const n of ANIM_OUT) {
      expect(validateTimeline(doc({ text: { anim_out: n } })), n).toEqual([]);
      expect(
        validateTimeline(doc({ overlay: { anim_in: n, anim_out: n } })),
        n,
      ).toEqual([]);
    }
    for (const bad of ["spin", "", "Fade", "fade ", "slide_up", null, 1, ["fade"]])
      for (const d of [
        doc({ text: { anim_in: bad } }),
        doc({ text: { anim_out: bad } }),
        doc({ overlay: { anim_in: bad } }),
      ])
        expect(validateTimeline(d).join(";"), String(bad)).toContain("animation");
    expect(validateTimeline(doc({ text: { anim_out: "typewriter" } })).length).toBe(1);
    expect(validateTimeline(doc({ overlay: { anim_in: "typewriter" } })).length).toBe(1);
  });

  it("holds the duration to its range and to its animation", () => {
    for (const ok of [0.1, 0.4, 2])
      expect(validateTimeline(doc({ text: { anim_in: "fade", anim_in_s: ok } }))).toEqual([]);
    for (const bad of [0, 0.099, 2.001, -1, NaN, Infinity, "1", null])
      expect(
        validateTimeline(doc({ text: { anim_in: "fade", anim_in_s: bad } })).length,
        String(bad),
      ).toBeGreaterThan(0);
    expect(validateTimeline(doc({ text: { anim_in_s: 0.5 } })).join(";")).toContain("needs anim_in");
  });

  it("keeps in + out inside the time shown, and refuses an animation beside its own fade", () => {
    expect(
      validateTimeline(doc({ text: { anim_in: "fade", anim_in_s: 1, anim_out: "fade", anim_out_s: 1 } })),
    ).toEqual([]);
    expect(
      validateTimeline(doc({ text: { anim_in: "fade", anim_in_s: 1.5, anim_out: "fade", anim_out_s: 1 } })).join(";"),
    ).toContain("longer than the item is shown");
    expect(validateTimeline(doc({ text: { anim_in: "pop", fade_in_s: 0.3 } })).join(";")).toContain(
      "anim_in and fade_in_s both set",
    );
    expect(validateTimeline(doc({ text: { anim_in: "pop", fade_out_s: 0.3 } }))).toEqual([]);
  });

  it("caps the typewriter texts", () => {
    const d = doc({});
    for (let i = 0; i < MAX_TYPEWRITER_TEXTS + 1; i++)
      d.tracks.push({
        id: `t${i}`,
        kind: "T",
        clips: [{ id: `x${i}`, start_s: 0, end_s: 2, text: "t", anim_in: "typewriter" }],
      });
    expect(validateTimeline(d).join(";")).toContain("typewriter texts");
    d.tracks.pop();
    expect(validateTimeline(d)).toEqual([]);
  });

  it("does not let captions animate", () => {
    const d = doc({});
    d.captions = {
      style: { anim_in: "fade" },
      cues: [{ id: "q1", start_s: 0, end_s: 1, text: "x" }],
    };
    expect(validateTimeline(d).join(";")).toContain("anim_in is not a known field");
  });
});

describe("the model keeps the fields", () => {
  it("through toModel and toDoc, for texts and overlays", () => {
    const d = doc({
      text: { anim_in: "typewriter", anim_in_s: 0.8, anim_out: "fade", anim_out_s: 0.3 },
      overlay: { anim_in: "slide-up", anim_in_s: 0.5, anim_out: "pop" },
    });
    const back = toDoc(toModel(d));
    const text = back.tracks.find((t) => t.kind === "T")!.clips[0];
    expect(text).toMatchObject({ anim_in: "typewriter", anim_in_s: 0.8, anim_out: "fade", anim_out_s: 0.3 });
    expect(back.overlays![0]).toMatchObject({
      anim_in: "slide-up",
      anim_in_s: 0.5,
      anim_out: "pop",
      anim_out_s: ANIM_DEFAULT_S,
    });
    expect(validateTimeline(back)).toEqual([]);
  });

  it("adds nothing to a document that has none", () => {
    const back = toDoc(toModel(doc({ text: {}, overlay: {} })));
    expect(JSON.stringify(back)).not.toContain("anim_");
  });
});
