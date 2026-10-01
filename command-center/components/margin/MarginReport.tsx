"use client";

import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { EmptyState } from "@/components/ui";
import {
  PERIODS,
  formatUsd,
  marginCell,
  marginTotals,
  type MarginFlag,
  type MarginRow,
  type Period,
} from "@/lib/margin";

/**
 * The operator's margin report (migration 0063): a summary, then one row per
 * model, capability and day. The database decides every figure; this only lays
 * them out. A figure it does not know is the word "unpriced" in a warning tone,
 * never 0 and never left out of a total as if it were nothing.
 */
export function MarginReport({ rows, days }: { rows: MarginRow[]; days: Period }) {
  const { t } = useI18n();
  const path = useChannelPath();
  const totals = marginTotals(rows);
  const periodLabel: Record<Period, string> = { 7: t.margin.period7, 30: t.margin.period30, 90: t.margin.period90 };

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label={t.margin.periodLabel} className="flex flex-wrap items-center gap-2">
        <span className="t-label">{t.margin.periodLabel}</span>
        {PERIODS.map((p) => (
          <Link
            key={p}
            href={path(`/margin?days=${p}`)}
            aria-current={p === days ? "page" : undefined}
            className={`pill border px-3 py-1 text-[12px] ${
              p === days
                ? "border-[var(--color-primary-dim)] text-[var(--color-fg)]"
                : "border-[var(--color-border)] text-[var(--color-muted)]"
            }`}
          >
            {periodLabel[p]}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <div className="panel">
          <EmptyState>{t.margin.empty}</EmptyState>
        </div>
      ) : (
        <>
          <section aria-label={t.margin.title} className="grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-4">
            <Figure label={t.margin.sumRevenue} value={usd(totals.revenueUsd)} unknown={totals.revenueUsd === null}
              sub={fmt(t.margin.sumCredits, { credits: totals.creditsSold.toLocaleString(), jobs: totals.jobsCompleted })} />
            <Figure label={t.margin.sumCost} value={usd(totals.providerUsd)} unknown={totals.providerUsd === null} />
            <Figure
              label={t.margin.sumMargin}
              value={
                totals.marginUsd === null
                  ? t.margin.unpriced
                  : `${formatUsd(totals.marginUsd)}${totals.marginPct === null ? "" : ` · ${totals.marginPct.toFixed(1)}%`}`
              }
              unknown={totals.marginUsd === null}
            />
            <Figure
              label={t.margin.sumWasted}
              value={usd(totals.providerUsdReleased)}
              unknown={totals.providerUsdReleased === null}
              sub={fmt(t.margin.sumReleased, { jobs: totals.jobsReleased, credits: totals.creditsReleased.toLocaleString() })}
            />
          </section>
          {totals.unpricedRows > 0 && (
            <p role="status" className="flex items-start gap-2 text-[12px] text-[var(--color-warn)]">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
              {fmt(t.margin.sumUnpriced, { n: totals.unpricedRows })}
            </p>
          )}

          <div className="panel overflow-x-auto">
            <table className="w-full min-w-[56rem] border-collapse text-left text-[12px]">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-[var(--color-muted)]">
                  <Th>{t.margin.colDay}</Th>
                  <Th>{t.margin.colModel}</Th>
                  <Th>{t.margin.colJobs}</Th>
                  <Th right>{t.margin.colCredits}</Th>
                  <Th right>{t.margin.colRevenue}</Th>
                  <Th right>{t.margin.colCost}</Th>
                  <Th right>{t.margin.colMargin}</Th>
                  <Th>{t.margin.colReleased}</Th>
                  <Th>{t.margin.colFlags}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Row key={`${r.day}|${r.model}|${r.capability}`} row={r} />
                ))}
              </tbody>
            </table>
          </div>

          <section aria-labelledby="margin-rules" className="panel flex flex-col gap-2 p-4 text-[12px] font-light leading-relaxed text-[var(--color-muted)]">
            <h2 id="margin-rules" className="t-panel">
              {t.margin.rulesTitle}
            </h2>
            <p className="m-0">{t.margin.ruleRevenue}</p>
            <p className="m-0">{t.margin.ruleCost}</p>
            <p className="m-0">{t.margin.ruleReleased}</p>
          </section>
        </>
      )}
    </div>
  );

  function usd(v: number | null): string {
    return v === null ? t.margin.unpriced : formatUsd(v);
  }
}

