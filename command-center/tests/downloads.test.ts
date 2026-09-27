import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePrices } from "@/lib/credits";
import { creditsSpent } from "@/lib/account";
import {
  availableQualities,
  coerceDownloadRequests,
  contentDisposition,
  downloadCharge,
  downloadFilePath,
  freeRedownload,
  mapDownloadError,
  nextCharge,
  parseDownloadId,
  readyRow,
  type DownloadRequestRow,
} from "@/lib/downloads";

// The defaults migration 0030 seeds.
const PRICES = parsePrices([
  { unit: "download_720p_minute", credits_per_unit: 1.0, margin: 2.0 },
  { unit: "download_1080p_minute", credits_per_unit: 1.25, margin: 3.0 },
  { unit: "download_minimum", credits_per_unit: 5, margin: 0 },
]);

const NOW = Date.parse("2026-09-27T12:00:00Z");
const DAY = 86_400_000;

function row(over: Partial<DownloadRequestRow>): DownloadRequestRow {
  return {
    id: 1,
    video_id: "v1",
    quality: "720p",
    status: "ready",
    charged: 5,
    free_reason: null,
    paid_until: new Date(NOW + 6 * DAY).toISOString(),
    reason: null,
    error: null,
    bytes: 1,
    expires_at: new Date(NOW + 3_600_000).toISOString(),
    created_at: null,
    refunded: false,
    ...over,
  };
}

