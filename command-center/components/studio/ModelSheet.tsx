"use client";

import { useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, Lock, Search, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { formatCredits } from "@/lib/credits";
import {
  apiErrorMessage,
  capabilityLine,
  entitlementReason,
  kindLabel,
  type ModelLock,
  type StudioCapability,
  type StudioModel,
} from "@/lib/creative/studio";
import type { ModelPrice } from "@/components/studio/useModelPrices";
import { TierMarks } from "@/components/studio/TierMarks";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/Sheet";

/**
 * Pick the model for the current tool: a bottom sheet on a phone, a centred
 * dialog from `sm` up. Each row shows the registry's name, its speed and
 * quality marks when the registry has them, one line of what it makes taken
 * from its own lists (capabilityLine: shapes, lengths, the largest
 * resolution), and the price the database gives for the current settings
 * (priced by the caller only while this is open). A model this organization
 * cannot buy shows a lock and why (StudioModel.lock), never a red refusal.
 * Choosing a model only changes the form; nothing is spent here.
 *
 * Search narrows the list; ↑/↓ move between models, Enter picks one, Escape
 * closes, Tab stays inside, and focus returns to what opened it.
 *
 * The shell is the shared Sheet (components/ui, Radix Dialog): it traps focus,
 * locks the page's scroll, hides the page from a screen reader and closes on
 * Escape or a press outside, which this file used to hand-roll. The list stays a
 * listbox with focus on its rows, not a cmdk combobox: here `aria-selected` is
 * the model in use, and a combobox would use it for the highlighted row.
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
  buyHref,
  pricedAt,
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
  /** The top-ups (Credits page): a model that opens after a first purchase links there. */
  buyHref?: string;
  /** Per model: the settings its price was asked at, when they are not the form's (its own shape or length), already worded. */
  pricedAt?: Record<string, string>;
}) {
  const { t, fmt, locale } = useI18n();
  const g = t.gen;
  const listId = useId();
  const search = useRef<HTMLInputElement>(null);
  // Read during the first render, before the sheet takes focus: the Change button when given (it is on the page for as long as
  // this is), else whatever had focus. A click does not focus a button in every browser, hence returnTo.
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : (returnTo?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)),
  );
  const options = useRef<Array<HTMLLIElement | null>>([]);
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? models.filter((m) => m.displayName.toLowerCase().includes(q)) : models;
  }, [models, query]);
  const selectedIndex = Math.max(0, shown.findIndex((m) => m.id === selectedId));
  const [active, setActive] = useState(selectedIndex);
  const activeIndex = Math.min(active, Math.max(0, shown.length - 1));

  function move(to: number) {
    if (shown.length === 0) return;
    const i = (to + shown.length) % shown.length;
    setActive(i);
    options.current[i]?.focus();
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

  // The lock a row shows: the one the page read (modelLock), or the one its quote answered (entitlement_required), told apart by
  // the model's entitlement or the database's own sentence. Neither known: no guess, the row shows the generic sentence instead.
  const lockOf = (m: StudioModel): ModelLock | null => {
    if (m.lock) return m.lock;
    const p = prices[m.id];
    return p?.status === "error" && p.code === "entitlement_required" ? entitlementReason(m.entitlement, p.detail) : null;
  };
  // "Last proven working" from the registry's verified_at, in the reader's language; nothing when it is not known.
  const verified = (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return fmt(g.verifiedOn, { date: d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }) });
  };

  const priceText = (id: string): { text: string; tone: "fg" | "muted" | "fail" } => {
    const p = prices[id];
    if (!p) return { text: priceHint ?? g.sheetPriceLater, tone: "muted" };
    if (p.status === "quoting") return { text: g.sheetPricing, tone: "muted" };
    if (p.status === "ready") return { text: fmt(g.sheetCredits, { n: formatCredits(p.credits, locale) }), tone: "fg" };
    // A refusal of the sale is not a failure of the model: muted, like a lock.
    return { text: apiErrorMessage(t, p.code), tone: p.code === "entitlement_required" ? "muted" : "fail" };
  };

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="auto"
        closeLabel={null}
        onOpenAutoFocus={(e) => {
          // The picked model, so ↑/↓ and Enter work at once; search is a Tab away.
          e.preventDefault();
          (options.current[selectedIndex] ?? search.current)?.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (opener?.isConnected) opener.focus();
        }}
        // Escape is this sheet's: the canvas or panel behind must not also take it (Radix closes the sheet itself).
        onKeyDown={(e) => {
          if (e.key === "Escape") e.stopPropagation();
        }}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--ds-border)] px-4 pb-3 pt-4 sm:px-6">
          <div className="flex min-w-0 flex-col gap-1">
            <SheetTitle className="ds-t-heading-lg text-[var(--ds-text)]">{g.sheetTitle}</SheetTitle>
            <SheetDescription className="ds-t-caption text-[var(--ds-muted)]">
              {fmt(g.sheetFor, { kind: kindLabel(t, capability) })}
            </SheetDescription>
          </div>
          <SheetClose aria-label={g.sheetClose} className="ui-close tap-icon">
            <X aria-hidden className="size-4" />
          </SheetClose>
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
            aria-label={g.sheetTitle}
            className="scroll-focus flex flex-col gap-2 overflow-y-auto px-4 py-3 sm:px-6"
          >
            {shown.map((m, i) => {
              const on = m.id === selectedId;
              const price = priceText(m.id);
              const lock = lockOf(m);
              const facts = capabilityLine(t, m, capability);
              const proven = verified(m.verifiedAt);
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
                      {m.preview && (
                        // 0139: the operator's own try of a hidden model; nobody else is ever shown it.
                        <span
                          title={g.previewHint}
                          data-preview={m.id}
                          className="shrink-0 rounded-[var(--ns-r-chip)] border border-[var(--ns-amber-ink)] px-1.5 py-px text-xs font-medium text-[var(--ns-amber-ink)]"
                        >
                          {g.preview}
                        </span>
                      )}
                    </span>
                    <TierMarks speed={m.speedTier ?? null} quality={m.qualityTier ?? null} />
                    {facts && (
                      <span className="tnum text-xs text-[var(--color-muted)]" data-facts={m.id}>
                        {facts}
                      </span>
                    )}
                    {proven && (
                      <span className="text-xs text-[var(--color-muted)]" data-verified={m.id}>
                        {proven}
                      </span>
                    )}
                  </span>
                  {lock ? (
                    <span className="flex max-w-[44%] shrink-0 flex-col items-end gap-1 text-right text-xs" data-lock={m.id}>
                      <span className="studio-lock" title={g.lockWhy[lock]}>
                        <Lock aria-hidden className="size-3" />
                        {g.lock[lock]}
                      </span>
                      {lock === "first_purchase" && buyHref && (
                        <Link
                          href={buyHref}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                          className="tap-link text-[var(--color-primary)] underline"
                        >
                          {g.lockBuy}
                        </Link>
                      )}
                    </span>
                  ) : (
                    <span
                      className={`max-w-[44%] shrink-0 text-right text-xs ${price.tone === "fg" ? "ns-tc text-sm font-semibold text-[var(--color-fg)]" : price.tone === "fail" ? "text-[var(--color-fail)]" : "text-[var(--color-muted)]"}`}
                      data-price={m.id}
                    >
                      {price.text}
                      {price.tone === "fg" && pricedAt?.[m.id] && (
                        // Asked at this model's own settings, not the form's: say which, beside the number.
                        <span className="block text-xs font-normal text-[var(--color-muted)]" data-priced-at={m.id}>
                          {fmt(g.sheetAt, { settings: pricedAt[m.id] })}
                        </span>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <p className="ds-t-caption border-t border-[var(--ds-border)] px-4 py-3 text-[var(--ds-muted)] sm:px-6">{g.sheetNote}</p>
      </SheetContent>
    </Sheet>
  );
}
