/**
 * The body of POST /api/style-library/add, checked. Pure: the route and its
 * tests share it. An unknown library id is refused here, before any database
 * call — the database cannot know the library, so this is where "only a
 * built-in style can be added under a library id" is enforced.
 */

import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n";
import { kitNameFor, libraryStyleById, type LibraryStyle } from "@/lib/styles/library";

export type LibraryAddInput =
  | { ok: true; value: { style: LibraryStyle; name: string; locale: Locale; orgId: unknown } }
  | { ok: false; error: "bad_request" };

export function parseLibraryAdd(body: unknown): LibraryAddInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_request" };
  const b = body as { library_id?: unknown; locale?: unknown; org_id?: unknown };
  const style = libraryStyleById(b.library_id);
  if (!style) return { ok: false, error: "bad_request" };
  // A language the app does not have falls back to English rather than refusing the add.
  const locale = typeof b.locale === "string" && isLocale(b.locale) ? b.locale : DEFAULT_LOCALE;
  return { ok: true, value: { style, name: kitNameFor(style, locale), locale, orgId: b.org_id } };
}