describe("download pricing (mirrors request_download)", () => {
  it("charges ceil(minutes × rate × (1 + margin)), never below the minimum", () => {
    expect(downloadCharge(60, "720p", PRICES)).toBe(5); // 3 -> minimum 5
    expect(downloadCharge(60, "1080p", PRICES)).toBe(5); // 5
    expect(downloadCharge(195, "720p", PRICES)).toBe(10); // 3.25 min x 3 = 9.75 -> 10
    expect(downloadCharge(195, "1080p", PRICES)).toBe(17); // 3.25 x 5 = 16.25 -> 17
    expect(downloadCharge(600, "720p", PRICES)).toBe(30);
    expect(downloadCharge(600, "1080p", PRICES)).toBe(50);
  });

  it("higher quality never costs less", () => {
    for (const s of [30, 61, 195, 600, 1800, 3600]) {
      expect(downloadCharge(s, "1080p", PRICES)!).toBeGreaterThanOrEqual(downloadCharge(s, "720p", PRICES)!);
    }
  });

  it("float noise does not add a credit", () => {
    const p = parsePrices([{ unit: "download_720p_minute", credits_per_unit: 1.2, margin: 0 }]);
    expect(downloadCharge(100, "720p", p)).toBe(2); // 1.6667 x 1.2 = 2.0000000000000004
  });

  it("an unset price is unpriced, not free", () => {
    expect(downloadCharge(120, "720p", {})).toBeNull();
    expect(nextCharge({ quality: "720p", master: { width: 1920, height: 1080, durationSeconds: 60, bytes: 1 }, prices: {}, rows: [], exempt: false })).toBeNull();
  });

  it("the migration seeds exactly these defaults", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0030_paid_downloads.sql"), "utf8");
    expect(sql).toMatch(/\('download_720p_minute', 1\.0, 2\.0,/);
    expect(sql).toMatch(/\('download_1080p_minute', 1\.25, 3\.0,/);
    expect(sql).toMatch(/\('download_minimum', 5, 0,/);
    expect(sql).toContain("on conflict (unit) do nothing;");
  });
});

describe("qualities and idempotent re-download", () => {
  it("offers only qualities up to the master's short side", () => {
    expect(availableQualities(null)).toEqual([]);
    expect(availableQualities({ width: 1920, height: 1080, durationSeconds: 1, bytes: 1 })).toEqual(["720p", "1080p"]);
    expect(availableQualities({ width: 1080, height: 1920, durationSeconds: 1, bytes: 1 })).toEqual(["720p", "1080p"]);
    expect(availableQualities({ width: 1280, height: 720, durationSeconds: 1, bytes: 1 })).toEqual(["720p"]);
    expect(availableQualities({ width: 854, height: 480, durationSeconds: 1, bytes: 1 })).toEqual([]);
  });

  it("a paid download in the last 7 days makes the same quality free; a failed one does not", () => {
    const master = { width: 1920, height: 1080, durationSeconds: 600, bytes: 1 };
    const paid = [row({ status: "expired" })];
    expect(freeRedownload(paid, "720p", NOW)).toBe(true);
    expect(nextCharge({ quality: "720p", master, prices: PRICES, rows: paid, exempt: false, now: NOW })).toBe(0);
    expect(nextCharge({ quality: "1080p", master, prices: PRICES, rows: paid, exempt: false, now: NOW })).toBe(50);
    const old = [row({ paid_until: new Date(NOW - 1).toISOString() })];
    expect(freeRedownload(old, "720p", NOW)).toBe(false);
    const failed = [row({ status: "failed", refunded: true })];
    expect(freeRedownload(failed, "720p", NOW)).toBe(false);
    expect(nextCharge({ quality: "720p", master, prices: {}, rows: [], exempt: true })).toBe(0);
  });

  it("ready means ready and not expired", () => {
    expect(readyRow(row({}), NOW)).toBe(true);
    expect(readyRow(row({ expires_at: new Date(NOW - 1).toISOString() }), NOW)).toBe(false);
    expect(readyRow(row({ status: "processing" }), NOW)).toBe(false);
  });

  it("coerces rows defensively", () => {
    const rows = coerceDownloadRequests([
      { id: 3, video_id: "v", quality: "1080p", status: "ready", charged: "7.00", refund_txn: null },
      { id: 4, video_id: "v", quality: "4k", status: "ready" },
      { id: "x", video_id: "v", quality: "720p" },
      { id: 5, video_id: "v", quality: "720p", status: "weird", refund_txn: 12 },
    ]);
    expect(rows.map((r) => r.id)).toEqual([3, 5]);
    expect(rows[0].charged).toBe(7);
    expect(rows[1].status).toBe("failed");
    expect(rows[1].refunded).toBe(true);
  });
});

describe("serving route path safety", () => {
  it("accepts only a positive integer id", () => {
    expect(parseDownloadId("42")).toBe(42);
    for (const bad of ["0", "-1", "01", "1.5", "1e3", "../1", "1/../../etc/passwd", "%2e%2e", "", " 1", "1 ", "12345678901234567890"])
      expect(parseDownloadId(bad)).toBeNull();
    expect(parseDownloadId(undefined)).toBeNull();
  });

  it("builds <dir>/<id>.mp4 from the id alone", () => {
    expect(downloadFilePath("/data/downloads", "42")).toBe("/data/downloads/42.mp4");
    expect(downloadFilePath("/data/downloads/", 7)).toBe("/data/downloads/7.mp4");
    expect(downloadFilePath("/data/downloads", "../../etc/passwd")).toBeNull();
    expect(downloadFilePath("/data/downloads", "7/../../x")).toBeNull();
    expect(downloadFilePath("/data/downloads", -3)).toBeNull();
    expect(downloadFilePath("/data/downloads", 1.5)).toBeNull();
    expect(downloadFilePath("relative/dir", "1")).toBeNull();
    expect(downloadFilePath("/data/../etc", "1")).toBeNull();
    expect(downloadFilePath(null, "1")).toBeNull();
  });

  it("the route resolves the file by id only and checks the row through RLS first", () => {
    const src = readFileSync(join(__dirname, "..", "app", "api", "downloads", "[id]", "route.ts"), "utf8");
    expect(src).toContain("downloadFilePath(dir, id)");
    expect(src).toContain('.from("download_requests")');
    expect(src).toContain('r.status !== "ready"');
    expect(src).not.toMatch(/SERVICE|service_role/i);
    expect(src).not.toMatch(/searchParams/);
  });

  it("Content-Disposition is an attachment with a safe name", () => {
    const h = contentDisposition('Évian "quoted" / ../../name', "vid1", "1080p");
    expect(h.startsWith('attachment; filename="')).toBe(true);
    expect(h).not.toMatch(/\.\.\//);
    expect(h).not.toMatch(/filename="[^"]*"[^;]*"/);
    expect(h).toContain("filename*=UTF-8''");
    expect(contentDisposition(null, "vid1", "720p")).toContain('filename="vid1 (720p).mp4"');
    expect(contentDisposition("Тест", "vid1", "720p")).toContain('filename="vid1 (720p).mp4"');
  });
});

describe("errors and the spent total", () => {
  it("maps request_download's SQLSTATEs", () => {
    expect(mapDownloadError({ code: "NS402" })).toEqual({ error: "insufficient_credits", status: 402 });
    expect(mapDownloadError({ code: "NS404" }).error).toBe("master_not_available");
    expect(mapDownloadError({ code: "NS400" }).error).toBe("unpriced");
    expect(mapDownloadError({ code: "NS409" }).error).toBe("price_changed");
    expect(mapDownloadError({ code: "42501" }).status).toBe(403);
    expect(mapDownloadError({ code: "PGRST202" }).status).toBe(503);
    expect(mapDownloadError({ code: "XX000" }).error).toBe("failed");
  });

  it("a refunded download nets out of credits spent", () => {
    expect(
      creditsSpent(
        [
          { kind: "capture", amount: -10, job_id: "rj-1" },
          { kind: "capture", amount: -7, job_id: "download:3" },
          { kind: "refund", amount: 7, job_id: "download:3" },
          { kind: "refund", amount: -50, job_id: null },
        ],
        4,
      ),
    ).toBe(10);
  });
});
