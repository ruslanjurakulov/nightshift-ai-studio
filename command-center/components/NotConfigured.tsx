"use client";

import { useI18n } from "@/lib/i18n/context";

/**
 * Shown when Supabase env vars are absent. The Command Center never fakes data,
 * so with no backend it says exactly what's missing and how to fix it.
 */
export function NotConfigured() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="reveal panel max-w-lg p-6">
        <div className="tnum text-xs font-bold text-[var(--color-warn)]">
          {t.notConfigured.badge}
        </div>
        <h1 className="mt-2 text-lg font-semibold text-[var(--color-fg)]">{t.notConfigured.title}</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          {t.notConfigured.body1a}{" "}
          <code className="mono text-[var(--color-primary)]">NEXT_PUBLIC_SUPABASE_URL</code>{" "}
          {t.notConfigured.body1b}{" "}
          <code className="mono text-[var(--color-primary)]">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>{" "}
          {t.notConfigured.body1c} <code className="mono">.env.local</code> {t.notConfigured.body1d}
        </p>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          {t.notConfigured.body2a} <code className="mono">docs/SUPABASE.md</code> {t.notConfigured.body2b}
        </p>
      </div>
    </div>
  );
}
