import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savedAssetComparisonInput } from "@/components/media/savedAssetComparisonInput";
import type { LibraryAsset } from "@/lib/media";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const origin = "https://studio.example.test";
const url = (id: string) => `/api/media/file/${id}/display?expires=191&sig=synthetic`;
const asset = (id: string, extra: Partial<LibraryAsset> = {}): LibraryAsset => ({
  id, kind: "image", mime: "image/png", bytes: 100, width: 80, height: 60, durationS: null,
  source: "upload", name: "Synthetic saved.png", variants: ["display"], version: 1, createdAt: null,
  viewUrl: url(id), thumbUrl: null, ...extra,
});
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(() => { throw Error("No media requests"); }); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { expect(fetchMock).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("saved asset comparison input (unwired NS-404 adapter)", () => {
  it("retains explicit pair order despite collection reorder, without mutation or inferred lineage", () => {
    const a = Object.freeze(asset(A)), b = Object.freeze(asset(B));
    const rows = Object.freeze([b, a]); const before = JSON.stringify(rows);
    expect(savedAssetComparisonInput(rows, [A, B], origin)).toEqual({ ok: true,
      left: { id: A, name: a.name, version: 1, previewUrl: url(A) },
      right: { id: B, name: b.name, version: 1, previewUrl: url(B) }, lineage: "unknown" });
    expect(JSON.stringify(rows)).toBe(before);
  });

  it.each([[], [A], [A, A], [A, B, A]].map((ids) => ({ ids })))("refuses an incomplete or duplicate pair $ids", ({ ids }) => {
    expect(savedAssetComparisonInput([asset(A), asset(B)], ids, origin)).toEqual({ ok: false, error: "invalid_pair" });
  });

  it("reports a removed asset and a non-image instead of choosing another file", () => {
    expect(savedAssetComparisonInput([asset(A)], [A, B], origin)).toEqual({ ok: false, error: "missing_asset" });
    expect(savedAssetComparisonInput([asset(A), asset(B, { kind: "video" })], [A, B], origin)).toEqual({ ok: false, error: "not_image" });
  });

  it.each([null, "", " ", 12, {}])("normalizes ordinary unavailable/malformed preview %j and uses a valid thumbnail", (viewUrl) => {
    const a = asset(A, { viewUrl: viewUrl as string | null, thumbUrl: `/api/media/file/${A}/thumb?sig=synthetic` });
    const result = savedAssetComparisonInput([a, asset(B)], [A, B], origin);
    expect(result.ok && result.left.previewUrl).toBe(a.thumbUrl);
  });

  it("keeps the pair when both previews are unavailable; normalizes blank names", () => {
    const result = savedAssetComparisonInput([asset(A, { name: " ", viewUrl: null }), asset(B, { name: null, viewUrl: null })], [A, B], origin);
    expect(result.ok && [result.left.name, result.left.previewUrl, result.right.name, result.right.previewUrl]).toEqual([null, null, null, null]);
    expect(result.ok && result.lineage).toBe("unknown");
  });

  it("preserves an accepted same-origin signed URL exactly and discards an unrelated preview URL", () => {
    const signed = origin + url(A);
    const result = savedAssetComparisonInput([asset(A, { viewUrl: signed }), asset(B, { viewUrl: "https://images.example.test/preview.png" })], [A, B], origin);
    expect(result.ok && result.left.previewUrl).toBe(signed);
    expect(result.ok && result.right.previewUrl).toBeNull();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null])("does not invent a version for invalid reported value %j", (version) => {
    expect(savedAssetComparisonInput([asset(A, { version: version as number }), asset(B)], [A, B], origin)).toEqual({ ok: false, error: "invalid_version" });
  });

  it("reports a missing origin contract without probing a URL", () => {
    expect(savedAssetComparisonInput([asset(A), asset(B)], [A, B], "")).toEqual({ ok: false, error: "invalid_origin" });
  });
});
