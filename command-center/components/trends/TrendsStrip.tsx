"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { HOME_TEMPLATE_LIMIT } from "@/lib/templates/trends";
import { TrendCard, TrendCardSkeleton } from "@/components/trends/TrendCard";
import { useCanHover, useReducedMotion, useTemplates } from "@/components/trends/useTemplates";
import "@/components/trends/trends.css";

/**
 * Home's row of the first six templates (the same /api/templates read, `limit=6`, in the gallery's order). It hides itself when
 * there is nothing to show or the feature is not switched on here — Home is not the place to explain a migration — but an error
 * keeps the row and offers a retry, so a failure never reads as "no trends".
 */
export function TrendsStrip() {
  const { t, locale } = useI18n();
  const tt = t.trends;
  const path = useChannelPath();
  const { state, retry } = useTemplates(locale, HOME_TEMPLATE_LIMIT);
  const reduced = useReducedMotion();
  const canHover = useCanHover();
  // Hidden when there is nothing to show, the feature is off here, or the session ended (the shell's own bar says that).
  if (state.phase === "not_enabled" || state.phase === "signed_out" || (state.phase === "ok" && state.templates.length === 0)) return null;

  return (
    <section className="flex flex-col gap-3" aria-label={tt.homeTitle} data-trends-strip="">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="m-0 text-base font-semibold text-[var(--color-fg)]">{tt.homeTitle}</h2>
        <Link href={path("/trends")} className="tap-link g2-link">
          {tt.homeAll}
        </Link>
      </div>
      {state.phase === "error" ? (
        <div className="tr-state" role="alert">
          <p>{tt.errorTitle}</p>
          <button type="button" className="btn-quiet" onClick={retry}>
            {tt.retry}
          </button>
        </div>
      ) : (
        <ul className="tr-strip" aria-busy={state.phase === "loading"}>
          {state.phase === "loading"
            ? Array.from({ length: HOME_TEMPLATE_LIMIT }, (_, i) => (
                <li key={i}>
                  <TrendCardSkeleton />
                </li>
              ))
            : state.templates.map((x) => (
                <li key={x.slug}>
                  <TrendCard template={x} reduced={reduced} canHover={canHover} />
                </li>
              ))}
        </ul>
      )}
    </section>
  );
}
