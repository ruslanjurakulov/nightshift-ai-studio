import { describe, expect, it } from "vitest";
import { normalizeAal, needsStepUp } from "@/lib/security/aal";

describe("normalizeAal", () => {
  it("passes through the two known levels", () => {
    expect(normalizeAal("aal1")).toBe("aal1");
    expect(normalizeAal("aal2")).toBe("aal2");
  });

  it("maps anything unknown to null", () => {
    expect(normalizeAal(null)).toBeNull();
    expect(normalizeAal(undefined)).toBeNull();
    expect(normalizeAal("")).toBeNull();
    expect(normalizeAal("aal3")).toBeNull();
  });
});

describe("needsStepUp", () => {
  it("prompts a step up when aal1 but a verified factor exists", () => {
    expect(needsStepUp("aal1", true)).toBe(true);
  });

  it("stays quiet once the session is already aal2", () => {
    expect(needsStepUp("aal2", true)).toBe(false);
  });

  it("stays quiet when no verified factor exists", () => {
    expect(needsStepUp("aal1", false)).toBe(false);
  });

  it("stays quiet for an unknown level", () => {
    expect(needsStepUp(null, true)).toBe(false);
    expect(needsStepUp(undefined, true)).toBe(false);
  });
});
