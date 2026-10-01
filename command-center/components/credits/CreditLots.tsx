"use client";

import { useI18n } from "@/lib/i18n/context";
import { formatCredits } from "@/lib/credits";
import type { CreditLot } from "@/lib/plans";
import { EmptyState } from "@/components/ui";

/**
 * Where the organization's credits are, lot by lot (migration 0034): each
 * plan period, top-up pack and grant, what is left of it, what is on hold for
 * runs in progress, and when it expires. Listed in the order they are spent.
 * A read of the organization's own rows (RLS), nothing more. A list, not a
 * table, so it reads on a phone without sideways scrolling; a lot's internal
 * note (it can name the payment provider) is not shown.
 */
export function CreditLots({ lots }: { lots: CreditLot[] }) {
  const { t, locale } = useI18n();
  const p = t.plans;
  const when = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(iso)) : p.never;
  return (
    <section className="panel flex flex-col gap-3 p-5 sm:p-6" aria-labelledby="lots-title">
      <h2 id="lots-title" className="t-section">
        {p.lotsTitle}
      </h2>
      <p className="text-[13px] text-[var(--color-muted)]">{p.lotsLead}</p>
      {lots.length === 0 ? (
        <EmptyState>{p.lotsEmpty}</EmptyState>
      ) : (
        <ul className="flex flex-col">
          {lots.map((l) => {
            const spent = l.remaining <= 0 || l.expired;
            return (
              <li
                key={l.id}
                className="flex items-start justify-between gap-4 border-t border-[var(--color-border)] py-3 first:border-t-0"
                style={spent ? { opacity: 0.55 } : undefined}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[14px]">{p.source[l.source]}</span>
                  <span className="text-[12px] text-[var(--color-muted)]">
                    {p.colExpires}: {l.expired ? `${p.expired} · ${when(l.expiresAt)}` : when(l.expiresAt)}
                  </span>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5 tabular-nums">
                  <span className="text-[15px] font-medium">{formatCredits(l.remaining - l.held, locale)}</span>
                  <span className="text-[11px] text-[var(--color-muted)]">
                    {p.colAmount} {formatCredits(l.amount, locale)}
                    {l.held > 0 && ` · ${p.colHeld} ${formatCredits(l.held, locale)}`}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
