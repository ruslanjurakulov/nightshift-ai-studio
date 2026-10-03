"use client";

import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ArrowUpRight, Lock, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { nextFocusIndex } from "@/lib/feedback";
import { formatCredits } from "@/lib/credits";
import { UPSELL_LINKS, upsellView, type Refusal, type UpsellCatalog, type UpsellKey, type UpsellView } from "@/lib/upsell";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Dict = ReturnType<typeof useI18n>["t"];

/** "premium video models", "public API access" — what a plan_feature refusal is missing. */
function featureText(t: Dict, key: UpsellKey | null, wanted: string | null): string {
  const u = t.upsell;
  if (!key) return u.featureFallback;
  const label = (u.feature as Record<string, string>)[key.key];
  if (!label) return u.featureFallback;
  const tier = wanted ? ((u.tier as Record<string, string>)[wanted] ?? wanted) : u.tier.all;
  return label.replace("{tier}", tier);
}

function lockedLine(t: Dict, v: UpsellView, modelName: string, locale: string): string {
  const u = t.upsell;
  const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
  switch (v.reason) {
    case "first_purchase":
      return fill(u.firstPurchase, { model: modelName });
    case "plan_feature":
      return fill(u.planFeature, { model: modelName, feature: featureText(t, v.highlight, v.wanted) });
    case "run_limit":
      return v.limit !== null ? fill(u.runLimit, { limit: String(v.limit) }) : u.runLimitUnknown;
    case "credits":
      return v.needed !== null && v.available !== null
        ? fill(u.credits, { needed: formatCredits(v.needed, locale), available: formatCredits(Math.max(0, v.available), locale) })
        : u.creditsUnknown;
    default:
      return fill(u.notOpen, { model: modelName });
  }
}

/**
 * The plan dialog a refused generation opens: what is locked, in one line;
 * the plans that would unlock it, from the plan catalog (lib/upsell.ts);
 * "Buy credits" when credits are what is missing; and "Compare plans".
 *
 * It never pays and never loads the payment provider: every choice is a link
 * to a page that already exists — the Credits page's plans or top-up packs
 * (where the checkout is) and /pricing. Prices are the owner's display price
 * or "shown at checkout"; there is no yearly toggle, discount or trial,
 * because the plan data has none.
 *
 * A bottom sheet on a phone, a centred dialog from `sm` up. Escape and the
 * scrim close it, Tab stays inside, and focus returns to what opened it.
 */
