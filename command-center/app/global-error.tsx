"use client";

import "./globals.css";
import { useEffect, useState } from "react";
import { ErrorScreen } from "@/components/feedback/ErrorScreen";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "@/lib/i18n/core";
import type { PublicDictionary } from "@/lib/i18n/public";

function cookieLocale(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
  const value = match?.[1];
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/**
 * The last resort, when the root layout itself failed. It replaces that layout,
 * so it brings its own <html>, stylesheet and i18n — the locale comes from the
 * cookie the language picker writes, since the server lookup is what may have
 * just failed. Next ships this boundary with every page, so its words are
 * fetched only when it actually shows (a dynamic import), never up front.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [locale] = useState(cookieLocale);
  const [t, setT] = useState<PublicDictionary | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([import("@/lib/i18n"), import("@/lib/i18n/public")]).then(([i18n, pub]) => {
      if (live) setT(pub.publicDictionary(i18n.getDictionaryFor(locale)));
    });
    return () => {
      live = false;
    };
  }, [locale]);
  return (
    <html lang={locale}>
      <body>
        {t && (
          <PublicI18nProvider locale={locale} t={t}>
            <div className="atmos flex min-h-dvh items-center justify-center">
              <ErrorScreen error={error} reset={reset} homeHref="/" />
            </div>
          </PublicI18nProvider>
        )}
      </body>
    </html>
  );
}
