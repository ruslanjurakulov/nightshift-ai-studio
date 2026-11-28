"use client";

import { useId, type CSSProperties } from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import type { LibraryStyle } from "@/lib/styles/library";
import { StyleTile } from "@/components/styles/StyleTile";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/Sheet";

export type SheetBusy = "add" | "use" | null;

/**
 * One library style in full: its palette preview, the colours, what it is good
 * for, the suggested formats and the whole art direction (the text that is
 * added to a prompt when the style is picked). A bottom sheet on a phone, a
 * centred dialog from `sm` up; Escape and the scrim close it, focus stays
 * inside and returns to the tile that opened it. The shell is the shared Sheet
 * (components/ui, Radix Dialog), which brings all of that and the inert page.
 *
 * "Add to my styles" and "Use in Studio" only call back: what they do (create
 * a style kit, open the Studio filled) is decided and explained by the page.
 */
export function StyleDetailSheet({
  style,
  added,
  canAdd,
  busy,
  notice,
  error,
  onAdd,
  onUse,
  onClose,
  manageHref,
}: {
  style: LibraryStyle;
  added: boolean;
  canAdd: boolean;
  busy: SheetBusy;
  notice: string | null;
  error: string | null;
  onAdd: () => void;
  onUse: () => void;
  onClose: () => void;
  manageHref: string;
}) {
  const { t, locale } = useI18n();
  const ts = t.styleLibrary;
  const titleId = useId();
  const working = busy !== null;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="auto"
        closeLabel={null}
        // The palette, colours and direction are the content; no separate description names it.
        aria-describedby={undefined}
        style={{ "--ui-sheet-w": "672px" } as CSSProperties}
        // Escape is this sheet's: the style grid behind must not also act on it.
        onKeyDown={(e) => {
          if (e.key === "Escape") e.stopPropagation();
        }}
      >
        <header className="flex items-center justify-between gap-3 border-b border-[var(--ds-border)] px-5 py-3">
          <SheetTitle className="g2-h2 min-w-0 truncate">{style.name[locale]}</SheetTitle>
          <SheetClose aria-label={ts.close} className="ui-close shrink-0">
            <X aria-hidden className="size-5" />
          </SheetClose>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-5">
          <div className="ns-frame">
            <div className="ns-frame-media">
              <StyleTile style={style} label={ts.previewLabel} className="aspect-[4/3] w-full sm:aspect-[16/7]" />
            </div>
            <p className="g2-note px-1 py-2 !text-[var(--ns-on-film)] opacity-80">{ts.previewNote}</p>
          </div>

          <section aria-label={ts.goodFor} className="flex flex-col gap-1">
            <h3 className="g2-label">{ts.goodFor}</h3>
            <p className="text-[0.9375rem] text-[var(--color-fg)]">{style.goodFor[locale]}</p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {style.tags.map((tag) => (
                <li key={tag} className="ns-chip" data-plain="true">
                  {ts.tags[tag]}
                </li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="g2-label">{ts.palette}</h3>
            <ul className="flex flex-wrap gap-2">
              {style.swatch.map((hex) => (
                <li key={hex} className="flex items-center gap-1.5">
                  <span
                    role="img"
                    aria-label={ts.swatch.replace("{hex}", hex)}
                    className="size-8 rounded-full border border-[var(--ns-rule-strong)]"
                    style={{ background: hex }}
                  />
                  <span className="tnum text-[13px] text-[var(--color-muted)]">{hex}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="g2-label">{ts.aspects}</h3>
            <ul className="flex flex-wrap gap-1.5">
              {style.aspects.map((a) => (
                <li key={a} className="ns-chip tnum" data-plain="true">
                  {a}
                </li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="g2-label">{ts.direction}</h3>
            <p className="g2-note">{ts.directionHint}</p>
            {/* The direction is written in English whatever the app's language: it is what a model reads. */}
            <p lang="en" className="border-l-2 border-[var(--ns-amber)] bg-[var(--ns-key)] p-4 text-[0.9375rem] leading-relaxed text-[var(--color-fg)]">
              {style.description}
            </p>
          </section>
        </div>

        <footer className="flex flex-col gap-2 border-t border-[var(--ns-rule)] px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div aria-live="polite" className="min-h-[18px] text-sm">
            {error ? (
              <span role="alert" style={{ color: "var(--color-fail)" }}>
                {error}
              </span>
            ) : notice ? (
              <span className="g2-ok">{notice}</span>
            ) : null}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            {added ? (
              <span className="inline-flex min-h-11 items-center justify-center gap-1.5 px-4 text-[0.9375rem] font-medium text-[var(--ns-amber-ink)]">
                <Check aria-hidden className="size-4" />
                {ts.added}
              </span>
            ) : (
              <button
                type="button"
                onClick={onAdd}
                disabled={!canAdd || working}
                aria-busy={busy === "add"}
                className="btn-quiet disabled:opacity-50"
              >
                {busy === "add" ? ts.adding : ts.add}
              </button>
            )}
            <button
              type="button"
              onClick={onUse}
              disabled={working || (!canAdd && !added)}
              aria-busy={busy === "use"}
              aria-describedby={`${titleId}-use`}
              className="btn-primary disabled:opacity-50"
            >
              {busy === "use" ? ts.opening : ts.useInStudio}
            </button>
          </div>
          <p id={`${titleId}-use`} className="g2-note sm:ml-auto sm:text-right">
            {ts.useHint}
          </p>
          {added && (
            <Link href={manageHref} className="tap-link g2-link text-sm sm:ml-auto">
              {ts.manage}
            </Link>
          )}
        </footer>
      </SheetContent>
    </Sheet>
  );
}
