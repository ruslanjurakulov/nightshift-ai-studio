import { describe, expect, it } from "vitest";
import {
  confidencePct,
  evidenceLines,
  isMissingTable,
  nextStatus,
  parseDecision,
  splitLearnings,
  type LearningRow,
} from "@/lib/learnings";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

const ID = "0b8f3c1e-5a2d-4e6f-9a1b-2c3d4e5f6a7b";

function row(status: LearningRow["status"], id = ID): LearningRow {
  return {
    id,
    channel_id: "history",
    kind: "hook",
    observation: "o",
    evidence: {},
    confidence: null,
    status,
    created_at: "2026-09-20T00:00:00Z",
    decided_at: null,
    decided_by: null,
  };
}

describe("parseDecision", () => {
  it("accepts a uuid and approve/reject", () => {
    expect(parseDecision({ id: ID, decision: "approve" })).toEqual({ ok: true, id: ID, decision: "approve" });
    expect(parseDecision({ id: ` ${ID} `, decision: "reject" })).toEqual({ ok: true, id: ID, decision: "reject" });
  });
  it("rejects anything else, including a filter-looking id", () => {
    expect(parseDecision({ id: "1 or 1=1", decision: "approve" })).toEqual({ ok: false, error: "bad_id" });
    expect(parseDecision({ id: ID, decision: "pending" })).toEqual({ ok: false, error: "bad_decision" });
    expect(parseDecision(null)).toEqual({ ok: false, error: "bad_id" });
  });
});

describe("nextStatus", () => {
  it("approves only a pending proposal", () => {
    expect(nextStatus("pending", "approve")).toBe("approved");
    expect(nextStatus("approved", "approve")).toBeNull();
    // A rejected learning is never revived by a stray click.
    expect(nextStatus("rejected", "approve")).toBeNull();
  });
  it("rejects a pending one and withdraws an approved one", () => {
    expect(nextStatus("pending", "reject")).toBe("rejected");
    expect(nextStatus("approved", "reject")).toBe("rejected");
    expect(nextStatus("rejected", "reject")).toBeNull();
  });
});

describe("splitLearnings", () => {
  it("groups by status and keeps order", () => {
    const a = row("pending", "a");
    const b = row("approved", "b");
    const c = row("pending", "c");
    const d = row("rejected", "d");
    const g = splitLearnings([a, b, c, d]);
    expect(g.pending.map((r) => r.id)).toEqual(["a", "c"]);
    expect(g.approved.map((r) => r.id)).toEqual(["b"]);
    expect(g.rejected.map((r) => r.id)).toEqual(["d"]);
  });
});

describe("confidencePct", () => {
  it("keeps unknown unknown instead of showing 0%", () => {
    expect(confidencePct(null)).toBeNull();
    expect(confidencePct(undefined)).toBeNull();
    expect(confidencePct(Number.NaN)).toBeNull();
    expect(confidencePct(0.5)).toBe(50);
    expect(confidencePct(0)).toBe(0);
  });
});

describe("evidenceLines", () => {
  it("shows scalars, sizes of nested values, and null as null", () => {
    expect(
      evidenceLines({ source: "retention_points", mean_drop: 0.123456, videos: [1, 2, 3], rules: { a: 1 }, score: null }),
    ).toEqual(["source: retention_points", "mean_drop: 0.1235", "videos: [3]", "rules: {1}", "score: null"]);
    expect(evidenceLines(null)).toEqual([]);
  });
});

describe("isMissingTable", () => {
  it("recognises both Postgres and PostgREST 'no such table'", () => {
    expect(isMissingTable({ code: "42P01" })).toBe(true);
    expect(isMissingTable({ code: "PGRST205" })).toBe(true);
    expect(isMissingTable({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingTable(null)).toBe(false);
  });
});

describe("i18n", () => {
  it("has identical learnings keys in en/ru/uz", () => {
    const keys = (o: object): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v).map((s) => `${k}.${s}`) : [k])).sort();
    expect(keys(ru.learnings)).toEqual(keys(en.learnings));
    expect(keys(uz.learnings)).toEqual(keys(en.learnings));
  });
});
