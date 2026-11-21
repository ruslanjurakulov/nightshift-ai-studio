/**
 * The owner safety strings exist in en, ru and uz with the same keys and the
 * same {fillers}; and the one word "Sozlash" no longer stands for customizing
 * the dashboard, fixing a setup step and turning on 2-step sign-in at once.
 */
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";

const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const dicts = { en, ru, uz } as const;

describe("ownerSafety parity", () => {
  const keys = Object.keys(en.ownerSafety).sort();
  it.each(["ru", "uz"] as const)("%s has exactly the keys of en, none empty, with the same {fillers}", (loc) => {
    const d = dicts[loc].ownerSafety as Record<string, string>;
    expect(Object.keys(d).sort()).toEqual(keys);
    for (const k of keys) {
      const src = (en.ownerSafety as Record<string, string>)[k];
      expect(d[k], `${loc}.${k}`).toBeTruthy();
      expect(fillers(d[k]), `${loc}.${k} fillers`).toEqual(fillers(src));
    }
  });

  it("the banner has a hide label in every language", () => {
    for (const loc of ["en", "ru", "uz"] as const) expect(dicts[loc].mfa.bannerDismiss.length).toBeGreaterThan(2);
  });

  it("the sheet titles carry the object they act on", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const o = dicts[loc].ownerSafety;
      expect(o.grantTitle).toContain("{credits}");
      expect(o.grantTitle).toContain("{org}");
      expect(o.priceDeleteTitle).toContain("{name}");
      expect(o.memberRemoveTitle).toContain("{email}");
      expect(o.topupTitle).toContain("{amount}");
      expect(o.topupTitle).toContain("{provider}");
      expect(o.keyReplaceTitle).toContain("{name}");
      expect(o.factorRemoveTitle).toContain("{name}");
    }
  });
});

describe("one verb per action", () => {
  it.each(["en", "ru", "uz"] as const)("%s: customize, fix-a-step, turn on 2-step and connect-authenticator are four different labels", (loc) => {
    const d = dicts[loc];
    const labels = [d.ops.customize, d.onboarding.fix, d.mfa.bannerEnrolAction, d.security.startEnroll];
    expect(new Set(labels).size).toBe(4);
  });

  it("uz no longer uses the bare word «Sozlash» for any of those", () => {
    const labels = [uz.ops.customize, uz.onboarding.fix, uz.mfa.bannerEnrolAction, uz.security.startEnroll, uz.security.secretLabel];
    for (const l of labels) expect(l).not.toMatch(/^Sozlash/);
  });

  it("the typed word for the last 2FA factor is short enough to type on a phone", () => {
    for (const loc of ["en", "ru", "uz"] as const) expect(dicts[loc].ownerSafety.factorLastWord.length).toBeLessThanOrEqual(8);
  });
});
