"use client";

import { useCallback, useContext, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_LOCALE, dictionaries, fmt, type Dictionary, type Locale } from "./index";
import { I18nContext, writeLocaleCookie, type I18nContextValue, type I18nValue } from "./public-context";

/**
 * Client-side i18n for the app. Seeded with the server-resolved locale so first
 * paint matches the server (no flash). Switching writes the cookie, updates
 * client components immediately from the in-memory dictionaries, and refreshes
 * so Server Components re-render in the new language too.
 *
 * This module imports all three dictionaries, so only the app's layouts mount
 * it; the public pages get the slice (PublicI18nProvider, ./public-context).
 */
export function I18nProvider({ locale: initial, children }: { locale: Locale; children: React.ReactNode }) {
  const router = useRouter();
  const [locale, setLocaleState] = useState<Locale>(initial);

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      writeLocaleCookie(next);
      router.refresh();
    },
    [router],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, t: dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE], fmt, setLocale, full: true }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue<Dictionary> {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  // Under the public slice the full dictionary is not there: a component that
  // needs it must sit under the app's I18nProvider (or use usePublicI18n).
  if (!ctx.full) throw new Error("useI18n needs the app's I18nProvider; public pages use usePublicI18n");
  return ctx;
}
