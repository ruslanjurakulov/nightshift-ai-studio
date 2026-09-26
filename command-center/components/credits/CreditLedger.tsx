"use client";

import { useI18n } from "@/lib/i18n/context";
import { relativeTime } from "@/lib/format";
import { formatCredits, movesBalance, type CreditTransaction } from "@/lib/credits";
import { EmptyState } from "@/components/ui";

/**
 * The organization's credit ledger, newest first — every grant, purchase,
 * hold, charge and returned hold, with the balance and hold after it. The rows
 * are append-only in the database (0020); this is a read of them, nothing more.
 * A hold or a returned hold moves only what is on hold, so its amount is shown
 * muted: it never changed the balance.
 */
export function CreditLedger({ rows }: { rows: CreditTransaction[] }) {
  const { t, locale } = useI18n();
  return (
    <div className="panel flex flex-col gap-3 p-4">
      <h2 className="t-section">{t.credits.ledgerTitle}</h2>
      {rows.length === 0 ? (
        <EmptyState>{t.credits.ledgerEmpty}</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[12px]">
            <thead className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
              <tr>
                <th className="py-2 pr-3 font-semibold">{t.credits.colWhen}</th>
                <th className="py-2 pr-3 font-semibold">{t.credits.colKind}</th>
                <th className="py-2 pr-3 text-right font-semibold">{t.credits.colAmount}</th>
                <th className="py-2 pr-3 text-right font-semibold">{t.credits.colBalance}</th>
                <th className="py-2 pr-3 text-right font-semibold">{t.credits.colHeld}</th>
                <th className="py-2 pr-3 font-semibold">{t.credits.colRun}</th>
                <th className="py-2 font-semibold">{t.credits.colNote}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const moves = movesBalance(r.kind);
                const color = !moves
                  ? "var(--color-muted)"
                  : r.amount < 0
                    ? "var(--color-fail)"
                    : "var(--color-ok)";
                return (
                  <tr key={r.id} className="border-t border-[var(--color-border)]">
                    <td className="py-2 pr-3 text-[var(--color-muted)]" title={r.createdAt}>
                      {relativeTime(r.createdAt)}
                    </td>
                    <td className="py-2 pr-3">{t.credits.kind[r.kind]}</td>
                    <td className="mono py-2 pr-3 text-right" style={{ color }}>
                      {moves && r.amount > 0 ? "+" : ""}
                      {formatCredits(r.amount, locale)}
                    </td>
                    <td className="mono py-2 pr-3 text-right">{formatCredits(r.balanceAfter, locale)}</td>
                    <td className="mono py-2 pr-3 text-right text-[var(--color-muted)]">
                      {formatCredits(r.reservedAfter, locale)}
                    </td>
                    <td className="mono max-w-[140px] truncate py-2 pr-3 text-[11px] text-[var(--color-muted)]" title={r.jobId ?? ""}>
                      {r.jobId ?? "—"}
                    </td>
                    <td className="max-w-[240px] truncate py-2 text-[var(--color-muted)]" title={r.note ?? ""}>
                      {r.note ?? ""}
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
