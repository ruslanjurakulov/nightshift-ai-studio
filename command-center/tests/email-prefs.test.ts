import { describe, expect, it } from "vitest";
import { dictionaries } from "@/lib/i18n";
import {
  LOCALE_SYNC_KEY,
  isUnsubscribeScope,
  isUnsubscribeToken,
  localeSyncNeeded,
  parseEmailPrefs,
  weeklyFromValue,
  weeklyValue,
} from "@/lib/email-prefs";

describe("parseEmailPrefs", () => {
  it("reads what email_prefs_get answers and refuses anything else", () => {
    expect(parseEmailPrefs({ ready: true, weekly_every_days: null, locale: "ru", stored: true })).toEqual({
      ready: true,
      weeklyEveryDays: null,
      locale: "ru",
      stored: true,
    });
    expect(parseEmailPrefs({ ready: false, weekly_every_days: 14, locale: "uz", stored: false })).toMatchObject({ ready: false, weeklyEveryDays: 14, stored: false });
    for (const bad of [null, undefined, "x", [], {}, { ready: "yes" }, { ready: true, weekly_every_days: 3 }, { ready: true, weekly_every_days: "7" }]) {
      expect(parseEmailPrefs(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("a language is a code, not one of three: an odd value falls back to English instead of failing", () => {
    expect(parseEmailPrefs({ ready: true, weekly_every_days: null, locale: "ar" })?.locale).toBe("ar");
    expect(parseEmailPrefs({ ready: true, weekly_every_days: null, locale: "EN_us" })?.locale).toBe("en");
    expect(parseEmailPrefs({ ready: true, weekly_every_days: null })?.locale).toBe("en");
  });

  it("the weekly summary is off by default and the select round-trips", () => {
    expect(weeklyValue({ weeklyEveryDays: null })).toBe("0");
    expect(weeklyValue({ weeklyEveryDays: 7 })).toBe("7");
    expect(weeklyFromValue("0")).toBe(0);
    expect(weeklyFromValue("14")).toBe(14);
    for (const bad of ["", "3", "weekly", "-7", "7.5"]) expect(weeklyFromValue(bad), bad).toBeNull();
  });
});

describe("language sync", () => {
  it("tells the database once per language per browser, and only a code", () => {
    expect(LOCALE_SYNC_KEY).toMatch(/^[a-z_]+$/);
    expect(localeSyncNeeded(null, "uz")).toBe(true);
    expect(localeSyncNeeded("uz", "uz")).toBe(false);
    expect(localeSyncNeeded("uz", "ru")).toBe(true);
    expect(localeSyncNeeded(null, "")).toBe(false);
    expect(localeSyncNeeded(null, "English")).toBe(false);
  });
});

describe("the unsubscribe link's inputs", () => {
  it("accepts exactly 64 lowercase hex characters and three scopes", () => {
    expect(isUnsubscribeToken("ab".repeat(32))).toBe(true);
    for (const bad of ["", "ab".repeat(31), "AB".repeat(32), "zz".repeat(32), `${"ab".repeat(32)} `, 5, null]) expect(isUnsubscribeToken(bad)).toBe(false);
    for (const s of ["ready", "weekly", "all"]) expect(isUnsubscribeScope(s)).toBe(true);
    for (const s of ["", "READY", "everything", null, undefined]) expect(isUnsubscribeScope(s)).toBe(false);
  });
});

describe("the e-mail screens' words", () => {
  const BANNED = /openai|google|runway|kling|veo|sora|elevenlabs|replicate|fal\.ai|minimax|\b(owner|editor|viewer|admin)\b|владелец|редактор|наблюдатель|администратор|egasi|muharrir|kuzatuvchi/i;
  const PRICE = /[$€£₽]|\busd\b/i;

  it("every language has every key and really translates them", () => {
    const en = dictionaries.en;
    for (const [locale, d] of Object.entries(dictionaries)) {
      for (const section of ["emailNotifications", "unsubscribe"] as const) {
        expect(Object.keys(d[section]).sort(), `${locale}.${section}`).toEqual(Object.keys(en[section]).sort());
        const text = JSON.stringify(d[section]);
        expect(text, locale).not.toMatch(BANNED);
        expect(text, locale).not.toMatch(PRICE);
        if (locale === "en") continue;
        for (const [k, v] of Object.entries(d[section])) {
          expect(v, `${locale}.${section}.${k}`).toMatch(/\S/);
          if (k !== "openApp") expect(v, `${locale}.${section}.${k}`).not.toBe((en[section] as Record<string, string>)[k]);
        }
      }
    }
  });

  it("the weekly summary is described as off unless chosen, in every language", () => {
    for (const d of Object.values(dictionaries)) {
      expect(d.emailNotifications.weeklyHint).toMatch(/\S/);
    }
    expect(dictionaries.en.emailNotifications.weeklyHint).toMatch(/off unless you choose/i);
  });
});
