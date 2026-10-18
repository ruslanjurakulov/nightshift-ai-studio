/**
 * The confirm-sheet strings exist in en, ru and uz with the same keys and the same {fillers}, the typed words are
 * short enough to type on a phone, and the sheets that name an object carry its filler.
 */
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";

const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const dicts = { en, ru, uz } as const;
const keys = Object.keys(en.confirmSheets).sort();

describe("confirmSheets parity", () => {
  it.each(["ru", "uz"] as const)("%s has exactly the keys of en, none empty, with the same {fillers}", (loc) => {
    const d = dicts[loc].confirmSheets as Record<string, string>;
    expect(Object.keys(d).sort()).toEqual(keys);
    for (const k of keys) {
      const src = (en.confirmSheets as Record<string, string>)[k];
      expect(d[k], `${loc}.${k}`).toBeTruthy();
      expect(fillers(d[k]), `${loc}.${k} fillers`).toEqual(fillers(src));
    }
  });

  it.each(["ru", "uz"] as const)("%s is translated, not copied from English", (loc) => {
    const d = dicts[loc].confirmSheets as Record<string, string>;
    // "Video" is the same word in uz.
    const same = keys.filter((k) => k !== "dVideo" && d[k] === (en.confirmSheets as Record<string, string>)[k] && /[a-z]{4}/i.test(d[k]));
    expect(same).toEqual([]);
  });

  it("the typed words are short, and different from each other, in every language", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const c = dicts[loc].confirmSheets;
      for (const w of [c.autoOnWord, c.extraOnWord]) {
        expect(w.length).toBeGreaterThan(2);
        expect(w.length).toBeLessThanOrEqual(10);
        expect(w).not.toMatch(/\s/);
      }
      expect(c.autoOnWord).not.toBe(c.extraOnWord);
    }
  });

  it("the sheets that name an object carry it", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const c = dicts[loc].confirmSheets;
      for (const k of ["autoOnTitle", "pauseTitle", "resumeTitle", "reviewOffTitle", "limitKeyTitle"] as const) expect(c[k], `${loc}.${k}`).toContain("{name}");
      for (const k of ["approveTitle", "rejectTitle"] as const) expect(c[k], `${loc}.${k}`).toContain("{video}");
      for (const k of ["rvApproveTitle", "rvRegenTitle", "rvScriptTitle"] as const) expect(c[k], `${loc}.${k}`).toContain("{title}");
      expect(c.limitPlanCeiling).toContain("{cap}");
    }
  });

  it("the auto publish and approval sheets say the consequence in plain words (en)", () => {
    expect(en.confirmSheets.autoOnBody).toContain("Videos publish without asking you");
    expect(en.confirmSheets.approveBody).toContain("This lets the video go public");
  });
});
