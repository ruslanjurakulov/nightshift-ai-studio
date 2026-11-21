// @vitest-environment jsdom
/**
 * #434 drafts store `toDoc(model)`: overlays must come back out of one exactly,
 * and a draft whose overlay is not renderable is dropped like any invalid one.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { allowDraftWrites, readDraft, writeDraft } from "@/lib/editor-draft";
import {
  newDocForAsset,
  toDoc,
  toModel,
  validateTimeline,
  type TimelineDoc,
} from "@/lib/editor";
import { addOverlay, updateOverlay } from "@/lib/editorOverlay";

const A = "11111111-1111-4111-8111-111111111111";
const PIC = "33333333-3333-4333-8333-333333333333";

function docWithOverlays(): TimelineDoc {
  let m = toModel(newDocForAsset({ id: A, durationS: 10, width: 1920, height: 1080 })!);
  const r = addOverlay(m, { id: PIC, kind: "image", durationS: null }, 2)!;
  m = updateOverlay(r.model, r.id, { x: 0.8, y: 0.2, w: 0.25, opacity: 0.6 });
  return toDoc(m);
}

beforeEach(() => {
  localStorage.clear();
  allowDraftWrites();
});

describe("a draft with overlays", () => {
  it("is read back as the same document, which is still valid", () => {
    const doc = docWithOverlays();
    expect(writeDraft("u", "p", 4, { title: "T", doc }, 1000)).toBe("ok");
    const back = readDraft("u", "p", 4, 2000);
    expect(back?.doc).toEqual(doc);
    expect(back?.doc.overlays).toHaveLength(1);
    expect(validateTimeline(back!.doc)).toEqual([]);
    // and through the model again: nothing is lost on Restore
    expect(toDoc(toModel(back!.doc))).toEqual(doc);
  });

  it("is dropped when an overlay would not render", () => {
    const doc = docWithOverlays();
    (doc.overlays![0] as { w: number }).w = 7;
    writeDraft("u", "p", 4, { title: "T", doc }, 1000);
    expect(readDraft("u", "p", 4, 2000)).toBeNull();
  });
});
