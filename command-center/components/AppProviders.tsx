"use client";

import { I18nProvider } from "@/lib/i18n/context";
import { ToastProvider } from "@/components/feedback/ToastProvider";
import type { Locale } from "@/lib/i18n/core";

/**
 * The app's client context: the full dictionaries (for instant language
 * switching across every screen) and the toasts. Mounted by the app's own
 * layouts only, so the public pages never download either.
 */
export function AppProviders({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return (
    <I18nProvider locale={locale}>
      <ToastProvider>{children}</ToastProvider>
    </I18nProvider>
  );
}
