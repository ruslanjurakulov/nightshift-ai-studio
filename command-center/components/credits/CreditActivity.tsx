"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { formatCredits, movesBalance, type CreditTransaction } from "@/lib/credits";
import { txnLabel, type TxnLabel } from "@/lib/account";
import { EmptyState } from "@/components/ui";

const PAGE = 20;

/**
 * The organization's credit history, newest first, in plain language: "Held
 * for a video in progress", "Charged for a finished generation", "Returned
 * from hold, not charged" (lib/account.ts txnLabel). A hold and its return
 * only move what is on hold, never the balance, so their amounts are muted
 * and carry no sign. The rows are append-only in the database (0020); this is
 * a read of them, nothing more. A platform admin also sees each row's job
 * reference, for support.
 */
export function CreditActivity({ rows, showRefs = false }: { rows: CreditTransaction[]; showRefs?: boolean }) {
  const { t, locale } = useI18n();
  const cp = t.creditsPage;
  const [shown, setShown] = useState(PAGE);
  const when = (iso: string) => {
    const d = new Date(iso);
    if (!iso || !Number.isFinite(d.getTime())) return "—";
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
  };
  const label = (key: TxnLabel): string => {
    const [head, purpose] = key.split(".") as [string, string | undefined];
    if (purpose && (head === "reserve" || head === "capture")) return (cp.txn[head] as Record<string, string>)[purpose];
    return (cp.txn as unknown as Record<string, string>)[head];
  };

  return (
    <section className="panel flex flex-col gap-3 p-5 sm:p-6" aria-labelledby="activity-title">
      <h2 id="activity-title" className="t-section">
        {cp.activityTitle}
      </h2>
      {rows.length === 0 ? (
        <EmptyState>{t.credits.ledgerEmpty}</EmptyState>
      ) : (
        <>
          <ul className="flex flex-col">
            {rows.slice(0, shown).map((r) => {
              const moves = movesBalance(r.kind);
              const positive = moves && r.amount > 0;
              return (
                <li
                  key={r.id}
                  className="flex items-start justify-between gap-4 border-t border-[var(--color-border)] py-3 first:border-t-0"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm">{label(txnLabel(r))}</span>
                    <span className="text-xs text-[var(--color-muted)] tabular-nums" title={r.createdAt}>
                      {when(r.createdAt)}
                      {showRefs && r.jobId && <span className="mono ml-2 break-all text-xs">{r.jobId}</span>}
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <span
                      className="text-[15px] font-medium tabular-nums"
                      style={{ color: !moves ? "var(--color-muted)" : positive ? "var(--color-ok)" : "var(--color-fg)" }}
                    >
                      {positive ? "+" : ""}
                      {formatCredits(moves ? r.amount : Math.abs(r.amount), locale)}
                    </span>
                    {r.kind === "reserve" && <span className="text-xs text-[var(--color-muted)]">{cp.holdTag}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
          {rows.length > shown && (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE)}
              className="btn-quiet self-center px-5 py-2 text-sm"
            >
              {cp.showMore}
            </button>
          )}
        </>
      )}
    </section>
  );
}
