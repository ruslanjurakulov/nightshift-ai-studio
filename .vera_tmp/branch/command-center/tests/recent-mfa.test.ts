import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECENT_MFA_MINUTES,
  lastSecondFactorAtMs,
  parseRecentMfaMinutes,
  recentMfaDecision,
} from "../lib/security/recent-mfa";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

describe("recent second factor", () => {
  it("reads the newest totp entry of the token's amr, in ms", () => {
    expect(
      lastSecondFactorAtMs([
        { method: "password", timestamp: 1_799_999_000 },
        { method: "totp", timestamp: 1_799_990_000 },
        { method: "totp", timestamp: 1_799_995_000 },
      ]),
    ).toBe(1_799_995_000_000);
  });
  it("is null for no totp entry, junk timestamps, or no list", () => {
    expect(lastSecondFactorAtMs([{ method: "password", timestamp: 1 }])).toBeNull();
    expect(lastSecondFactorAtMs([{ method: "totp", timestamp: Number.NaN }, { method: "totp", timestamp: -4 }, { method: "totp" }])).toBeNull();
    expect(lastSecondFactorAtMs(undefined)).toBeNull();
    expect(lastSecondFactorAtMs(null)).toBeNull();
  });

  it("the window: default 8 h, clamped to 5 min .. 24 h, junk is the default", () => {
    expect(parseRecentMfaMinutes(undefined)).toBe(DEFAULT_RECENT_MFA_MINUTES);
    expect(parseRecentMfaMinutes("")).toBe(480);
    expect(parseRecentMfaMinutes("abc")).toBe(480);
    expect(parseRecentMfaMinutes("-3")).toBe(480);
    expect(parseRecentMfaMinutes("1")).toBe(5);
    expect(parseRecentMfaMinutes("60")).toBe(60);
    expect(parseRecentMfaMinutes("99999")).toBe(1440);
  });

  const base = { aal: "aal2", now: NOW, windowMinutes: 60 };
  it("off and warn never ask, whatever the age", () => {
    for (const mode of ["off", "warn"] as const) {
      expect(recentMfaDecision({ ...base, mode, lastFactorAt: NOW - 100 * 24 * 60 * MIN })).toBe("ok");
    }
  });
  it("enforce: fresh code ok, old code stale", () => {
    expect(recentMfaDecision({ ...base, mode: "enforce", lastFactorAt: NOW - 59 * MIN })).toBe("ok");
    expect(recentMfaDecision({ ...base, mode: "enforce", lastFactorAt: NOW - 61 * MIN })).toBe("stale");
  });
  it("enforce LOCKOUT SAFETY: unreadable time, a future time, aal1 or unknown level are never 'stale'", () => {
    expect(recentMfaDecision({ ...base, mode: "enforce", lastFactorAt: null })).toBe("ok");
    expect(recentMfaDecision({ ...base, mode: "enforce", lastFactorAt: NOW + 5 * MIN })).toBe("ok");
    expect(recentMfaDecision({ ...base, mode: "enforce", aal: "aal1", lastFactorAt: NOW - 1000 * MIN })).toBe("ok");
    expect(recentMfaDecision({ ...base, mode: "enforce", aal: null, lastFactorAt: NOW - 1000 * MIN })).toBe("ok");
  });
});
