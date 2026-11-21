// @vitest-environment jsdom
/**
 * Local editor drafts (lib/editor-draft.ts): who may read one, which project
 * and revision it belongs to, what happens when storage misbehaves, and the
 * words (en/ru/uz) the resume banner uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import type { Dictionary } from "@/lib/i18n";
import {
  DRAFT_PREFIX,
  DRAFT_TTL_MS,
  clearAllEditorDrafts,
  allowDraftWrites,
  clearDraft,
  clearOtherDrafts,
  draftKey,
  hasStaleDraft,
  purgeExpiredDrafts,
  readDraft,
  writeDraft,
} from "@/lib/editor-draft";
import {
  MAX_DOC_BYTES,
  newDocForAsset,
  toDoc,
  toModel,
  type EditorAsset,
} from "@/lib/editor";

const ASSET: EditorAsset = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "video",
  name: "beach.mp4",
  durationS: 10,
  width: 1920,
  height: 1080,
  viewUrl: null,
  thumbUrl: null,
} as EditorAsset;
const doc = () => toDoc(toModel(newDocForAsset(ASSET)!));
const A = "user-a";
const B = "user-b";
const X = "project-x";
const Y = "project-y";

beforeEach(() => {
  localStorage.clear();
  allowDraftWrites();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("draft isolation", () => {
  it("round-trips for the same user, project and revision", () => {
    expect(writeDraft(A, X, 3, { title: "T", doc: doc() }, 1000)).toBe("ok");
    const d = readDraft(A, X, 3, 2000);
    expect(d?.title).toBe("T");
    expect(d?.savedAt).toBe(1000);
    expect(d?.doc).toEqual(doc());
  });

  it("a draft written by user A is never offered to user B on the same browser", () => {
    writeDraft(A, X, 3, { title: "T", doc: doc() });
    expect(readDraft(B, X, 3)).toBeNull();
    expect(hasStaleDraft(B, X, 3)).toBe(false);
  });

  it("a draft for project X is never offered to project Y", () => {
    writeDraft(A, X, 3, { title: "T", doc: doc() });
    expect(readDraft(A, Y, 3)).toBeNull();
    expect(hasStaleDraft(A, Y, 3)).toBe(false);
  });

  it("a draft based on another revision is not current, but is reported as stale", () => {
    writeDraft(A, X, 3, { title: "T", doc: doc() });
    expect(readDraft(A, X, 4)).toBeNull();
    expect(hasStaleDraft(A, X, 4)).toBe(true);
    expect(hasStaleDraft(A, X, 3)).toBe(false);
  });

  it("a copied key does not fool the reader: user, project and revision are checked inside too", () => {
    writeDraft(A, X, 3, { title: "T", doc: doc() });
    const raw = localStorage.getItem(draftKey(A, X, 3))!;
    localStorage.setItem(draftKey(B, X, 3), raw);
    localStorage.setItem(draftKey(A, Y, 3), raw);
    localStorage.setItem(draftKey(A, X, 4), raw);
    expect(readDraft(B, X, 3)).toBeNull();
    expect(readDraft(A, Y, 3)).toBeNull();
    expect(readDraft(A, X, 4)).toBeNull();
    // and the wrong ones are cleaned up rather than kept
    expect(localStorage.getItem(draftKey(B, X, 3))).toBeNull();
  });

  it("ids that contain the separator cannot collide", () => {
    expect(draftKey("a:b", "c", 1)).not.toBe(draftKey("a", "b:c", 1));
  });

  it("refuses to write without a user, a project or a revision", () => {
    expect(writeDraft("", X, 1, { title: "T", doc: doc() })).toBe("invalid");
    expect(writeDraft(A, "", 1, { title: "T", doc: doc() })).toBe("invalid");
    expect(writeDraft(A, X, -1, { title: "T", doc: doc() })).toBe("invalid");
    expect(localStorage.length).toBe(0);
    expect(readDraft("", X, 1)).toBeNull();
  });

  it("clearing one draft, the others of a project, and everything", () => {
    writeDraft(A, X, 1, { title: "T", doc: doc() });
    writeDraft(A, X, 2, { title: "T", doc: doc() });
    writeDraft(A, Y, 2, { title: "T", doc: doc() });
    writeDraft(B, X, 2, { title: "T", doc: doc() });
    clearDraft(A, X, 1);
    expect(readDraft(A, X, 2)).not.toBeNull();
    clearOtherDrafts(A, X, 2);
    expect(readDraft(A, X, 2)).not.toBeNull();
    clearOtherDrafts(A, X, null);
    expect(readDraft(A, X, 2)).toBeNull();
    expect(readDraft(A, Y, 2)).not.toBeNull();
    expect(readDraft(B, X, 2)).not.toBeNull();
    clearAllEditorDrafts();
    expect(readDraft(A, Y, 2)).toBeNull();
    expect(readDraft(B, X, 2)).toBeNull();
  });

  it("sign-out clears the drafts and an editor closing afterwards cannot write one back", () => {
    writeDraft(A, X, 1, { title: "T", doc: doc() });
    clearAllEditorDrafts();
    expect(localStorage.length).toBe(0);
    expect(writeDraft(A, X, 1, { title: "T", doc: doc() })).toBe("unavailable");
    expect(localStorage.length).toBe(0);
    allowDraftWrites(); // the next editor that opens
    expect(writeDraft(A, X, 1, { title: "T", doc: doc() })).toBe("ok");
  });

  it("only touches its own keys", () => {
    localStorage.setItem("theme", "dark");
    writeDraft(A, X, 1, { title: "T", doc: doc() });
    clearAllEditorDrafts();
    expect(localStorage.getItem("theme")).toBe("dark");
  });
});

describe("draft validity and size", () => {
  it("drops a corrupt, invalid or expired draft", () => {
    localStorage.setItem(draftKey(A, X, 1), "{not json");
    expect(readDraft(A, X, 1)).toBeNull();
    expect(localStorage.getItem(draftKey(A, X, 1))).toBeNull();

    localStorage.setItem(
      draftKey(A, X, 1),
      JSON.stringify({ v: 1, u: A, p: X, r: 1, savedAt: 1, title: "T", doc: { version: 1 } }),
    );
    expect(readDraft(A, X, 1, 2)).toBeNull();

    writeDraft(A, X, 1, { title: "T", doc: doc() }, 1000);
    expect(readDraft(A, X, 1, 1000 + DRAFT_TTL_MS + 1)).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("purges expired drafts of any user and keeps fresh ones", () => {
    writeDraft(A, X, 1, { title: "T", doc: doc() }, 1000);
    writeDraft(B, Y, 1, { title: "T", doc: doc() }, 5000);
    purgeExpiredDrafts(1000 + DRAFT_TTL_MS + 1);
    expect(readDraft(A, X, 1, 1000 + DRAFT_TTL_MS + 1)).toBeNull();
    expect(readDraft(B, Y, 1, 1000 + DRAFT_TTL_MS + 1)).not.toBeNull();
  });

  it("does not store a document the server would refuse (over the size cap)", () => {
    const big = doc();
    big.captions = { pad: "x".repeat(MAX_DOC_BYTES) };
    expect(writeDraft(A, X, 1, { title: "T", doc: big })).toBe("too_big");
    expect(localStorage.length).toBe(0);
  });
});

describe("storage that misbehaves", () => {
  it("setItem throwing (quota) is reported, never thrown", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(writeDraft(A, X, 1, { title: "T", doc: doc() })).toBe("unavailable");
  });

  it("getItem, removeItem, key and length throwing read as no draft", () => {
    writeDraft(A, X, 1, { title: "T", doc: doc() });
    const boom = () => {
      throw new Error("denied");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "key").mockImplementation(boom);
    expect(readDraft(A, X, 1)).toBeNull();
    expect(hasStaleDraft(A, X, 2)).toBe(false);
    expect(() => clearDraft(A, X, 1)).not.toThrow();
    expect(() => clearOtherDrafts(A, X, null)).not.toThrow();
    expect(() => clearAllEditorDrafts()).not.toThrow();
    expect(() => purgeExpiredDrafts()).not.toThrow();
  });

  it("window.localStorage itself throwing (blocked site data) is survived", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(writeDraft(A, X, 1, { title: "T", doc: doc() })).toBe("unavailable");
    expect(readDraft(A, X, 1)).toBeNull();
    expect(hasStaleDraft(A, X, 1)).toBe(false);
    expect(() => clearAllEditorDrafts()).not.toThrow();
  });
});

describe("the words", () => {
  const draftKeys = (d: Dictionary) =>
    Object.keys(d.editor)
      .filter((k) => k.startsWith("draft"))
      .sort();

  it("en, ru and uz carry the same draft strings, all filled in", () => {
    const dicts: Dictionary[] = [en, ru, uz];
    const base = draftKeys(en);
    expect(base).toEqual(
      [
        "draftDiscard",
        "draftFound",
        "draftKept",
        "draftOff",
        "draftRegion",
        "draftRestore",
        "draftStale",
        "draftUnusable",
      ].sort(),
    );
    for (const d of dicts) {
      expect(draftKeys(d)).toEqual(base);
      for (const k of base)
        expect(
          String((d.editor as Record<string, unknown>)[k]).trim().length,
        ).toBeGreaterThan(0);
      expect(d.editor.draftFound).toContain("{when}");
    }
    // Translated, not copied.
    expect(ru.editor.draftFound).not.toBe(en.editor.draftFound);
    expect(uz.editor.draftFound).not.toBe(en.editor.draftFound);
  });

  it("the whole editor section has the same keys in all three languages", () => {
    const keys = (d: Dictionary) => Object.keys(d.editor).sort();
    expect(keys(ru)).toEqual(keys(en));
    expect(keys(uz)).toEqual(keys(en));
  });

  it("uses a prefix no other feature owns", () => {
    expect(DRAFT_PREFIX.startsWith("ns.editor.")).toBe(true);
  });
});
