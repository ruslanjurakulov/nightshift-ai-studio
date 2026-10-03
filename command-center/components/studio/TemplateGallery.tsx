"use client";

import { useI18n } from "@/lib/i18n/context";
import { kindLabel, type StudioPrefill } from "@/lib/creative/studio";
import { STUDIO_TEMPLATES, templatePrefill } from "@/lib/creative/templates";
import { TOOL_ICONS } from "@/components/studio/toolIcons";

/**
 * Ready starting points, as a compact strip above the results. A card only
 * fills the composer (onPick); it never prices or starts anything by itself.
 * One scrolling row at every width: the results are the page, not this.
 */
export function TemplateGallery({
  onPick,
  only,
}: {
  onPick: (prefill: StudioPrefill) => void;
  /** A desk's tools: only the templates that start one of them (none: nothing is drawn). */
  only?: readonly string[];
}) {
  const { t } = useI18n();
  const tt = t.studioTemplates;
  const templates = only ? STUDIO_TEMPLATES.filter((tpl) => only.includes(tpl.capability)) : STUDIO_TEMPLATES;
  if (templates.length === 0) return null;

  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby="tpl-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="tpl-title" className="shrink-0 whitespace-nowrap text-sm font-semibold text-[var(--color-fg)]">
          {tt.title}
        </h2>
        <p className="hidden min-w-0 truncate text-xs text-[var(--color-muted)] sm:block">{tt.hint}</p>
      </div>
      <ul className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-2">
        {templates.map((tpl) => {
          const Icon = TOOL_ICONS[tpl.capability];
          const copy = tt.items[tpl.id];
          return (
            <li key={tpl.id} className="shrink-0 snap-start">
              <button
                type="button"
                onClick={() => onPick(templatePrefill(tpl))}
                aria-label={`${tt.use}: ${copy.title}`}
                title={copy.who}
                className="press flex h-14 w-[200px] items-center gap-3 rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] p-2 pr-3 text-left transition-colors hover:border-[var(--color-primary)]"
              >
                <span
                  aria-hidden
                  className="grid size-10 shrink-0 place-items-center rounded-[var(--ns-r-frame)] bg-[var(--ns-film)] text-[var(--ns-edge-print)]"
                >
                  <Icon className="size-[18px]" strokeWidth={1.75} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-[var(--color-fg)]">{copy.title}</span>
                  <span className="truncate text-xs text-[var(--color-muted)]">{kindLabel(t, tpl.capability)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
