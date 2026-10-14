/** The blurred-background fit: `fit: "blur"` is on the document's closed list
 *  (modules/timeline.py FITS) and the model keeps it. Shared cases in
 *  samples/timeline_doc_cases.json are judged by editor-timeline.test.ts. */
import { describe, expect, it } from "vitest";
import { toDoc, toModel, validateTimeline, type TimelineDoc } from "@/lib/editor";

const A = "11111111-1111-4111-8111-111111111111";
const doc = (fit: unknown): TimelineDoc => ({
  version: 1,
  width: 1280,
  height: 720,
  fps: 30,
  tracks: [
    { id: "v1", kind: "V", clips: [{ id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 4, fit }] },
  ],
});

describe("fit: blur", () => {
  it("is valid beside contain and cover, and nothing else is", () => {
    for (const ok of ["contain", "cover", "blur"])
      expect(validateTimeline(doc(ok)), ok).toEqual([]);
    for (const bad of ["Blur", "blur ", "stretch", "", null, 1, ["blur"]])
      expect(validateTimeline(doc(bad)).join(";"), String(bad)).toContain("fit must be");
  });
  it("survives toModel and toDoc", () => {
    const m = toModel(doc("blur"));
    expect(m.clips[0].fit).toBe("blur");
    expect(toDoc(m).tracks[0].clips[0].fit).toBe("blur");
  });
});
