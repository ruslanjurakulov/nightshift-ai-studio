import { cookies, headers } from "next/headers";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  getDictionaryFor,
  isLocale,
  type Dictionary,
  type Locale,
} from "./index";

/**
 * Resolve the active locale for a request: an explicit cookie choice first,
 * else the browser's Accept-Language on first visit, else the default. Server
 * Components read this so pages render already-localized (no client flash).
 */
export async function getLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;

  const accept = (await headers()).get("accept-language")?.toLowerCase() ?? "";
  // Take the first language tag we support, in the browser's stated order.
  for (const part of accept.split(",")) {
    const tag = part.trim().split(";")[0].split("-")[0];
    if (isLocale(tag)) return tag;
  }
  return DEFAULT_LOCALE;
}

/** The locale + its dictionary, for a Server Component. */
export async function getDictionary(): Promise<{ locale: Locale; t: Dictionary }> {
  const locale = await getLocale();
  return { locale, t: getDictionaryFor(locale) };
}
