import { describe, expect, it } from "vitest";
import { copyText, nextFocusIndex, safeDigest } from "@/lib/feedback";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

describe("safeDigest", () => {
  it("passes through a Next digest", () => {
    expect(safeDigest("1234567890")).toBe("1234567890");
    expect(safeDigest(" abc_DEF-9 ")).toBe("abc_DEF-9");
  });

  it("never echoes something that looks like an error message or a secret-bearing URL", () => {
    expect(safeDigest("Invalid API key sk-live-abc")).toBeNull();
    expect(safeDigest("https://x.supabase.co/rest?apikey=abc")).toBeNull();
    expect(safeDigest("a".repeat(65))).toBeNull();
  });

  it("is null for a missing or non-string digest", () => {
    expect(safeDigest(undefined)).toBeNull();
    expect(safeDigest(42)).toBeNull();
    expect(safeDigest("   ")).toBeNull();
  });
});

describe("nextFocusIndex (dialog focus trap)", () => {
  it("wraps forward from the last control to the first", () => {
    expect(nextFocusIndex(2, 3, false)).toBe(0);
    expect(nextFocusIndex(0, 3, false)).toBe(1);
  });

  it("wraps backward from the first control to the last", () => {
    expect(nextFocusIndex(0, 3, true)).toBe(2);
    expect(nextFocusIndex(2, 3, true)).toBe(1);
  });

  it("pulls focus that escaped the dialog back inside", () => {
    expect(nextFocusIndex(-1, 3, false)).toBe(0);
    expect(nextFocusIndex(-1, 3, true)).toBe(2);
  });

  it("does nothing when there is nothing to focus", () => {
    expect(nextFocusIndex(-1, 0, false)).toBe(-1);
  });
});

describe("copyText", () => {
  it("reports success only when the clipboard accepted the text", async () => {
    let written = "";
    expect(await copyText("run-42", { writeText: async (s) => void (written = s) })).toBe(true);
    expect(written).toBe("run-42");
  });

  it("says it failed — so no 'Copied' toast — when the clipboard is missing or refuses", async () => {
    expect(await copyText("x", undefined)).toBe(false);
    expect(await copyText("x", null)).toBe(false);
    expect(await copyText("x", { writeText: () => Promise.reject(new Error("denied")) })).toBe(false);
  });
});

describe("ux strings", () => {
  it("exist, non-empty, in every locale", () => {
    for (const dict of [en, ru, uz]) {
      for (const key of Object.keys(en.ux) as (keyof typeof en.ux)[]) {
        expect(dict.ux[key], key).toBeTruthy();
      }
    }
  });

  it("keep the placeholders the components fill in", () => {
    for (const dict of [en, ru, uz]) {
      expect(dict.ux.copyLabel).toContain("{label}");
      expect(dict.ux.errorRef).toContain("{digest}");
    }
  });
});
