"use client";

import { useI18n } from "@/lib/i18n/context";
import "@/app/(app)/app-pages-g5.css";

/**
 * Shown when Supabase env vars are absent. The Command Center never fakes data,
 * so with no backend it says exactly what's missing and how to fix it.
 */
export function NotConfigured() {
  const { t } = useI18n();
  return (
    <div className="g5-boundary">
      <section className="g5-boundary-desk" aria-labelledby="nc-title">
        <div className="g5-boundary-slug">
          <span aria-hidden className="ns-lamp" data-tone="warn" data-size="md" />
          <span className="g5-k">{t.notConfigured.badge}</span>
        </div>
        <h1 id="nc-title" className="g5-boundary-title">
          {t.notConfigured.title}
        </h1>
        <p className="g5-state-body">
          {t.notConfigured.body1a} <code className="g5-state-code mono">NEXT_PUBLIC_SUPABASE_URL</code> {t.notConfigured.body1b}{" "}
          <code className="g5-state-code mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> {t.notConfigured.body1c}{" "}
          <code className="g5-state-code mono">.env.local</code> {t.notConfigured.body1d}
        </p>
        <p className="g5-boundary-ref">
          {t.notConfigured.body2a} <code className="g5-state-code mono">docs/SUPABASE.md</code> {t.notConfigured.body2b}
        </p>
      </section>
    </div>
  );
}