function Figure({ label, value, sub, unknown }: { label: string; value: string; sub?: string; unknown: boolean }) {
  return (
    <div className="border-t border-[var(--color-border)] pt-4">
      <div className="t-label">{label}</div>
      <div className={`t-figure mt-3 ${unknown ? "text-[var(--color-warn)]" : ""}`}>{value}</div>
      {sub && <div className="mt-2 text-[12px] font-light text-[var(--color-muted)]">{sub}</div>}
    </div>
  );
}

function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return <th scope="col" className={`px-3 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}

function Row({ row }: { row: MarginRow }) {
  const { t } = useI18n();
  const cell = marginCell(row);
  const flagText: Record<MarginFlag, string> = {
    released_jobs: t.margin.flag_released_jobs,
    unpriced_cost: t.margin.flag_unpriced_cost,
    unvalued_credits: t.margin.flag_unvalued_credits,
    api_balance_jobs: t.margin.flag_api_balance_jobs,
    free_credits: t.margin.flag_free_credits,
    internal_jobs: t.margin.flag_internal_jobs,
  };
  const money = (v: number | null) =>
    v === null ? <span className="text-[var(--color-warn)]">{t.margin.unpriced}</span> : <span>{formatUsd(v)}</span>;

  return (
    <tr className="border-b border-[var(--color-border)] align-top last:border-b-0">
      <td className="mono whitespace-nowrap px-3 py-2">{row.day}</td>
      <td className="px-3 py-2">
        <div className="mono text-[var(--color-fg)]">{row.model}</div>
        <div className="mono text-[11px] text-[var(--color-muted)]">{row.capability}</div>
      </td>
      <td className="mono px-3 py-2">{row.jobsCompleted}</td>
      <td className="px-3 py-2 text-right">
        <div className="mono">{row.creditsSold.toLocaleString()}</div>
        {row.creditsSold > 0 && (
          <div className="text-[11px] text-[var(--color-muted)]">
            {fmt(t.margin.creditsSplit, {
              paid: row.creditsPaid.toLocaleString(),
              free: row.creditsFree.toLocaleString(),
              unvalued: row.creditsUnvalued.toLocaleString(),
            })}
          </div>
        )}
      </td>
      <td className="mono px-3 py-2 text-right">{money(row.revenueUsd)}</td>
      <td className="mono px-3 py-2 text-right">{money(row.providerUsd)}</td>
      <td className="mono px-3 py-2 text-right">
        {cell.kind === "value" ? (
          <>
            <div>{cell.pct.toFixed(1)}%</div>
            {row.marginUsd !== null && <div className="text-[11px] text-[var(--color-muted)]">{formatUsd(row.marginUsd)}</div>}
          </>
        ) : cell.kind === "unpriced" ? (
          <span className="text-[var(--color-warn)]">{t.margin.unpriced}</span>
        ) : (
          <span className="text-[var(--color-muted)]">{t.margin.noRevenue}</span>
        )}
      </td>
      <td className="px-3 py-2">
        {row.jobsReleased > 0 ? (
          <span className="text-[var(--color-warn)]">
            {fmt(t.margin.releasedCell, {
              jobs: row.jobsReleased,
              credits: row.creditsReleased.toLocaleString(),
              cost: row.providerUsdReleased === null ? t.margin.unpriced : formatUsd(row.providerUsdReleased),
            })}
          </span>
        ) : (
          <span className="text-[var(--color-muted)]">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        {row.flags.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[11px] text-[var(--color-muted)]">
            {row.flags.map((f) => (
              <li key={f}>{flagText[f]}</li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}
