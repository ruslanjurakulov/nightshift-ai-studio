import { describe, expect, it } from "vitest";
import { BILLED_PROVIDERS } from "../lib/billing";
import {
  coerceOwnerSecurity,
  coercePriceHistory,
  coerceProviderSpend,
  coerceSecurityEvents,
  summarizeProviderSpend,
  type SpendRow,
} from "../lib/owner-reads";

/**
 * Reading what owner_security_get, owner_security_events, credit_price_history and owner_provider_spend return.
 * The rule under test is the project's: an unknown is not a zero. A document that is not the expected shape is
 * `null` (the page says "could not read"); a factor count the database could not read is unknown, not 0; a provider
 * with an unpriced row has no total; non-provider names are never added to the bills.
 */

const SECURITY = {
  ok: true,
  settings: {
    admin_aal2_required: false,
    recent_mfa_minutes: 480,
    grant_max_per_call: 100000,
    grant_max_per_24h: 500000,
    price_max_change_ratio: 3,
    reverse_window_days: 14,
    updated_at: "2026-10-18T10:00:00Z",
  },
  caller: { ok: true, why: "gate_off", gate_on: false, aal: "aal1", has_verified_factor: false, factors_readable: true },
  would_block_after_enable: true,
  admins: [
    { email: "owner@a.uz", role: "owner", bound: true, verified_factors: 2 },
    { email: "admin@a.uz", role: "admin", bound: false, verified_factors: 0 },
  ],
  factors_readable: true,
  can_enable: false,
};

describe("coerceOwnerSecurity", () => {
  it("reads the gate, the caps, the caller and the admins with their factor counts", () => {
    const s = coerceOwnerSecurity(SECURITY)!;
    expect(s.gateOn).toBe(false);
    expect([s.grantMaxPerCall, s.grantMax24h, s.priceMaxRatio, s.reverseWindowDays, s.recentMfaMinutes]).toEqual([100000, 500000, 3, 14, 480]);
    expect(s.caller).toEqual({ passes: true, why: "gate_off", aal: "aal1", hasVerifiedFactor: false });
    expect(s.wouldBlockAfterEnable).toBe(true);
    expect(s.canEnable).toBe(false);
    expect(s.admins).toEqual([
      { email: "owner@a.uz", role: "owner", bound: true, verifiedFactors: 2 },
      { email: "admin@a.uz", role: "admin", bound: false, verifiedFactors: 0 },
    ]);
  });

  it("when the factor table could not be read, the counts are unknown, not zero", () => {
    const s = coerceOwnerSecurity({ ...SECURITY, factors_readable: false, admins: [] , can_enable: false })!;
    expect(s.factorsReadable).toBe(false);
    const withRows = coerceOwnerSecurity({ ...SECURITY, factors_readable: false })!;
    expect(withRows.admins.every((a) => a.verifiedFactors === null)).toBe(true);
  });

  it("a gate that is on reads as on, and an unknown gate is not read as off", () => {
    expect(coerceOwnerSecurity({ ...SECURITY, settings: { ...SECURITY.settings, admin_aal2_required: true } })!.gateOn).toBe(true);
    expect(coerceOwnerSecurity({ ...SECURITY, settings: { ...SECURITY.settings, admin_aal2_required: undefined } })).toBeNull();
    expect(coerceOwnerSecurity({ ...SECURITY, settings: null })).toBeNull();
  });

  it("a number the database did not send is null, not 0", () => {
    const s = coerceOwnerSecurity({ ...SECURITY, settings: { admin_aal2_required: false } })!;
    expect([s.grantMaxPerCall, s.grantMax24h, s.priceMaxRatio, s.reverseWindowDays, s.recentMfaMinutes]).toEqual([null, null, null, null, null]);
  });

  it.each([null, undefined, "ok", [], { ok: false, error: "x" }, { ok: true }])("%j is not a security document", (data) => {
    expect(coerceOwnerSecurity(data)).toBeNull();
  });
});

