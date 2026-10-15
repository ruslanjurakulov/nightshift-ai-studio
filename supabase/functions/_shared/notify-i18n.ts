// The words of the customer notifications for the Edge Function (Deno), read from
// the SAME data files as the Python side (modules/notify_i18n.py):
//
//   _shared/notify-i18n/registry.json   the list of language codes (the only
//                                       list), the default, each language's own name
//   _shared/notify-i18n/<code>.json     one flat {"key": "text"} file per language
//
// Adding a language is a data file, a line in registry.json and one import line
// below; the test suites (command-center/tests/notify-i18n.test.ts and
// tests/test_notify_i18n.py) fail until every place that lists the codes agrees.
// Nothing branches on a particular language: the language is an argument, checked
// against the registry before use (resolveLanguage), and a code the registry does
// not list reads as English.
//
// Runtime-neutral (no Deno globals), like telegram-notify.ts, so the Command
// Center's vitest suite covers it.

import registry from "./notify-i18n/registry.json" with { type: "json" };
import en from "./notify-i18n/en.json" with { type: "json" };
import ru from "./notify-i18n/ru.json" with { type: "json" };
import uz from "./notify-i18n/uz.json" with { type: "json" };

/** One bundle per registered language. A language missing here, or here and not in the registry, fails the parity test. */
export const BUNDLES: Readonly<Record<string, Readonly<Record<string, string>>>> = { en, ru, uz };

export interface NotifyLanguage {
  code: string;
  /** The language's own name: what its button says, whatever language the chat is in. */
  native: string;
}

export const DEFAULT_LANGUAGE: string = registry.default;
export const NOTIFY_LANGUAGES: readonly NotifyLanguage[] = registry.languages;

const CODES: ReadonlySet<string> = new Set(NOTIFY_LANGUAGES.map((l) => l.code));

/** True only for a code the registry lists, exactly as written. */
export function isNotifyLanguage(v: unknown): v is string {
  return typeof v === "string" && CODES.has(v) && v in BUNDLES;
}

/** The language to use for `v`: the registry's own spelling of it, else the default. */
export function resolveLanguage(v: unknown): string {
  if (typeof v === "string") {
    const candidate = v.trim().toLowerCase();
    if (isNotifyLanguage(candidate)) return candidate;
  }
  return DEFAULT_LANGUAGE;
}

/** The language's own name, for a button. Unknown codes read as the default's. */
export function nativeName(v: unknown): string {
  const code = resolveLanguage(v);
  return NOTIFY_LANGUAGES.find((l) => l.code === code)?.native ?? code;
}

/** The text for `key` in `lang`; per key, English when that language has none. */
export function notifyText(lang: unknown, key: string): string {
  return BUNDLES[resolveLanguage(lang)]?.[key] || BUNDLES[DEFAULT_LANGUAGE][key];
}

/** Replace `{name}` with `values[name]` in one pass: a value is never searched for further placeholders. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
}
