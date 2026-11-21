/**
 * The library's view helpers (components/media/libraryView.ts): chips, counts,
 * search, sort, the upload kind guess, and the viewer's arrow step. Pure, so
 * pinned exactly.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW,
  compareByDate,
  countByFilter,
  guessUploadKind,
  isNarrowed,
  normalizeQuery,
  stepIndex,
  visibleAssets,
  visibleUploads,
} from "../components/media/libraryView";
import type { LibraryAsset, MediaKind, MediaUpload } from "../lib/media";

let n = 0;
function asset(kind: MediaKind, name: string | null, createdAt: string | null): LibraryAsset {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind,
    mime: kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : kind === "caption" ? "text/vtt" : "image/png",
    bytes: 1000,
    width: null,
    height: null,
    durationS: null,
    source: "upload",
    name,
    variants: [],
    version: 1,
    createdAt,
    thumbUrl: null,
    viewUrl: null,
  };
}

function upload(name: string, createdAt: string | null, status: MediaUpload["status"] = "uploaded"): MediaUpload {
  n += 1;
  return { id: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`, name, status, reason: null, bytes: 1, assetId: null, createdAt, folderId: null };
}

const sunset = asset("image", "Sunset over Tashkent.PNG", "2026-09-03T10:00:00Z");
const intro = asset("video", "intro-final.mp4", "2026-09-05T10:00:00Z");
const voice = asset("audio", "Voice over.mp3", "2026-09-01T10:00:00Z");
const subs = asset("caption", "subs.vtt", "2026-09-04T10:00:00Z");
const nameless = asset("image", null, null);
const all = [sunset, intro, voice, subs, nameless];

describe("countByFilter", () => {
  it("counts each chip; All includes captions, which have no chip of their own", () => {
    expect(countByFilter(all)).toEqual({ all: 5, image: 2, video: 1, audio: 1 });
  });
  it("is all zeros for an empty library", () => {
    expect(countByFilter([])).toEqual({ all: 0, image: 0, video: 0, audio: 0 });
  });
});

describe("visibleAssets", () => {
  it("All, newest first, nameless/dateless rows last", () => {
    expect(visibleAssets(all, DEFAULT_VIEW).map((a) => a.id)).toEqual([intro, subs, sunset, voice, nameless].map((a) => a.id));
  });

  it("oldest first still keeps rows without a date at the end", () => {
    expect(visibleAssets(all, { ...DEFAULT_VIEW, sort: "oldest" }).map((a) => a.id)).toEqual(
      [voice, sunset, subs, intro, nameless].map((a) => a.id),
    );
  });

  it("filters by kind", () => {
    expect(visibleAssets(all, { ...DEFAULT_VIEW, filter: "image" }).map((a) => a.id)).toEqual([sunset.id, nameless.id]);
    expect(visibleAssets(all, { ...DEFAULT_VIEW, filter: "video" }).map((a) => a.id)).toEqual([intro.id]);
    expect(visibleAssets(all, { ...DEFAULT_VIEW, filter: "audio" }).map((a) => a.id)).toEqual([voice.id]);
  });

  it("searches by name, case- and space-insensitive", () => {
    expect(visibleAssets(all, { ...DEFAULT_VIEW, query: "  SUNSET   over " }).map((a) => a.id)).toEqual([sunset.id]);
    expect(visibleAssets(all, { ...DEFAULT_VIEW, query: "zzz" })).toEqual([]);
  });

  it("search and kind combine", () => {
    expect(visibleAssets(all, { filter: "video", query: "voice", sort: "newest" })).toEqual([]);
    expect(visibleAssets(all, { filter: "audio", query: "voice", sort: "newest" }).map((a) => a.id)).toEqual([voice.id]);
  });

  it("a nameless asset is found by its kind label", () => {
    expect(visibleAssets(all, { ...DEFAULT_VIEW, query: "rasm" }, (k) => (k === "image" ? "Rasm" : k)).map((a) => a.id)).toEqual([
      nameless.id,
    ]);
  });

  it("does not reorder the caller's array", () => {
    const copy = [...all];
    visibleAssets(all, { ...DEFAULT_VIEW, sort: "oldest" });
    expect(all).toEqual(copy);
  });
});

describe("normalizeQuery", () => {
  it("folds case, accents and runs of spaces", () => {
    expect(normalizeQuery("  Café   Ünïcode ")).toBe("cafe unicode");
    expect(normalizeQuery("ВИДЕО")).toBe("видео");
  });
});

describe("compareByDate", () => {
  it("breaks ties by id so equal dates keep a stable order", () => {
    const a = { id: "a", createdAt: "2026-01-01T00:00:00Z" };
    const b = { id: "b", createdAt: "2026-01-01T00:00:00Z" };
    expect([b, a].sort(compareByDate("newest")).map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("treats an unparseable date like a missing one", () => {
    const a = { id: "a", createdAt: "not a date" };
    const b = { id: "b", createdAt: "2026-01-01T00:00:00Z" };
    expect([a, b].sort(compareByDate("oldest")).map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("uploads in the grid", () => {
  it("guesses a chip from the name only for display; unknown is null", () => {
    expect(guessUploadKind("IMG_0001.HEIC")).toBe("image");
    expect(guessUploadKind("clip.mov")).toBe("video");
    expect(guessUploadKind("track.m4a")).toBe("audio");
    expect(guessUploadKind("subs.srt")).toBe("caption");
    expect(guessUploadKind("notes.txt")).toBeNull();
    expect(guessUploadKind("upload")).toBeNull();
  });

  it("shows under All and under the guessed chip, newest first, and follows the search", () => {
    const a = upload("clip.mov", "2026-09-01T00:00:00Z");
    const b = upload("photo.jpg", "2026-09-02T00:00:00Z");
    const c = upload("mystery", "2026-09-03T00:00:00Z");
    expect(visibleUploads([a, b, c], DEFAULT_VIEW).map((u) => u.id)).toEqual([c.id, b.id, a.id]);
    expect(visibleUploads([a, b, c], { ...DEFAULT_VIEW, filter: "video" }).map((u) => u.id)).toEqual([a.id]);
    expect(visibleUploads([a, b, c], { ...DEFAULT_VIEW, filter: "audio" })).toEqual([]);
    expect(visibleUploads([a, b, c], { ...DEFAULT_VIEW, query: "PHOTO" }).map((u) => u.id)).toEqual([b.id]);
  });
});

describe("stepIndex (viewer arrows)", () => {
  it("moves one step and stops at both ends", () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBe(2);
    expect(stepIndex(0, -1, 3)).toBe(0);
    expect(stepIndex(1, -1, 3)).toBe(0);
  });
  it("is -1 for an empty list", () => {
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});

describe("isNarrowed", () => {
  it("is false only for All with an empty (or blank) search", () => {
    expect(isNarrowed(DEFAULT_VIEW)).toBe(false);
    expect(isNarrowed({ ...DEFAULT_VIEW, query: "   " })).toBe(false);
    expect(isNarrowed({ ...DEFAULT_VIEW, query: "x" })).toBe(true);
    expect(isNarrowed({ ...DEFAULT_VIEW, filter: "audio" })).toBe(true);
  });
});
