"use client";

import "./globals.css";
import { useState } from "react";
import { ErrorScreen } from "@/components/feedback/ErrorScreen";
import { I18nProvider } from "@/lib/i18n/context";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "@/lib/i18n";

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
 * just failed.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [locale] = useState(cookieLocale);
  return (
    <html lang={locale}>
      <body>
        <I18nProvider locale={locale}>
          <div className="atmos flex min-h-dvh items-center justify-center">
            <ErrorScreen error={error} reset={reset} homeHref="/" />
          </div>
        </I18nProvider>
      </body>
    </html>
  );
}
