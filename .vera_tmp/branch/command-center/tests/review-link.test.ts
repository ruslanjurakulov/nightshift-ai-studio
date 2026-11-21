import { describe, expect, it } from "vitest";
import {
  REVIEW_LINK_DAYS,
  REVIEW_LINK_DEFAULT_DAYS,
  coerceReviewLinks,
  isReviewLinkId,
  isReviewToken,
  localeForLink,
  mapReviewLinkError,
  parseReviewLinkDays,
  reviewLinkPath,
  reviewLinkState,
} from "@/lib/review-link";

const ID = "11111111-2222-4333-8444-555555555555";

describe("choices", () => {
  it("offers a week by default and exactly the days the database accepts", () => {
    expect(REVIEW_LINK_DEFAULT_DAYS).toBe(7);
    expect([...REVIEW_LINK_DAYS]).toEqual([1, 3, 7, 14, 30]);
    for (const d of REVIEW_LINK_DAYS) expect(parseReviewLinkDays(d)).toBe(d);
    for (const bad of [0, 2, 8, 31, 365, -1, "7", null, undefined, 7.5, NaN]) expect(parseReviewLinkDays(bad)).toBeNull();
  });
});

describe("token and id shapes", () => {
  it("accepts only 64 lowercase hex characters as a token", () => {
    expect(isReviewToken("ab".repeat(32))).toBe(true);
    for (const bad of ["", "ab".repeat(31), "ab".repeat(33), "AB".repeat(32), `${"ab".repeat(31)}zz`, "../x", 5, null, `${"ab".repeat(32)}\n`]) {
      expect(isReviewToken(bad)).toBe(false);
    }
  });
  it("builds the path from a token and nothing else", () => {
    expect(reviewLinkPath("ab".repeat(32))).toBe(`/r/${"ab".repeat(32)}`);
  });
  it("accepts only a uuid as a link id", () => {
    expect(isReviewLinkId(ID)).toBe(true);
    for (const bad of ["", "1", `${ID}x`, "../..", null, 3]) expect(isReviewLinkId(bad)).toBe(false);
  });
  it("keeps a language by shape only, so a new language needs no code here", () => {
    for (const ok of ["en", "ru", "uz", "ar", "ur", "pt-br", " UZ "]) expect(localeForLink(ok)).toBe(ok.trim().toLowerCase());
    for (const bad of ["", "e", "english", "en_US", "x".repeat(40), "<script>", null, 5]) expect(localeForLink(bad)).toBeNull();
  });
});

describe("the owner's list", () => {
  const row = { id: ID, created_at: "2026-10-01T10:00:00Z", expires_at: "2026-10-08T10:00:00Z", revoked_at: null, views: 3, last_viewed_at: null };

  it("reads rows and drops what is malformed instead of guessing", () => {
    expect(coerceReviewLinks([row])).toEqual([
      { id: ID, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: null, views: 3, lastViewedAt: null },
    ]);
    expect(coerceReviewLinks([{ ...row, id: "x" }, { ...row, expires_at: "soon" }, null, "x", { ...row, views: -4 }])).toHaveLength(1);
    expect(coerceReviewLinks([{ ...row, views: "9" }])[0].views).toBe(0);
    expect(coerceReviewLinks(null)).toEqual([]);
    expect(coerceReviewLinks({})).toEqual([]);
  });

  it("never carries a token or a hash through, whatever the row holds", () => {
    const out = coerceReviewLinks([{ ...row, token: "ab".repeat(32), token_hash: "cd".repeat(32) }]);
    expect(JSON.stringify(out)).not.toMatch(/abab|cdcd|token/);
  });

  it("says live, expired or turned off, turned off first", () => {
    const now = Date.parse("2026-10-05T00:00:00Z");
    expect(reviewLinkState({ expiresAt: row.expires_at, revokedAt: null }, now)).toBe("live");
    expect(reviewLinkState({ expiresAt: row.expires_at, revokedAt: null }, Date.parse("2026-10-09T00:00:00Z"))).toBe("expired");
    expect(reviewLinkState({ expiresAt: row.expires_at, revokedAt: "2026-10-02T00:00:00Z" }, now)).toBe("revoked");
    expect(reviewLinkState({ expiresAt: row.expires_at, revokedAt: "2026-10-02T00:00:00Z" }, Date.parse("2026-10-09T00:00:00Z"))).toBe("revoked");
  });
});

describe("database refusals become fixed codes", () => {
  it.each([
    [{ code: "42501", message: "sign in first" }, "unauthorized"],
    [{ code: "P0002", message: "not_found" }, "not_found"],
    [{ code: "NS400", message: "no_preview" }, "no_preview"],
    [{ code: "NS400", message: "invalid_days" }, "bad_request"],
    [{ code: "NS429", message: "limit_reached" }, "limit_reached"],
    [{ code: "PGRST202", message: "Could not find the function" }, "not_available"],
    [{ code: "XX000", message: "boom with a secret" }, "failed"],
    [null, "failed"],
  ] as const)("%j -> %s", (error, code) => {
    expect(mapReviewLinkError(error)).toBe(code);
  });
});
