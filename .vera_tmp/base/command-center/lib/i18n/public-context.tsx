"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LOCALE_COOKIE, fmt, type Locale } from "./core";
import type { Dictionary } from "./index";
import type { PublicDictionary } from "./public";

export interface I18nValue<T> {
  locale: Locale;
  t: T;
  fmt: typeof fmt;
  setLocale: (next: Locale) => void;
}

/** What a provider puts in context: the full dictionary (the app) or the public slice. */
export type I18nContextValue =
  | (I18nValue<Dictionary> & { full: true })
  | (I18nValue<PublicDictionary> & { full: false });

export const I18nContext = createContext<I18nContextValue | null>(null);

/** Writes the choice for a year, path-wide; getLocale() reads it on the next request. */
export function writeLocaleCookie(next: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

/**
 * The public pages' i18n: the server-resolved locale and only the slice of its
 * dictionary those pages' client code reads (lib/i18n/public.ts). Switching
 * language writes the cookie and refreshes, and the server sends the new
 * slice; the rest of a public page is server-rendered text anyway.
 */
export function PublicI18nProvider({
  locale,
  t,
  children,
}: {
  locale: Locale;
  t: PublicDictionary;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Locale | null>(null);
  const setLocale = useCallback(
    (next: Locale) => {
      setPending(next);
      writeLocaleCookie(next);
      router.refresh();
    },
    [router],
  );
  // The pending choice shows on the language key at once; the text follows
  // with the refresh, which also brings the matching `locale` prop.
  const shown = pending && pending !== locale ? pending : locale;
  const value = useMemo<I18nContextValue>(() => ({ locale: shown, t, fmt, setLocale, full: false }), [shown, t, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * i18n for client code that also renders on the public pages: works under the
 * public slice and under the app's full provider alike, and type-checks that
 * it reads only what the slice carries.
 */
export function usePublicI18n(): I18nValue<PublicDictionary> {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("usePublicI18n must be used within PublicI18nProvider or I18nProvider");
  return ctx;
}
