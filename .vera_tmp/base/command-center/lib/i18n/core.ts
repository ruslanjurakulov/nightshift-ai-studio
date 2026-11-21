/**
 * The parts of i18n that carry no dictionary: the locale list, the cookie, and
 * the `{name}` filler. Client code on the public pages imports from here, so a
 * marketing page never ships the app's three dictionaries to the browser
 * (./index.ts imports all of them).
 */

export type Locale = "en" | "ru" | "uz";

export const LOCALES: { code: Locale; label: string; short: string }[] = [
  { code: "en", label: "English", short: "EN" },
  { code: "ru", label: "Русский", short: "RU" },
  { code: "uz", label: "O'zbek", short: "UZ" },
];

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "chronos_locale";

export function isLocale(value: string | undefined | null): value is Locale {
  return value === "en" || value === "ru" || value === "uz";
}

/**
 * Fill `{name}` placeholders in a template string. Used for the few strings
 * that carry a real value (counts, timestamps) — e.g. fmt(t.feed.events, { n }).
 */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    key in vars ? String(vars[key]) : `{${key}}`,
  );
}
