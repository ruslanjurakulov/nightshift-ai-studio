/**
 * The owner-rpc strings exist in en, ru and uz with the same keys and the same {fillers}, every refusal code the
 * screens can meet has a sentence in each language, and the sentence is filled from the figures the database sent
 * (an absent figure reads "unknown", never a gap or 0). What would break without these: an owner who reads an
 * English-only or empty refusal on a phone, a `{cap}` shown as the literal text, a missing cap that reads "0 credits".
 */
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { OWNER_REFUSALS } from "../lib/owner-rpc";
import { ownerFailureText, ownerRefusalText } from "../lib/owner-rpc-text";

const dicts = { en, ru, uz } as const;
const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** Every [path, text] leaf of a nested dictionary slice. */
function leaves(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}

describe("ownerRpc parity", () => {
  const source = leaves(en.ownerRpc);
  it.each(["ru", "uz"] as const)("%s has exactly the keys of en, none empty, with the same {fillers}", (loc) => {
    const got = new Map(leaves(dicts[loc].ownerRpc));
    expect([...got.keys()].sort()).toEqual(source.map(([k]) => k).sort());
    for (const [key, text] of source) {
      expect(got.get(key), `${loc}.${key}`).toBeTruthy();
      expect(fillers(got.get(key)!), `${loc}.${key} fillers`).toEqual(fillers(text));
    }
  });

  it.each(["en", "ru", "uz"] as const)("%s words every refusal code", (loc) => {
    const err = dicts[loc].ownerRpc.err as Record<string, string>;
    for (const code of OWNER_REFUSALS) expect(err[code], `${loc}.err.${code}`).toBeTruthy();
  });

  it.each(["ru", "uz"] as const)("%s does not answer a refusal in English", (loc) => {
    for (const code of OWNER_REFUSALS) {
      expect((dicts[loc].ownerRpc.err as Record<string, string>)[code]).not.toBe((en.ownerRpc.err as Record<string, string>)[code]);
    }
  });

  it("the typed word for a big price change is short enough to type on a phone, in every language", () => {
    for (const loc of ["en", "ru", "uz"] as const) expect(dicts[loc].ownerRpc.prices.bigWord.length).toBeLessThanOrEqual(12);
  });
});

describe("ownerRefusalText", () => {
  it("fills the figures the database sent, formatted for the person's language", () => {
    expect(ownerRefusalText(en, { ok: false, error: "per_call_cap", cap: 100000, requested: 250000 })).toBe(
      "One grant may give at most 100,000 credits; you asked for 250,000. Nothing was changed.",
    );
    const daily = ownerRefusalText(en, { ok: false, error: "daily_cap", granted_24h: 450000, requested: 100000, cap: 500000 });
    expect(daily).toContain("450,000");
    expect(daily).toContain("500,000");
    expect(daily).toContain("100,000");
    expect(ownerRefusalText(en, { error: "too_old", window_days: 14 })).toContain("14 days");
  });

  it("a figure the database did not send reads unknown, never 0 or a literal placeholder", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      for (const code of ["per_call_cap", "daily_cap", "too_old", "confirm_required"]) {
        const text = ownerRefusalText(dicts[loc], { error: code }, loc);
        expect(text, `${loc}.${code}`).toContain(dicts[loc].ownerRpc.err.figureUnknown);
        expect(text).not.toMatch(/\{\w+\}/);
        expect(text).not.toMatch(/\b0 /);
      }
    }
  });

  it("a big price change names the ratios and the limit", () => {
    const text = ownerRefusalText(en, { ok: false, error: "confirm_required", rate_ratio: 5, charged_ratio: 5, max_ratio: 3 });
    expect(text).toContain("×5");
    expect(text).toContain("3×");
  });

  it("a code this build does not know is shown as a refusal with that code, not as success or silence", () => {
    const text = ownerRefusalText(en, { ok: false, error: "tomorrow_new_rule" });
    expect(text).toContain("tomorrow_new_rule");
    expect(text).toContain("refused");
    expect(ownerRefusalText(en, undefined)).toContain("refused");
  });

  it("every code produces a sentence with no unfilled placeholder in every language", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      for (const code of OWNER_REFUSALS) {
        const text = ownerRefusalText(dicts[loc], { error: code, cap: 1, requested: 2, granted_24h: 3, window_days: 4, rate_ratio: 5, charged_ratio: 6, max_ratio: 3 }, loc);
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toMatch(/\{\w+\}/);
      }
    }
  });
});

describe("ownerFailureText", () => {
  const fail = (kind: "server" | "mfa" | "session" | "network" | "forbidden" | "rate_limited", data: Record<string, unknown> = {}, status = 422) => ({ kind, status, data });

  it("a refusal from the database is worded by its code", () => {
    expect(ownerFailureText(en, fail("server", { ok: false, error: "last_owner" }))).toBe(en.ownerRpc.err.last_owner);
    expect(ownerFailureText(en, fail("server", { ok: false, error: "self_change" }))).toBe(en.ownerRpc.err.self_change);
    expect(ownerFailureText(en, fail("mfa", { error: "mfa_required" }, 401))).toBe(en.ownerRpc.err.mfa_required);
    expect(ownerFailureText(en, fail("rate_limited", { ok: false, error: "rate_limited" }, 429))).toBe(en.ownerRpc.err.rate_limited);
  });

  it("an ended session and the app-layer second step keep the words every other owner button uses", () => {
    expect(ownerFailureText(en, fail("session", { error: "unauthorized" }, 401))).toBe(en.ownerTruth.sessionEnded);
    expect(ownerFailureText(en, fail("mfa", { error: "mfa_recent_required" }, 403))).toBe(en.mfa.recentRequired);
    expect(ownerFailureText(en, fail("forbidden", { error: "forbidden" }, 403))).toBe(en.ownerTruth.forbidden);
  });

  it("a dropped connection says to look at the history first when the action may have gone through", () => {
    expect(ownerFailureText(en, fail("network", {}, 0), "en", true)).toContain(en.ownerTruth.checkBeforeRetry);
    expect(ownerFailureText(en, fail("network", {}, 0), "en", false)).not.toContain(en.ownerTruth.checkBeforeRetry);
  });

  it("a server error with no code uses the plain server sentence", () => {
    expect(ownerFailureText(en, fail("server", {}, 500))).toContain(en.ownerTruth.serverError);
  });
});
