"use client";

import { useI18n } from "@/lib/i18n/context";
import { formatCredits } from "@/lib/credits";
import type { CreditLot } from "@/lib/plans";
import { EmptyState } from "@/components/ui";

/**
 * Where the organization's credits are, lot by lot (migration 0034): each
 * plan period, top-up pack and grant, what is left of it, what is on hold for
 * runs in progress, and when it expires. Listed in the order they are spent.
 * A read of the organization's own rows (RLS), nothing more.
 */
export function CreditLots({ lots }: { lots: CreditLot[] }) {
  const { t, locale } = useI18n();
  const p = t.plans;
  const when = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(iso)) : p.never;
  return (
    <div className="panel flex flex-col gap-3 p-4">
      <h2 className="t-section">{p.lotsTitle}</h2>
      <p className="text-[12px] text-[var(--color-muted)]">{p.lotsLead}</p>
      {lots.length === 0 ? (
        <EmptyState>{p.lotsEmpty}</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[12px]">
            <thead className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              <tr>
                <th className="py-2 pr-3 font-semibold">{p.colSource}</th>
                <th className="py-2 pr-3 text-right font-semibold">{p.colRemaining}</th>
                <th className="py-2 pr-3 text-right font-semibold">{p.colHeld}</th>
                <th className="py-2 pr-3 text-right font-semibold">{p.colAmount}</th>
                <th className="py-2 font-semibold">{p.colExpires}</th>
              </tr>
            </thead>
            <tbody>
              {lots.map((l) => {
                const spent = l.remaining <= 0 || l.expired;
                return (
                  <tr key={l.id} className="border-t border-[var(--color-border)]" style={spent ? { opacity: 0.55 } : undefined}>
                    <td className="py-2 pr-3" title={l.note ?? ""}>
                      {p.source[l.source]}
                    </td>
                    <td className="mono py-2 pr-3 text-right">{formatCredits(l.remaining - l.held, locale)}</td>
                    <td className="mono py-2 pr-3 text-right text-[var(--color-muted)]">{formatCredits(l.held, locale)}</td>
                    <td className="mono py-2 pr-3 text-right text-[var(--color-muted)]">{formatCredits(l.amount, locale)}</td>
                    <td className="py-2" style={l.expired ? { color: "var(--color-muted)" } : undefined}>
                      {l.expired ? `${p.expired} · ${when(l.expiresAt)}` : when(l.expiresAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
