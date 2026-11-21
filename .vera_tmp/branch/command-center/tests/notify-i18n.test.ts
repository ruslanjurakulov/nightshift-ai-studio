import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLES,
  DEFAULT_LANGUAGE,
  NOTIFY_LANGUAGES,
  fill,
  isNotifyLanguage,
  nativeName,
  notifyText,
  resolveLanguage,
} from "../../supabase/functions/_shared/notify-i18n";
import { botWords } from "../../supabase/functions/_shared/telegram-notify";
import { LOCALES, dictionaries, isLocale } from "@/lib/i18n";
import { parseChannels } from "@/lib/notify-channels";
import { localeSyncNeeded, parseEmailPrefs } from "@/lib/email-prefs";

// The languages of the customer notifications (migration 0105): one registry, one data file per
// language, one lookup, and nothing that branches on a language. The Python side of the same
// guarantees is tests/test_notify_i18n.py; both read the same data files.

const REPO = path.resolve(process.cwd(), "..");
const DATA = path.join(REPO, "supabase/functions/_shared/notify-i18n");
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const TELEGRAM_LIMIT = 4096;

describe("the registry and its data files", () => {
  it("lists the languages once, and the Edge Function bundles are exactly those", () => {
    const registry = JSON.parse(read("supabase/functions/_shared/notify-i18n/registry.json"));
    const codes = registry.languages.map((l: { code: string }) => l.code);
    expect(NOTIFY_LANGUAGES.map((l) => l.code)).toEqual(codes);
    expect(new Set(codes).size).toBe(codes.length);
    expect(Object.keys(BUNDLES).sort()).toEqual([...codes].sort());
    expect(readdirSync(DATA).filter((f) => f !== "registry.json").map((f) => f.replace(/\.json$/, "")).sort()).toEqual([...codes].sort());
    expect(codes).toContain(DEFAULT_LANGUAGE);
    for (const l of NOTIFY_LANGUAGES) {
      expect(l.code).toMatch(/^[a-z]{2,3}$/);
      expect(l.native.trim()).not.toBe("");
    }
  });

  it("is the same set as the app's language list, the Settings pickers and the API checks", () => {
    const codes = NOTIFY_LANGUAGES.map((l) => l.code).sort();
    expect(LOCALES.map((l) => l.code).sort()).toEqual(codes);
    expect(Object.keys(dictionaries).sort()).toEqual(codes);
    for (const c of codes) expect(isLocale(c)).toBe(true);
    for (const bad of ["de", "EN", "en_US", "", "rus", "../x", "<script>"]) expect(isLocale(bad)).toBe(false);
  });

  it("is the same set as the database's allow-list (the newest migration that defines it)", () => {
    let found: string[] = [];
    for (const f of readdirSync(path.join(REPO, "supabase/migrations")).sort()) {
      const m = /function public\.notify_language_ok\(p text\)[\s\S]*?array\[([^\]]*)\]/.exec(read(`supabase/migrations/${f}`));
      if (m) found = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    }
    expect([...found].sort()).toEqual(NOTIFY_LANGUAGES.map((l) => l.code).sort());
  });

  it("gives every language exactly English's keys and {placeholders}", () => {
    const en = BUNDLES.en;
    for (const [code, table] of Object.entries(BUNDLES)) {
      expect(Object.keys(table).sort(), code).toEqual(Object.keys(en).sort());
      for (const [key, line] of Object.entries(table)) {
        expect(line.trim(), `${code}.${key}`).not.toBe("");
        expect(placeholders(line), `${code}.${key}`).toEqual(placeholders(en[key]));
        // Every brace is a plain {name}: nothing a formatter could read as syntax.
        expect(line.replace(/\{\w+\}/g, "").match(/[{}]/g), `${code}.${key}`).toBeNull();
        expect(key).toMatch(/^(meta|bot|push|mail)\.[A-Za-z_]+$/);
      }
    }
  });

  it("keeps every Telegram message inside Telegram's 4096 characters, even with the longest values", () => {
    for (const [code, table] of Object.entries(BUNDLES)) {
      for (const [key, line] of Object.entries(table)) {
        if (!/^(bot|push)\./.test(key)) continue;
        expect(fill(line, { handle: "@" + "h".repeat(64), language: "L".repeat(40) }).length, `${code}.${key}`).toBeLessThanOrEqual(TELEGRAM_LIMIT);
      }
    }
  });

  it("has every bot key the webhook asks for, and the webhook asks for every bot key (no dead words)", () => {
    const src = read("supabase/functions/_shared/telegram-notify.ts");
    const asked = new Set([...src.matchAll(/botWords\([^,()]+,\s*"(\w+)"/g)].map((m) => m[1]));
    const declared = Object.keys(BUNDLES.en).filter((k) => k.startsWith("bot.")).map((k) => k.slice(4));
    for (const key of asked) expect(declared, key).toContain(key);
    for (const key of declared) expect(src.includes(`"${key}"`) || src.includes(`${key}:`), `bot.${key} is never used`).toBe(true);
  });
});

