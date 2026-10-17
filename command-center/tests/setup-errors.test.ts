import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { setupFailureText } from "../lib/setup-errors";

/** What the Providers board, the routing panel and the Add-channel wizard say when a secret or variable write fails. */
describe.each([
  ["en", en],
  ["ru", ru],
  ["uz", uz],
])("setupFailureText (%s)", (_loc, t) => {
  const FALLBACK = "fallback sentence";
  it("maps each stable error code to its own sentence", () => {
    expect(setupFailureText(t, { error: "mfa_recent_required" }, FALLBACK)).toBe(t.mfa.recentRequired);
    expect(setupFailureText(t, { error: "mfa_enrol_required" }, FALLBACK)).toBe(t.mfa.enrolRequired);
    expect(setupFailureText(t, { error: "rate_limited" }, FALLBACK)).toBe(t.providers.rateLimited);
    const bad = setupFailureText(t, { error: "bad_value", name: "RESEND_API_KEY", reason: "bad_shape" }, FALLBACK);
    expect(bad).toContain("RESEND_API_KEY");
    expect(bad).not.toContain("{name}");
    expect(bad).not.toContain("bad_shape");
    const sentences = new Set(
      ["mfa_recent_required", "mfa_enrol_required", "rate_limited"].map((error) => setupFailureText(t, { error }, FALLBACK)),
    );
    expect(sentences.size).toBe(3);
    for (const s of sentences) expect(s.length).toBeGreaterThan(10);
  });
  it("anything else, or no body, is the caller's fallback", () => {
    expect(setupFailureText(t, { error: "github_write_failed" }, FALLBACK)).toBe(FALLBACK);
    expect(setupFailureText(t, {}, FALLBACK)).toBe(FALLBACK);
    expect(setupFailureText(t, null, FALLBACK)).toBe(FALLBACK);
  });
  it("shows only a NAME: a bad_value whose name is not an env-style name (a value, say) never reaches the screen", () => {
    for (const name of ["sk-live-abc123", "has space", "$HOME", "x".repeat(200), 42, undefined]) {
      expect(setupFailureText(t, { error: "bad_value", name }, FALLBACK)).toBe(FALLBACK);
    }
  });
});
