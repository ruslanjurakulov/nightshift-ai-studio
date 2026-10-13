import { describe, expect, it } from "vitest";
import { coerceExports } from "@/lib/editor";

const snake = {
  id: "e1",
  rev: 3,
  status: "done",
  reason: null,
  duration_s: 12.5,
  asset_id: "00000000-0000-4000-8000-000000000001",
  created_at: "2026-10-13T10:00:00Z",
  finished_at: "2026-10-13T10:01:00Z",
};

describe("coerceExports reads both shapes of an export row", () => {
  it("the database's snake_case rows (the server's read)", () => {
    expect(coerceExports([snake])).toEqual([
      { id: "e1", rev: 3, status: "done", reason: null, durationS: 12.5, assetId: snake.asset_id, createdAt: snake.created_at, finishedAt: snake.finished_at },
    ]);
  });

  it("its own camelCase output (what GET /api/editor/projects/:id sends and the page's poll re-reads): nothing is lost", () => {
    const once = coerceExports([snake]);
    expect(coerceExports(once)).toEqual(once);
    expect(coerceExports(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("a polled, finished export keeps its file, length and times", () => {
    const [e] = coerceExports(JSON.parse(JSON.stringify(coerceExports([snake]))));
    expect(e.assetId).toBe(snake.asset_id);
    expect(e.durationS).toBe(12.5);
    expect(e.createdAt).toBe(snake.created_at);
    expect(e.finishedAt).toBe(snake.finished_at);
  });

  it("still drops rows without an id or with an unknown status, and non-arrays", () => {
    expect(coerceExports([{ status: "done" }, { id: "x", status: "weird" }])).toEqual([]);
    expect(coerceExports(null)).toEqual([]);
  });
});
