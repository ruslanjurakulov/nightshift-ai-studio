"use client";

import { Check, Minus } from "lucide-react";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/context";
import { formatCredits } from "@/lib/credits";
import { WELCOME_CREDITS } from "@/lib/pricing";
import type { PlanMatrix as Matrix } from "@/lib/plans";
import { entitlementText } from "@/components/pricing/PlanMatrix";

/**
 * Plans side by side: one column per public plan, one row for the monthly
 * credits and one per ENFORCED entitlement (lib/plans.ts planMatrix) — the
 * same data the cards above read, so the two can never disagree. A `planned`
 * key is never listed: a table row is a promise.
 *
 * A real table (column and row headers) for assistive tech. On a phone it
 * scrolls sideways inside its own focusable, labelled region — the page
 * itself never does — with the feature column pinned.
 */
export function PlanCompare({ matrix, titleId }: { matrix: Matrix; titleId: string }) {
  const { t, locale } = useI18n();
  const p = t.plans;
  const rowLabel = (key: string) => (p.row as Record<string, string>)[key] ?? key;
  return (
    <div
      role="region"
      aria-labelledby={titleId}
      tabIndex={0}
      className="st-panel overflow-x-auto"
    >
      <table className="w-full min-w-[34rem] border-collapse text-left text-[14px]">
        <thead>
          <tr className="border-b border-[var(--color-border)]">
            <th scope="col" className="sticky left-0 w-[30%] min-w-[9.5rem] bg-[var(--color-panel)] px-5 py-4 text-[12px] font-medium text-[var(--color-muted)]">
              {t.pricing.compareFeature}
            </th>
            {matrix.columns.map((c) => (
              <th key={c.id} scope="col" className="st-price-name px-5 py-4">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-[var(--color-border)]">
            <th scope="row" className="sticky left-0 bg-[var(--color-panel)] px-5 py-4 font-normal text-[var(--color-muted)]">
              {t.pricing.compareCredits}
            </th>
            {matrix.columns.map((c) => (
              <td key={c.id} className="st-num px-5 py-4 text-[13px]">
                {c.isDefault
                  ? fmt(p.freeCredits, { n: formatCredits(WELCOME_CREDITS, locale) })
                  : fmt(p.monthlyCredits, { n: formatCredits(c.monthlyCredits, locale) })}
              </td>
            ))}
          </tr>
          {matrix.rows.map((row) => (
            <tr key={row.key} className="border-b border-[var(--color-border)] last:border-b-0">
              <th scope="row" className="sticky left-0 bg-[var(--color-panel)] px-5 py-4 font-normal text-[var(--color-muted)]">
                {rowLabel(row.key)}
              </th>
              {row.cells.map((v, i) => {
                const off = v === false || v === 0 || v === "none";
                return (
                  <td key={matrix.columns[i].id} className="px-5 py-4 font-medium">
                    {row.type === "bool" ? (
                      off ? (
                        <Minus className="size-4 text-[var(--color-muted)]" aria-label={p.no} role="img" />
                      ) : (
                        <Check className="size-4 text-[var(--color-ok)]" aria-label={p.yes} role="img" />
                      )
                    ) : (
                      entitlementText(row.key, row.type, v, t)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
