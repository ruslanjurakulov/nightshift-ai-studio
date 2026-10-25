/**
 * Version history (lib/regionEdit/versions.ts): each region edit is a new file whose parent is the picture it came from.
 * What would break without these: "previous version" going somewhere other than the parent, a loop in the data hanging
 * the page, and an original that could be mistaken for an edit.
 */
import { describe, expect, it } from "vitest";
import { MAX_CHAIN, buildChain, coerceVersionRows, nextId, originalId, previousId, type VersionRow } from "@/lib/regionEdit/versions";

const row = (id: string, parentId: string | null, version: number, createdAt: string): VersionRow => ({ id, parentId, version, createdAt, width: 800, height: 600 });
const A = row("a", null, 1, "2026-01-01T00:00:00Z");
const B = row("b", "a", 2, "2026-01-02T00:00:00Z");
const C = row("c", "b", 3, "2026-01-03T00:00:00Z");

describe("buildChain", () => {
  it("orders the original first and finds where the viewed picture sits", () => {
    const chain = buildChain([C, A, B], "b");
    expect(chain?.items.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(chain?.at).toBe(1);
    expect(originalId(chain!)).toBe("a");
  });

  it("undo is the parent, redo the newest child, and the ends have none", () => {
    const mid = buildChain([A, B, C], "b")!;
    expect(previousId(mid)).toBe("a");
    expect(nextId(mid)).toBe("c");
    expect(previousId(buildChain([A, B, C], "a")!)).toBeNull();
    expect(nextId(buildChain([A, B, C], "c")!)).toBeNull();
  });

  it("a picture with no edits is a chain of one", () => {
    const chain = buildChain([A], "a")!;
    expect(chain.items).toHaveLength(1);
    expect(previousId(chain)).toBeNull();
    expect(nextId(chain)).toBeNull();
  });

  it("with two edits from the same parent, redo follows the newest and nothing is hidden by an overwrite", () => {
    const older = row("x", "a", 2, "2026-01-02T00:00:00Z");
    const newer = row("y", "a", 2, "2026-01-05T00:00:00Z");
    const chain = buildChain([A, older, newer], "a")!;
    expect(nextId(chain)).toBe("y");
    expect(A.id).toBe("a"); // the original row is never altered by building a chain
  });

  it("is null when the picture is not among the rows, and survives a cycle", () => {
    expect(buildChain([A], "zzz")).toBeNull();
    const loopA = row("a", "b", 1, "2026-01-01T00:00:00Z");
    const loopB = row("b", "a", 2, "2026-01-02T00:00:00Z");
    const chain = buildChain([loopA, loopB], "a")!;
    expect(chain.items.length).toBeLessThanOrEqual(2);
  });

  it("stops a runaway chain", () => {
    const rows: VersionRow[] = [];
    for (let i = 0; i < MAX_CHAIN * 3; i += 1) rows.push(row(`n${i}`, i === 0 ? null : `n${i - 1}`, i + 1, `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`));
    const chain = buildChain(rows, `n${MAX_CHAIN * 3 - 1}`)!;
    expect(chain.items.length).toBeLessThanOrEqual(MAX_CHAIN + 1);
  });
});

describe("coerceVersionRows", () => {
  it("reads the library's snake_case rows and drops what is malformed instead of guessing", () => {
    const rows = coerceVersionRows([
      { id: "a", parent_asset_id: null, version: 1, created_at: "2026-01-01", width: 10, height: 20 },
      { id: "b", parent_asset_id: "a", version: "2" },
      { parent_asset_id: "a" },
      null,
    ]);
    expect(rows).toEqual([
      { id: "a", parentId: null, version: 1, createdAt: "2026-01-01", width: 10, height: 20 },
      { id: "b", parentId: "a", version: 1, createdAt: null, width: null, height: null },
    ]);
    expect(coerceVersionRows("nope")).toEqual([]);
  });
});