describe("coerceSecurityEvents", () => {
  it("keeps the reason, drops the rest of the detail, and falls back to notice for an unknown severity", () => {
    const out = coerceSecurityEvents([
      { id: 5, at: "2026-10-18T10:00:00Z", kind: "credits.grant", severity: "notice", actor_email: "o@a.uz", actor_role: "authenticated", target: "org-1", detail: { reason: "welcome", idempotency_key: "g-secret-looking-key", credits: 5 } },
      { id: 4, at: "2026-10-18T09:00:00Z", kind: "roster.add", severity: "catastrophic", detail: {} },
      { id: "x", at: "bad" },
    ])!;
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: 5, at: "2026-10-18T10:00:00Z", kind: "credits.grant", severity: "notice", actorEmail: "o@a.uz", actorRole: "authenticated", target: "org-1", reason: "welcome" });
    expect(JSON.stringify(out)).not.toContain("g-secret-looking-key");
    expect(out[1].severity).toBe("notice");
  });
  it("a reply that is not a list is null (could not read), not an empty list", () => {
    expect(coerceSecurityEvents(null)).toBeNull();
    expect(coerceSecurityEvents({})).toBeNull();
    expect(coerceSecurityEvents([])).toEqual([]);
  });
});

describe("coercePriceHistory", () => {
  it("reads numeric strings, keeps null for a missing old price, and marks a direct write", () => {
    const out = coercePriceHistory([
      { id: 9, at: "2026-10-18T10:00:00Z", unit: "usd", action: "set", old_credits_per_unit: "100.00000000", old_margin: "0.2500", new_credits_per_unit: 120, new_margin: 0.25, reason: "raise", source: "rpc" },
      { id: 8, at: "2026-10-17T10:00:00Z", unit: "video_minute", action: "set", old_credits_per_unit: null, old_margin: null, new_credits_per_unit: 5, new_margin: 0, source: "direct" },
      { id: 7, at: "x", unit: "u", action: "explode" },
    ])!;
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 9, oldRate: 100, oldMargin: 0.25, newRate: 120, reason: "raise", source: "rpc" });
    expect(out[1]).toMatchObject({ id: 8, oldRate: null, oldMargin: null, newRate: 5, source: "direct" });
  });
  it("not a list is null", () => {
    expect(coercePriceHistory(undefined)).toBeNull();
  });
});

const row = (over: Partial<SpendRow>): SpendRow => ({ day: "2026-10-17", provider: "elevenlabs", usd: 1, usdPriced: 1, unpricedRows: 0, units: 1000, unit: "tts_characters", runs: 1, ...over });

describe("coerceProviderSpend", () => {
  it("lower-cases the provider, keeps a null usd as null, and keeps a row with no valid date", () => {
    const out = coerceProviderSpend([
      { day: "2026-10-17", provider: "ElevenLabs", usd: "1.5", usd_priced: 1.5, unpriced_rows: 0, units: 1200, unit: "tts_characters", runs: 2 },
      { day: null, provider: "gemini", usd: null, usd_priced: null, unpriced_rows: 3, units: null, unit: "mixed", runs: 1 },
      { provider: "" },
    ])!;
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ provider: "elevenlabs", usd: 1.5, unpricedRows: 0 });
    expect(out[1]).toMatchObject({ day: null, provider: "gemini", usd: null, usdPriced: null, unpricedRows: 3 });
  });
  it("not a list is null, an empty list is an empty list", () => {
    expect(coerceProviderSpend(null)).toBeNull();
    expect(coerceProviderSpend([])).toEqual([]);
  });
});

