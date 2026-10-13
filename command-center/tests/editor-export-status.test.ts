/**
 * The export status panel's pure half (lib/editorExportStatus.ts) and its
 * UZ / RU / EN words: only facts the export row already carries, the poll
 * wait that grows while nothing changes, and no invented estimate.
 */
import { describe, expect, it } from "vitest";
import {
  POLL_DELAYS_MS,
  canRetry,
  elapsedSeconds,
  exportSignature,
  formatClock,
  pollDelay,
  retryPlan,
  tookSeconds,
} from "@/lib/editorExportStatus";
import { EXPORT_REASONS, coerceExports, type EditorExport } from "@/lib/editor";
import { editorExportEn } from "@/lib/i18n/editor-export/en";
import { editorExportRu } from "@/lib/i18n/editor-export/ru";
import { editorExportUz } from "@/lib/i18n/editor-export/uz";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

const row = (over: Partial<EditorExport> = {}): EditorExport => ({
  id: "e1",
  rev: 1,
  status: "queued",
  reason: null,
  durationS: 10,
  assetId: null,
  createdAt: "2026-01-01T10:00:00.000Z",
  finishedAt: null,
  ...over,
});

describe("poll wait", () => {
  it("starts quick, grows while nothing changes, and stops growing at the cap", () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(pollDelay)).toEqual([4000, 6000, 9000, 13000, 20000, 20000, 20000]);
    expect(POLL_DELAYS_MS[0]).toBe(4000);
    expect(Math.max(...POLL_DELAYS_MS)).toBe(20000);
  });
  it("never answers with a bad number", () => {
    expect(pollDelay(-3)).toBe(4000);
    expect(pollDelay(Number.NaN)).toBe(4000);
    expect(pollDelay(2.9)).toBe(9000);
  });
  it("the signature changes with a status or a file, not with the clock", () => {
    const a = exportSignature([row()]);
    expect(exportSignature([row({ createdAt: "2027-01-01T00:00:00Z" })])).toBe(a);
    expect(exportSignature([row({ status: "rendering" })])).not.toBe(a);
    expect(exportSignature([row({ status: "done", assetId: "x" })])).not.toBe(a);
    expect(exportSignature([row(), row({ id: "e2" })])).not.toBe(a);
  });
});

describe("elapsed and took", () => {
  const t0 = Date.parse("2026-01-01T10:00:00.000Z");
  it("counts whole seconds from the request, never below zero", () => {
    expect(elapsedSeconds("2026-01-01T10:00:00.000Z", t0 + 83_900)).toBe(83);
    expect(elapsedSeconds("2026-01-01T10:00:00.000Z", t0 - 5_000)).toBe(0);
  });
  it("says nothing when the request time is unknown or unreadable", () => {
    expect(elapsedSeconds(null, t0)).toBeNull();
    expect(elapsedSeconds("not a date", t0)).toBeNull();
  });
  it("took = finish - request, only when both are known", () => {
    expect(tookSeconds(row({ finishedAt: "2026-01-01T10:02:03.000Z" }))).toBe(123);
    expect(tookSeconds(row({ finishedAt: null }))).toBeNull();
    expect(tookSeconds(row({ createdAt: null, finishedAt: "2026-01-01T10:02:03.000Z" }))).toBeNull();
  });
  it("formats a clock", () => {
    expect([0, 7, 59, 60, 723, 3723, -4].map(formatClock)).toEqual(["0:00", "0:07", "0:59", "1:00", "12:03", "1:02:03", "0:00"]);
  });
});

describe("export rows", () => {
  const snake = { id: "e1", rev: 2, status: "done", reason: null, duration_s: "12.5", asset_id: "a1", created_at: "2026-01-01T10:00:00Z", finished_at: "2026-01-01T10:01:00Z" };
  const want = { id: "e1", rev: 2, status: "done", reason: null, durationS: 12.5, assetId: "a1", createdAt: "2026-01-01T10:00:00Z", finishedAt: "2026-01-01T10:01:00Z" };
  it("reads the database's rows", () => {
    expect(coerceExports([snake])).toEqual([want]);
  });
  it("reads the project route's rows too (the page's poll gets them already shaped)", () => {
    expect(coerceExports(coerceExports([snake]))).toEqual([want]);
    expect(coerceExports([want])).toEqual([want]);
  });
});

describe("retry", () => {
  it("is offered for a failure a second try can fix, not for one the edit itself causes", () => {
    for (const r of ["render_failed", "store_failed", "timed_out", "worker_lost", "other", null] as const) expect(canRetry(r)).toBe(true);
    for (const r of ["invalid_timeline", "asset_unavailable", "too_long", "project_deleted"] as const) expect(canRetry(r)).toBe(false);
  });
  it("decides every reason the database can send", () => {
    for (const r of EXPORT_REASONS) expect(typeof canRetry(r)).toBe("boolean");
  });
});

describe("retry plan", () => {
  it("retries a server-side failure whatever the version", () => {
    expect(retryPlan({ reason: "render_failed", rev: 3 }, 3)).toBe("retry");
    expect(retryPlan({ reason: null, rev: 1 }, 4)).toBe("retry");
  });
  it("asks for a change to the edit only while the saved version is still the failed one", () => {
    for (const r of ["invalid_timeline", "asset_unavailable", "too_long"] as const) {
      expect(retryPlan({ reason: r, rev: 2 }, 2)).toBe("fix");
      expect(retryPlan({ reason: r, rev: 2 }, 3)).toBe("retry");
    }
  });
  it("a deleted project has nothing to retry or fix, on any version", () => {
    expect(retryPlan({ reason: "project_deleted", rev: 2 }, 2)).toBe("deleted");
    expect(retryPlan({ reason: "project_deleted", rev: 2 }, 3)).toBe("deleted");
  });
});

describe("words", () => {
  const keys = (o: object) => Object.keys(o).sort();
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
  it("UZ, RU and EN have the same keys, none empty, and the same {placeholders}", () => {
    expect(keys(editorExportRu)).toEqual(keys(editorExportEn));
    expect(keys(editorExportUz)).toEqual(keys(editorExportEn));
    for (const k of Object.keys(editorExportEn) as (keyof typeof editorExportEn)[]) {
      for (const d of [editorExportEn, editorExportRu, editorExportUz]) expect(d[k].trim().length).toBeGreaterThan(0);
      expect(holes(editorExportRu[k])).toEqual(holes(editorExportEn[k]));
      expect(holes(editorExportUz[k])).toEqual(holes(editorExportEn[k]));
    }
  });
  it("is wired into every dictionary", () => {
    expect(en.editor.exportPanel).toBe(editorExportEn);
    expect(ru.editor.exportPanel).toBe(editorExportRu);
    expect(uz.editor.exportPanel).toBe(editorExportUz);
  });
  it("RU and UZ are really translated, and say the time left is unknown", () => {
    expect(editorExportRu.timeLeft).not.toBe(editorExportEn.timeLeft);
    expect(editorExportUz.timeLeft).not.toBe(editorExportEn.timeLeft);
    expect(editorExportEn.timeLeft).toMatch(/unknown/i);
  });
});
