"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Search, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { nextFocusIndex } from "@/lib/feedback";
import { formatCredits } from "@/lib/credits";
import { apiErrorMessage, kindLabel, type StudioCapability, type StudioModel } from "@/lib/creative/studio";
import type { ModelPrice } from "@/components/studio/useModelPrices";
import { TierMarks } from "@/components/studio/TierMarks";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Pick the model for the current tool: a bottom sheet on a phone, a centred
 * dialog from `sm` up. Each row shows the registry's name, its speed and
 * quality marks when the registry has them, and the price the database gives
 * for the current settings (priced by the caller only while this is open).
 * Choosing a model only changes the form; nothing is spent here.
 *
 * Search narrows the list; ↑/↓ move between models, Enter picks one, Escape
 * closes, Tab stays inside, and focus returns to what opened it.
 */
export function ModelSheet({
  capability,
  models,
  selectedId,
  prices,
  priceHint,
  onSelect,
  onClose,
  returnTo,
}: {
  capability: StudioCapability;
  models: StudioModel[];
  selectedId: string;
  prices: Record<string, ModelPrice>;
  /** Why no price can be shown yet (no picture, no words), or null. */
  priceHint: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Where focus goes back on close (the Change button); a click does not focus a button in every browser. */
  returnTo?: React.RefObject<HTMLElement | null>;
}) {
  const { t, fmt, locale } = useI18n();
  const g = t.gen;
  const titleId = useId();
  const listId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const options = useRef<Array<HTMLLIElement | null>>([]);
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? models.filter((m) => m.displayName.toLowerCase().includes(q)) : models;
  }, [models, query]);
  const selectedIndex = Math.max(0, shown.findIndex((m) => m.id === selectedId));
  const [active, setActive] = useState(selectedIndex);
  const activeIndex = Math.min(active, Math.max(0, shown.length - 1));

  useEffect(() => {
    // The Change button when given (it is on the page for as long as this is),
    // else whatever had focus.
    opener.current = returnTo?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    // Focus the picked model, so ↑/↓ and Enter work at once; search is a Tab away.
    const first = options.current[selectedIndex];
    (first ?? search.current)?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      const el = opener.current;
      if (el && el.isConnected) el.focus();
    };
    // Mount only: the opener and the first focus belong to the opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function move(to: number) {
    if (shown.length === 0) return;
    const i = (to + shown.length) % shown.length;
    setActive(i);
    options.current[i]?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = nextFocusIndex(current, items.length, e.shiftKey);
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
  }

  function onListKey(e: React.KeyboardEvent, i: number) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(i + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(i - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(shown.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(shown[i].id);
    }
  }

  const priceText = (id: string): { text: string; tone: "fg" | "muted" | "fail" } => {
    const p = prices[id];
    if (!p) return { text: priceHint ?? g.sheetPriceLater, tone: "muted" };
    if (p.status === "quoting") return { text: g.sheetPricing, tone: "muted" };
    if (p.status === "ready") return { text: fmt(g.sheetCredits, { n: formatCredits(p.credits, locale) }), tone: "fg" };
    return { text: apiErrorMessage(t, p.code), tone: "fail" };
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-end justify-center sm:items-center sm:p-4" onKeyDown={onKeyDown}>
      <div aria-hidden className="absolute inset-0 bg-[var(--studio-scrim)]" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[86dvh] w-full flex-col overflow-hidden rounded-t-[var(--ns-r-sheet)] border border-[var(--ns-rule-strong)] bg-[var(--color-panel)] shadow-[var(--shadow-elevated)] sm:max-h-[80vh] sm:max-w-[560px] sm:rounded-[var(--ns-r-sheet)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-4 pb-3 pt-4 sm:px-6">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={titleId} className="font-display text-[22px] font-bold leading-none text-[var(--color-fg)]">
              {g.sheetTitle}
            </h2>
            <p className="text-xs text-[var(--color-muted)]">{fmt(g.sheetFor, { kind: kindLabel(t, capability) })}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={g.sheetClose}
            className="tap-icon grid size-8 shrink-0 place-items-center rounded-[var(--ns-r-key)] text-[var(--color-muted)] hover:bg-[var(--studio-field)] hover:text-[var(--color-fg)]"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>

        <div className="px-4 pt-3 sm:px-6">
          <label className="studio-field flex items-center gap-2 px-3">
            <Search aria-hidden className="size-4 shrink-0 text-[var(--color-muted)]" />
            <span className="sr-only">{g.sheetSearch}</span>
            <input
              ref={search}
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  move(0);
                }
              }}
              placeholder={g.sheetSearch}
              className="min-h-10 w-full bg-transparent text-base text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)] focus-visible:outline-none sm:text-[13px]"
            />
          </label>
        </div>

        {shown.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[var(--color-muted)] sm:px-6">{g.sheetNoMatch}</p>
        ) : (
          <ul
            id={listId}
            role="listbox"
            aria-labelledby={titleId}
            className="scroll-focus flex flex-col gap-2 overflow-y-auto px-4 py-3 sm:px-6"
          >
            {shown.map((m, i) => {
              const on = m.id === selectedId;
              const price = priceText(m.id);
              return (
                <li
                  key={m.id}
                  ref={(el) => {
                    options.current[i] = el;
                  }}
                  role="option"
                  aria-selected={on}
                  tabIndex={i === activeIndex ? 0 : -1}
                  onClick={() => onSelect(m.id)}
                  onKeyDown={(e) => onListKey(e, i)}
                  onFocus={() => setActive(i)}
                  data-model={m.id}
                  className={`group flex cursor-pointer items-center gap-3 rounded-[var(--ns-r-key)] border p-3 outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] ${
                    on
                      ? "border-[var(--ns-amber-ink)] bg-[var(--ns-select)]"
                      : "border-[var(--color-border)] hover:bg-[var(--studio-field)]"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`grid size-5 shrink-0 place-items-center rounded-[var(--ns-r-key)] border ${
                      on ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-on-accent)]" : "border-[var(--color-border)]"
                    }`}
                  >
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-[var(--color-fg)]">{m.displayName}</span>
                      {m.beta && (
                        <span className="shrink-0 rounded-[var(--ns-r-chip)] border border-[var(--color-border)] px-1.5 py-px text-xs font-medium text-[var(--color-muted)]">
                          {g.beta}
                        </span>
                      )}
                    </span>
                    <TierMarks speed={m.speedTier ?? null} quality={m.qualityTier ?? null} />
                  </span>
                  <span
                    className={`max-w-[44%] shrink-0 text-right text-xs ${price.tone === "fg" ? "ns-tc text-sm font-semibold text-[var(--color-fg)]" : price.tone === "fail" ? "text-[var(--color-fail)]" : "text-[var(--color-muted)]"}`}
                    data-price={m.id}
                  >
                    {price.text}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <p className="border-t border-[var(--color-border)] px-4 py-3 text-xs text-[var(--color-muted)] sm:px-6">{g.sheetNote}</p>
      </div>
    </div>,
    document.body,
  );
}