describe("the lookup", () => {
  it("lets only a registered code select a language; anything else is English", () => {
    for (const odd of [null, undefined, 5, "", " ", "xx", "../../etc/passwd", "ru/../en", "en_US", "rus", "ру", "__proto__", "constructor", "toString"]) {
      expect(resolveLanguage(odd), String(odd)).toBe("en");
      expect(isNotifyLanguage(odd), String(odd)).toBe(false);
      expect(botWords(odd as string, "help")).toBe(BUNDLES.en["bot.help"]);
    }
    for (const l of NOTIFY_LANGUAGES) {
      expect(resolveLanguage(l.code)).toBe(l.code);
      expect(notifyText(l.code, "bot.help")).toBe(BUNDLES[l.code]["bot.help"]);
      expect(nativeName(l.code)).toBe(l.native);
    }
    expect(nativeName("xx")).toBe(nativeName("en"));
  });

  it("fills placeholders in one pass: a value is never read as a placeholder", () => {
    expect(fill("{channel}: {n}", { channel: "{n}", n: 3 })).toBe("{n}: 3");
    expect(fill("{a} {b}", { a: "x" })).toBe("x {b}");
    expect(fill("{constructor} {toString}", {})).toBe("{constructor} {toString}");
    expect(fill("{h}", { h: "a$&b" })).toBe("a$&b");
  });
});

describe("what the Settings page and the API accept", () => {
  it("shows a chat's language only when it is a registered one", () => {
    const base = { id: "0f0e0d0c-0b0a-4000-8000-000000000001", kind: "telegram", status: "active" };
    expect(parseChannels([{ ...base, locale: "uz" }])[0].locale).toBe("uz");
    for (const bad of ["de", "UZ", "uz-UZ", "", null, 5]) expect(parseChannels([{ ...base, locale: bad }])[0].locale).toBe("en");
  });
  it("reads the e-mail language and whether the person chose it", () => {
    const raw = { ready: true, weekly_every_days: null, stored: true };
    expect(parseEmailPrefs({ ...raw, locale: "ru", locale_chosen: true })).toMatchObject({ locale: "ru", localeChosen: true });
    expect(parseEmailPrefs({ ...raw, locale: "de", locale_chosen: "yes" })).toMatchObject({ locale: "en", localeChosen: false });
    expect(localeSyncNeeded(null, "de")).toBe(false);
    expect(localeSyncNeeded("ru", "uz")).toBe(true);
  });
  it("has the Settings strings in every language", () => {
    for (const [code, d] of Object.entries(dictionaries)) {
      expect(d.emailNotifications.languageLabel.trim(), code).not.toBe("");
      expect(d.emailNotifications.languageHint.trim(), code).not.toBe("");
      expect(d.notifyChannels.languageHint.trim(), code).not.toBe("");
    }
  });
});

describe("no branch on a particular language", () => {
  const FILES = [
    "supabase/functions/_shared/telegram-notify.ts", "supabase/functions/_shared/notify-i18n.ts",
    "supabase/functions/telegram-notify-webhook/index.ts",
    "command-center/components/notifications/NotificationChannels.tsx", "command-center/components/notifications/EmailNotifications.tsx",
    "command-center/lib/notify-channels.ts", "command-center/lib/email-prefs.ts",
    "command-center/lib/server/notify-channels.ts", "command-center/lib/server/notify-route.ts", "command-center/lib/server/email-prefs.ts",
    "command-center/app/api/notifications/telegram/route.ts", "command-center/app/api/notifications/telegram/channel/route.ts",
    "command-center/app/api/notifications/telegram/preference/route.ts",
    "command-center/app/api/email/unsubscribe/route.ts", "command-center/app/unsubscribe/page.tsx",
  ];
  const NAME = "(?:lang|language|locale|lng|chatLang|langCode)";
  const LIT = `["'][A-Za-z]{2,3}(?:[-_][A-Za-z]+)?["']`;
  const RULES = [
    new RegExp(`\\b${NAME}\\b\\s*(?:===?|!==?)\\s*${LIT}`),
    new RegExp(`${LIT}\\s*(?:===?|!==?)\\s*\\b${NAME}\\b`),
    /\bswitch\s*\(\s*\w*(?:lang|locale|language)\w*\s*\)/i,
    new RegExp(`\\bcase\\s+${LIT}\\s*:`),
    new RegExp(`\\b${NAME}\\b\\s*\\)?\\s*\\?\\s*${LIT}\\s*:`),
    /["']ru["'][^\n]{0,20}["']uz["']|["']uz["'][^\n]{0,20}["']ru["']/,
  ];
  const branches = (src: string) =>
    src.split("\n").map((line, i) => [i + 1, line.trim()] as const)
      .filter(([, l]) => !/^(\/\/|\*|\/\*)/.test(l) && RULES.some((rx) => rx.test(l)));

  it("sees the patterns it exists to forbid", () => {
    for (const bad of ['if (lang === "ru") {', "if (language == 'uz')", 'x = locale !== "en" ? 1 : 2', "switch (lang) {", 'case "ru":',
      'const l = lang ? "ru" : "en";', 'const A = ["ru", "uz"];'])
      expect(branches(bad).length, bad).toBeGreaterThan(0);
    for (const fine of ["const code = resolveLanguage(lang);", "if (isNotifyLanguage(lang)) return lang;", "// lang === 'ru' is what NOT to write"])
      expect(branches(fine), fine).toEqual([]);
  });
  it("finds none in the code that speaks, sends or picks a notification language", () => {
    for (const f of FILES) expect(branches(read(f)), f).toEqual([]);
  });
});
