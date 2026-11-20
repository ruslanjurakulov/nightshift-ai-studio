"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useChannelPath } from "@/lib/channels-client";
import { useI18n } from "@/lib/i18n/context";
import { Chip } from "@/components/ui/Chip";
import { TEMPLATE_CATEGORIES, type TemplateCategory } from "@/lib/templates/trends";
import { TrendCard, TrendCardSkeleton } from "@/components/trends/TrendCard";
import { useCanHover, useReducedMotion, useTemplates, type TemplatesState } from "@/components/trends/useTemplates";
import "@/components/trends/trends.css";

/**
 * The Trends gallery: category chips over a grid of template cards. Every state has its own words — loading (skeletons),
 * empty, an empty category, not switched on (0183 not applied), and an error with a retry — so none of them reads as another.
 */
export function TrendsGallery() {
  const { t, locale } = useI18n();
  const tt = t.trends;
  const { state, retry } = useTemplates(locale);
  const [category, setCategory] = useState<TemplateCategory | null>(null);
  const reduced = useReducedMotion();
  const canHover = useCanHover();

  const shown = useMemo(
    () => (state.phase === "ok" ? state.templates.filter((x) => category === null || x.category === category) : []),
    [state, category],
  );
  // Only the categories that hold a template are offered: a chip that always leads to "nothing here" is a dead end.
  const present = useMemo(
    () => (state.phase === "ok" ? TEMPLATE_CATEGORIES.filter((c) => state.templates.some((x) => x.category === c)) : []),
    [state],
  );

  return (
    <div className="flex flex-col gap-6">
      <p className="m-0 text-sm text-[var(--color-muted)]">{tt.note}</p>
      {state.phase === "ok" && state.templates.length > 0 && (
        <div role="group" aria-label={tt.filterLabel} className="tr-chips">
          <Chip className="tap" pressed={category === null} onClick={() => setCategory(null)}>
            {tt.categories.all}
          </Chip>
          {present.map((c) => (
            <Chip key={c} className="tap" pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>
              {tt.categories[c]}
            </Chip>
          ))}
        </div>
      )}
      <GalleryBody state={state} shown={shown} filtered={category !== null} onClear={() => setCategory(null)} onRetry={retry} reduced={reduced} canHover={canHover} />
    </div>
  );
}

function GalleryBody({
  state,
  shown,
  filtered,
  onClear,
  onRetry,
  reduced,
  canHover,
}: {
  state: TemplatesState;
  shown: import("@/lib/templates/trends").TemplateDto[];
  filtered: boolean;
  onClear: () => void;
  onRetry: () => void;
  reduced: boolean;
  canHover: boolean;
}) {
  const { t } = useI18n();
  const tt = t.trends;
  const path = useChannelPath();
  const here = usePathname();
  // Every dead end gets a way on: a blank Create is always there.
  const blank = (
    <Link href={path("/create")} className="btn-quiet">
      {tt.blankCreate}
    </Link>
  );
  if (state.phase === "loading") {
    return (
      <ul className="tr-grid" aria-busy="true" aria-label={tt.loading}>
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i}>
            <TrendCardSkeleton />
          </li>
        ))}
      </ul>
    );
  }
  if (state.phase === "not_enabled") {
    return (
      <div className="tr-state" role="status">
        <h2>{tt.notEnabledTitle}</h2>
        <p>{tt.notEnabledBody}</p>
        {blank}
      </div>
    );
  }
  if (state.phase === "signed_out") {
    return (
      <div className="tr-state" role="alert">
        <h2>{tt.signedOutTitle}</h2>
        <p>{tt.signedOutBody}</p>
        <a className="btn-quiet" href={`/login?next=${encodeURIComponent(here)}`}>
          {tt.signIn}
        </a>
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="tr-state" role="alert">
        <h2>{tt.errorTitle}</h2>
        <p>{tt.errorBody}</p>
        <button type="button" className="btn-quiet" onClick={onRetry}>
          {tt.retry}
        </button>
      </div>
    );
  }
  if (state.templates.length === 0) {
    return (
      <div className="tr-state" role="status">
        <h2>{tt.emptyTitle}</h2>
        <p>{tt.emptyBody}</p>
        {blank}
      </div>
    );
  }
  if (shown.length === 0 && filtered) {
    return (
      <div className="tr-state" role="status">
        <p>{tt.emptyCategory}</p>
        <button type="button" className="btn-quiet" onClick={onClear}>
          {tt.showAll}
        </button>
      </div>
    );
  }
  return (
    <ul className="tr-grid">
      {shown.map((x) => (
        <li key={x.slug}>
          <TrendCard template={x} reduced={reduced} canHover={canHover} />
        </li>
      ))}
    </ul>
  );
}
