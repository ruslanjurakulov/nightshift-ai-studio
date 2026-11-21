/**
 * Chroma key on overlays and noise reduction / loudness on a clip's sound
 * (modules/timeline.py CHROMA_*, denoise, loudnorm). Shared cases
 * (samples/timeline_doc_cases.json) are judged by both validators in
 * editor-timeline.test.ts; this pins the constants, the strictness and the
 * round trip through the model.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHROMA_BLEND_DEFAULT,
  CHROMA_BLEND_MAX,
  CHROMA_SIMILARITY_DEFAULT,
  CHROMA_SIMILARITY_MAX,
  CHROMA_SIMILARITY_MIN,
  toDoc,
  toModel,
  validateTimeline,
  type TimelineDoc,
} from "@/lib/editor";

const A = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";

function doc(parts: {
  overlay?: Record<string, unknown>;
  sound?: Record<string, unknown>;
  clip?: Record<string, unknown>;
}): TimelineDoc {
  const d: TimelineDoc = {
    version: 1,
    width: 1280,
    height: 720,
    fps: 30,
    tracks: [
      { id: "v1", kind: "V", clips: [{ id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 4, ...parts.clip }] },
    ],
  };
  if (parts.sound)
    d.tracks.push({
      id: "a1",
      kind: "A",
      clips: [{ id: "m1", asset_id: S, start_s: 0, in_s: 0, out_s: 3, ...parts.sound }],
    });
  if (parts.overlay)
    d.overlays = [{ id: "o1", asset_id: A, start_s: 1, end_s: 3, ...parts.overlay }];
  return d;
}

describe("the constants are the backend's", () => {
  it("chroma limits", () => {
    const py = readFileSync(join(__dirname, "..", "..", "modules", "timeline.py"), "utf8");
    expect(
      /CHROMA_SIMILARITY_MIN, CHROMA_SIMILARITY_MAX, CHROMA_SIMILARITY_DEFAULT = ([\d.]+), ([\d.]+), ([\d.]+)/
        .exec(py)!.slice(1).map(Number),
    ).toEqual([CHROMA_SIMILARITY_MIN, CHROMA_SIMILARITY_MAX, CHROMA_SIMILARITY_DEFAULT]);
    expect(/CHROMA_BLEND_MAX, CHROMA_BLEND_DEFAULT = ([\d.]+), ([\d.]+)/.exec(py)!.slice(1).map(Number)).toEqual([
      CHROMA_BLEND_MAX,
      CHROMA_BLEND_DEFAULT,
    ]);
  });
});

describe("an overlay's chroma key", () => {
  const v = (chroma: unknown) => validateTimeline(doc({ overlay: { chroma } })).join(";");
  it("is a whole colour with optional similarity and blend inside their ranges", () => {
    expect(v({ color: "#00FF00" })).toBe("");
    expect(v({ color: "#00ff00", similarity: 0.01, blend: 0 })).toBe("");
    expect(v({ color: "#00FF00", similarity: 0.6, blend: 0.5 })).toBe("");
    for (const bad of ["green", "#0F0", "#00FF000", "00FF00", "#00FF00\n", "", null, 255])
      expect(v({ color: bad }), String(bad)).toContain("color must be a #RRGGBB");
    for (const bad of [0.009, 0.61, NaN, "0.2", null])
      expect(v({ color: "#00FF00", similarity: bad }), String(bad)).toContain("similarity must be");
    for (const bad of [-0.01, 0.51, true])
      expect(v({ color: "#00FF00", blend: bad }), String(bad)).toContain("blend must be");
  });
  it("is strict about its shape", () => {
    expect(v({ similarity: 0.2 })).toContain("color is missing");
    expect(v({ color: "#00FF00", spill: 1 })).toContain("spill is not a known field");
    for (const bad of ["#00FF00", [], null, 1]) expect(v(bad)).toContain("must be an object");
  });
  it("survives the model", () => {
    const chroma = { color: "#00FF00", similarity: 0.3, blend: 0.2 };
    expect(toDoc(toModel(doc({ overlay: { chroma } }))).overlays![0]).toMatchObject({ chroma });
    expect(JSON.stringify(toDoc(toModel(doc({ overlay: {} }))))).not.toContain("chroma");
  });
});

describe("denoise and loudnorm", () => {
  it("are booleans on a sound and on a video clip", () => {
    for (const key of ["denoise", "loudnorm"]) {
      expect(validateTimeline(doc({ sound: { [key]: true } }))).toEqual([]);
      expect(validateTimeline(doc({ clip: { [key]: true, audio: true } }))).toEqual([]);
      for (const bad of [1, "yes", null])
        for (const d of [doc({ sound: { [key]: bad } }), doc({ clip: { [key]: bad } })])
          expect(validateTimeline(d).join(";"), `${key}=${String(bad)}`).toContain(`${key} must be true or false`);
    }
  });
  it("survive the model for sounds and for video clips, and false adds nothing", () => {
    const d = doc({ sound: { denoise: true, loudnorm: true }, clip: { audio: true, loudnorm: true } });
    const m = toModel(d);
    expect(m.sounds[0]).toMatchObject({ denoise: true, loudnorm: true });
    expect(m.clips[0]).toMatchObject({ audio: true, loudnorm: true });
    const back = toDoc(m);
    expect(back.tracks.find((t) => t.kind === "A")!.clips[0]).toMatchObject({ denoise: true, loudnorm: true });
    expect(back.tracks[0].clips[0]).toMatchObject({ loudnorm: true });
    expect(validateTimeline(back)).toEqual([]);
    const off = toDoc(toModel(doc({ sound: { denoise: false, loudnorm: false }, clip: { denoise: false } })));
    expect(JSON.stringify(off)).not.toMatch(/denoise|loudnorm/);
  });
});