export function PlanUpsellDialog({
  refusal,
  model,
  data,
  onClose,
  returnTo,
}: {
  refusal: Refusal;
  /** The refused model, when known: its name, and its entitlement (sellable_models()). */
  model: { name: string; entitlement?: string | null } | null;
  data: UpsellCatalog | null;
  onClose: () => void;
  returnTo?: React.RefObject<HTMLElement | null>;
}) {
  const { t, fmt, locale } = useI18n();
  const u = t.upsell;
  const path = useChannelPath();
  const titleId = useId();
  const descId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  const view = upsellView(refusal, model?.entitlement, data);
  const modelName = model?.name || u.modelFallback;
  const title = view.reason === "credits" ? u.titleCredits : view.reason === "run_limit" ? u.titleRunLimit : u.titleModel;

  // A layout effect, not a passive one: focus lands on the dialog in the same
  // commit that shows it, so there is no frame (and, on a slow machine, no
  // keystroke) in which focus is still on the composer behind the modal.
  useLayoutEffect(() => {
    opener.current = returnTo?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    // The first focus is the primary action when there is one, else Close:
    // nothing is pressed by opening, so landing on a link is safe.
    const primary = panel.current?.querySelector<HTMLElement>("[data-upsell-primary]");
    (primary ?? closeRef.current)?.focus();
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

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const next = nextFocusIndex(items.indexOf(document.activeElement as HTMLElement), items.length, e.shiftKey);
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
  }

  const highlight = (values: Record<string, unknown>): string | null => {
    const k = view.highlight;
    if (!k) return null;
    const v = values[k.key];
    if (k.key === "concurrency" && typeof v === "number") return fmt(u.runsAtOnce, { n: v });
    return fmt(u.includes, { feature: featureText(t, k, view.wanted) });
  };

  const linkBase =
    "tap press inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--ns-r-key)] px-4 text-sm font-semibold";
  const primaryCls = `${linkBase} bg-[var(--studio-cta-bg)] text-[var(--studio-cta-fg)] shadow-[var(--studio-cta-shadow)]`;
  const secondaryCls = `${linkBase} border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-fg)] hover:border-[var(--color-primary)]`;
  // With credits missing, "Buy credits" is the answer; the plans are the alternative.
  const plansArePrimary = !view.buyCredits;

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-end justify-center sm:items-center sm:p-4" onKeyDown={onKeyDown}>
      <div aria-hidden className="absolute inset-0 bg-[var(--studio-scrim)]" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        data-testid="plan-upsell"
        data-reason={view.reason}
        className="relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-[var(--ns-r-sheet)] border border-[var(--color-border)] bg-[var(--color-panel)] shadow-[var(--shadow-elevated)] sm:max-h-[85vh] sm:max-w-[640px] sm:rounded-[var(--ns-r-sheet)]"
      >
        <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-4 sm:px-6 sm:pt-5">
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden
              className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)] text-[var(--color-primary)]"
            >
              <Lock className="size-4" strokeWidth={2} />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 id={titleId} className="text-base font-semibold leading-snug text-[var(--color-fg)]">
                {title}
              </h2>
              <p id={descId} className="text-sm leading-relaxed text-[var(--color-muted)]">
                {lockedLine(t, view, modelName, locale)}
              </p>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={u.close}
            className="tap-icon grid size-9 shrink-0 place-items-center rounded-[var(--ns-r-key)] text-[var(--color-muted)] hover:bg-[var(--studio-field)] hover:text-[var(--color-fg)]"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-4 sm:px-6">
          {view.buyCredits && (
            <Link href={path(UPSELL_LINKS.topups)} className={primaryCls} data-upsell-primary onClick={onClose}>
              {u.buyCredits}
            </Link>
          )}

          {view.plans.length > 0 && (
            <section aria-labelledby={`${titleId}-plans`} className="flex flex-col gap-2">
              <h3 id={`${titleId}-plans`} className="studio-label">
                {view.reason === "credits" ? u.plansLeadCredits : u.plansLead}
              </h3>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {view.plans.map((p, i) => {
                  const extra = highlight(p.values);
                  return (
                    <li
                      key={p.id}
                      data-plan={p.id}
                      className="flex min-w-0 flex-col gap-2 rounded-[var(--ns-r-panel)] border border-[var(--color-border)] bg-[var(--studio-field)] p-3"
                    >
                      <span className="truncate text-[15px] font-semibold text-[var(--color-fg)]">{p.name}</span>
                      <span className="text-sm text-[var(--color-fg)]">
                        {p.price ? (
                          <>
                            <span className="tnum font-semibold">{p.price}</span>{" "}
                            <span className="text-[var(--color-muted)]">{u.perMonth}</span>
                          </>
                        ) : (
                          <span className="text-[var(--color-muted)]">{u.priceAtCheckout}</span>
                        )}
                      </span>
                      <span className="text-xs text-[var(--color-muted)]">
                        {fmt(u.monthlyCredits, { n: formatCredits(p.monthlyCredits, locale) })}
                      </span>
                      {extra && <span className="text-xs font-medium text-[var(--color-fg)]">{extra}</span>}
                      <Link
                        href={path(UPSELL_LINKS.plans)}
                        onClick={onClose}
                        className={`${plansArePrimary && i === 0 ? primaryCls : secondaryCls} mt-auto w-full text-sm`}
                        {...(plansArePrimary && i === 0 ? { "data-upsell-primary": true } : {})}
                      >
                        <span className="truncate">{fmt(u.choose, { plan: p.name })}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {view.plansUnread && <p className="text-xs text-[var(--color-muted)]">{u.plansUnread}</p>}
        </div>

        <div className="flex flex-col gap-2 border-t border-[var(--color-border)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="text-xs text-[var(--color-muted)]">{u.noCharge}</p>
          <div className="flex shrink-0 items-center gap-2">
            <Link href={UPSELL_LINKS.compare} onClick={onClose} className={`${secondaryCls} flex-1 sm:flex-none`}>
              {u.compare}
              <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
            <button type="button" onClick={onClose} className={`${secondaryCls} flex-1 sm:flex-none`}>
              {u.notNow}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
