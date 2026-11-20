// @vitest-environment jsdom
/**
 * Dark is the default for a visitor who never chose (owner decision for the investor demo, 2026-11-24): a new account on a light
 * system landed on the light proof sheet everywhere. What would break without these: the default turning into a saved choice (so
 * the theme key could no longer tell "never chose" from "chose dark"), an explicit "light" being overridden, or a browser with
 * storage blocked (private mode) getting no theme at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_FLASH_SCRIPT, THEME_KEY, applyTheme, resolvedTheme } from "@/lib/theme";

function runScript() {
  document.documentElement.removeAttribute("data-theme");
  new Function(NO_FLASH_SCRIPT)();
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("the theme before first paint", () => {
  it("is dark for someone who never chose, and nothing is saved", () => {
    runScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(resolvedTheme()).toBe("dark");
  });

  it("keeps an explicit light choice", () => {
    localStorage.setItem(THEME_KEY, "light");
    runScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("keeps an explicit dark choice", () => {
    localStorage.setItem(THEME_KEY, "dark");
    runScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("ignores a junk value and stays dark", () => {
    localStorage.setItem(THEME_KEY, "sepia");
    runScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("is still dark when storage throws (private mode)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    runScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("the toggle's first press from the default saves light, and the next load keeps it", () => {
    runScript();
    applyTheme(resolvedTheme() === "dark" ? "light" : "dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    runScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
