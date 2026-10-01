"use client";

import { Film, Image as ImageIcon, Mic, Play, Scissors, Wand2, ZoomIn, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { kindLabel, type StudioPrefill } from "@/lib/creative/studio";
import { STUDIO_TEMPLATES, templateGradient, templatePrefill } from "@/lib/creative/templates";

const ICON: Record<string, LucideIcon> = {
  t2i: ImageIcon,
  t2v: Film,
  tts: Mic,
  edit: Wand2,
  i2v: Play,
  upscale: ZoomIn,
  remove_bg: Scissors,
};

/**
 * Ready starting points above the generate panel. A card only fills the
 * panel (onPick); it never prices or starts anything by itself. A horizontal
 * row on a phone, a grid on wider screens.
 */
export function TemplateGallery({ onPick }: { onPick: (prefill: StudioPrefill) => void }) {
  const { t } = useI18n();
  const tt = t.studioTemplates;

  return (
    <section className="flex flex-col gap-2" aria-labelledby="tpl-title">
      <div className="flex flex-col gap-0.5">
        <h2 id="tpl-title" className="t-section">
          {tt.title}
        </h2>
        <p className="text-[12px] text-[var(--color-muted)]">{tt.hint}</p>
      </div>
      <ul className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 lg:grid-cols-4">
        {STUDIO_TEMPLATES.map((tpl) => {
          const Icon = ICON[tpl.capability] ?? ImageIcon;
          const copy = tt.items[tpl.id];
          return (
            <li key={tpl.id} className="w-40 shrink-0 snap-start sm:w-auto">
              <button
                type="button"
                onClick={() => onPick(templatePrefill(tpl))}
                aria-label={`${tt.use}: ${copy.title}`}
                className="press group flex h-full w-full flex-col overflow-hidden rounded-[14px] border border-[var(--color-border)] bg-[var(--color-panel)] text-left transition-colors hover:border-[var(--color-primary)] focus-visible:border-[var(--color-primary)]"
              >
                <span aria-hidden className="relative grid h-16 place-items-center" style={{ background: templateGradient(tpl) }}>
                  <Icon className="size-6 text-white drop-shadow" strokeWidth={1.75} />
                  <span className="absolute bottom-1.5 left-2 rounded bg-black/45 px-1.5 py-0.5 text-[10px] text-white">
                    {kindLabel(t, tpl.capability)}
                  </span>
                </span>
                <span className="flex flex-col gap-0.5 p-2.5">
                  <span className="text-[13px] font-semibold text-[var(--color-fg)]">{copy.title}</span>
                  <span className="text-[11px] leading-snug text-[var(--color-muted)]">{copy.who}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
