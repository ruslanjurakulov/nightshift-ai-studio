/** Library UX helpers: name sort, the view in the address, shift-click ranges. Pure. */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW,
  applyViewToSearch,
  parseView,
  selectRange,
  visibleAssets,
} from "../components/media/libraryView";
import type { LibraryAsset } from "../lib/media";

let n = 0;
function asset(name: string | null, day: number): LibraryAsset {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind: "image",
    mime: "image/png",
    bytes: 1,
    width: null,
    height: null,
    durationS: null,
    source: "upload",
    name,
    variants: [],
    version: 1,
    createdAt: `2026-09-${String(day).padStart(2, "0")}T10:00:00Z`,
    thumbUrl: null,
    viewUrl: null,
  };
}

describe("sort by name", () => {
  it("is natural, accent- and case-insensitive; nameless files sort by their kind word", () => {
    const list = [asset("clip 10.png", 1), asset("Clip 2.png", 2), asset("béta.png", 3), asset("alpha.png", 4), asset(null, 5)];
    const out = visibleAssets(list, { ...DEFAULT_VIEW, sort: "name" }, () => "Picture").map((a) => a.name);
    expect(out).toEqual(["alpha.png", "béta.png", "Clip 2.png", "clip 10.png", null]);
  });
  it("ties go newest first", () => {
    const a = asset("same.png", 1);
    const b = asset("same.png", 9);
    expect(visibleAssets([a, b], { ...DEFAULT_VIEW, sort: "name" }).map((x) => x.id)).toEqual([b.id, a.id]);
  });
});

describe("the view in the address", () => {
  it("parses kind, q and sort; anything unknown falls back to the default", () => {
    expect(parseView(new URLSearchParams("kind=video&q=intro&sort=name"))).toEqual({ filter: "video", query: "intro", sort: "name" });
    expect(parseView(new URLSearchParams("kind=caption&sort=sideways"))).toEqual(DEFAULT_VIEW);
    expect(parseView({ kind: ["audio", "image"], q: "x" })).toEqual({ filter: "audio", query: "x", sort: "newest" });
    expect(parseView({}).query).toBe("");
  });
  it("keeps the query short and free of control characters", () => {
    expect(parseView({ q: "a\u0000b".repeat(100) }).query.length).toBeLessThanOrEqual(80);
    expect(parseView({ q: "a\u0000b" }).query).toBe("ab");
  });
  it("writes only non-default parts and leaves other keys alone", () => {
    expect(applyViewToSearch("", DEFAULT_VIEW)).toBe("");
    expect(applyViewToSearch("?x=1&kind=audio", DEFAULT_VIEW)).toBe("?x=1");
    expect(applyViewToSearch("?x=1", { filter: "image", query: "a b", sort: "name" })).toBe("?x=1&kind=image&q=a+b&sort=name");
    expect(parseView(new URLSearchParams(applyViewToSearch("", { filter: "video", query: "ünï", sort: "oldest" })))).toEqual({
      filter: "video",
      query: "ünï",
      sort: "oldest",
    });
  });
});

describe("selectRange", () => {
  const order = ["a", "b", "c", "d", "e"];
  it("takes everything between the anchor and the click, either direction", () => {
    expect(selectRange(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(selectRange(order, "d", "b")).toEqual(["b", "c", "d"]);
  });
  it("without an anchor (or one that left the grid) it is just the clicked file", () => {
    expect(selectRange(order, null, "c")).toEqual(["c"]);
    expect(selectRange(order, "zzz", "c")).toEqual(["c"]);
    expect(selectRange(order, "a", "zzz")).toEqual([]);
  });
});