describe("summarizeProviderSpend", () => {
  it("adds a provider's days up when every row is priced, and names it as the Billing page does", () => {
    const s = summarizeProviderSpend([row({ day: "2026-10-16", usd: 1 }), row({ day: "2026-10-17", usd: 2.5, usdPriced: 2.5, units: 500 })]);
    expect(s.providers).toHaveLength(1);
    expect(s.providers[0]).toMatchObject({ provider: "elevenlabs", label: BILLED_PROVIDERS.find((p) => p.id === "elevenlabs")!.name, kind: "billed", usd: 3.5, atLeastUsd: 3.5, unpricedRows: 0, units: 1500, unit: "tts_characters", days: 2 });
    expect(s.billed.usd).toBe(3.5);
  });

  it("any unpriced day makes the total unknown and keeps only the priced part as 'at least', never a partial sum as the whole", () => {
    const s = summarizeProviderSpend([row({ day: "2026-10-16", usd: 4, usdPriced: 4 }), row({ day: "2026-10-17", usd: null, usdPriced: 1, unpricedRows: 2 })]);
    expect(s.providers[0].usd).toBeNull();
    expect(s.providers[0].atLeastUsd).toBe(5);
    expect(s.providers[0].unpricedRows).toBe(2);
    expect(s.billed.usd).toBeNull();
    expect(s.billed.atLeastUsd).toBe(5);
  });

  it("a provider with nothing priced has neither a total nor a floor", () => {
    const s = summarizeProviderSpend([row({ provider: "kling", usd: null, usdPriced: null, unpricedRows: 4, units: 4, unit: "video_gen_clips" })]);
    expect(s.providers[0]).toMatchObject({ usd: null, atLeastUsd: null, unpricedRows: 4 });
    expect(s.billed).toMatchObject({ usd: null, atLeastUsd: null, unpricedRows: 4 });
  });

  it("units are summed only when every day used the same unit; mixed units do not add up", () => {
    const same = summarizeProviderSpend([row({ units: 1 }), row({ day: "2026-10-18", units: 2 })]);
    expect(same.providers[0]).toMatchObject({ units: 3, unit: "tts_characters" });
    const mixed = summarizeProviderSpend([row({ unit: "gemini_input_tokens", provider: "gemini", units: 10 }), row({ unit: "gemini_output_tokens", provider: "gemini", day: "2026-10-18", units: 5 })]);
    expect(mixed.providers[0]).toMatchObject({ units: null, unit: null });
    const unknownQty = summarizeProviderSpend([row({ units: null })]);
    expect(unknownQty.providers[0]).toMatchObject({ units: null, unit: null });
  });

  it("render, stock footage and the other non-provider names are our own estimates and are never added to the bills", () => {
    const s = summarizeProviderSpend([row({ usd: 10 }), row({ provider: "render", usd: 99, usdPriced: 99 }), row({ provider: "pexels", usd: null, usdPriced: null, unpricedRows: 1 })]);
    expect(s.providers.map((p) => [p.provider, p.kind])).toEqual([
      ["elevenlabs", "billed"],
      ["render", "estimate"],
      ["pexels", "estimate"],
    ]);
    expect(s.billed.usd).toBe(10);
    expect(s.estimates.usd).toBeNull();
    expect(s.estimates.atLeastUsd).toBe(99);
  });

  it("a provider this build has no name for is shown under its own id as billed, with no label", () => {
    const s = summarizeProviderSpend([row({ provider: "fal", usd: 2 })]);
    expect(s.providers[0]).toMatchObject({ provider: "fal", label: null, kind: "billed" });
  });

  it("a row with no valid date is counted and flagged, not hidden", () => {
    const s = summarizeProviderSpend([row({ day: null, usd: 3 }), row({ day: "2026-10-17", usd: 1 })]);
    expect(s.providers[0]).toMatchObject({ usd: 4, days: 1, dateUnknown: true });
  });

  it("no rows is no providers and no total, not a $0", () => {
    const s = summarizeProviderSpend([]);
    expect(s.providers).toEqual([]);
    expect(s.billed).toEqual({ usd: null, atLeastUsd: null, unpricedRows: 0 });
  });

  it("biggest known spend first among the bills, estimates last", () => {
    const s = summarizeProviderSpend([row({ provider: "gemini", usd: 1 }), row({ provider: "kling", usd: 9 }), row({ provider: "render", usd: 500 }), row({ provider: "veo", usd: null, usdPriced: 20, unpricedRows: 1 })]);
    expect(s.providers.map((p) => p.provider)).toEqual(["veo", "kling", "gemini", "render"]);
  });
});
