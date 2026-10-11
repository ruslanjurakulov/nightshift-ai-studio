"use client";

import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { EmptyState } from "@/components/ui";
import { DataList } from "@/components/g4/DataList";
import { Figures } from "@/components/g4/Section";
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
    <div className="g4-stack">
      <nav aria-label={t.margin.periodLabel} className="ns-tabs flex flex-wrap items-center gap-x-2">
        <span className="t-label pr-3">{t.margin.periodLabel}</span>
        {PERIODS.map((p) => (
          <Link key={p} href={path(`/margin?days=${p}`)} aria-current={p === days ? "page" : undefined} className="ns-tabs-link">
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
          <section aria-label={t.margin.title} className="ns-desk">
            <Figures>
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
            </Figures>
            {totals.unpricedRows > 0 && (
              <p role="status" className="mt-6 flex items-start gap-2 text-sm text-[var(--color-warn)]">
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
                {fmt(t.margin.sumUnpriced, { n: totals.unpricedRows })}
              </p>
            )}
          </section>

          <DataList
            caption={t.margin.title}
            rows={rows}
            rowKey={(r) => `${r.day}|${r.model}|${r.capability}`}
            columns={[
              { key: "day", label: t.margin.colDay, nowrap: true, render: (r) => <span className="tnum">{r.day}</span> },
              {
                key: "model",
                label: t.margin.colModel,
                render: (r) => (
                  <>
                    <div className="tnum">{r.model}</div>
                    <div className="tnum g4-muted g4-small">{r.capability}</div>
                  </>
                ),
              },
              { key: "jobs", label: t.margin.colJobs, align: "end", render: (r) => <span className="tnum">{r.jobsCompleted}</span> },
              {
                key: "credits",
                label: t.margin.colCredits,
                align: "end",
                render: (r) => (
                  <>
                    <div className="tnum">{r.creditsSold.toLocaleString()}</div>
                    {r.creditsSold > 0 && (
                      <div className="g4-muted g4-small">
                        {fmt(t.margin.creditsSplit, {
                          paid: r.creditsPaid.toLocaleString(),
                          free: r.creditsFree.toLocaleString(),
                          unvalued: r.creditsUnvalued.toLocaleString(),
                        })}
                      </div>
                    )}
                  </>
                ),
              },
              { key: "rev", label: t.margin.colRevenue, align: "end", render: (r) => <span className="tnum">{money(r.revenueUsd)}</span> },
              { key: "cost", label: t.margin.colCost, align: "end", render: (r) => <span className="tnum">{money(r.providerUsd)}</span> },
              {
                key: "margin",
                label: t.margin.colMargin,
                align: "end",
                render: (r) => {
                  const cell = marginCell(r);
                  return cell.kind === "value" ? (
                    <span className="tnum">
                      {cell.pct.toFixed(1)}%
                      {r.marginUsd !== null && <span className="g4-muted g4-small"> · {formatUsd(r.marginUsd)}</span>}
                    </span>
                  ) : cell.kind === "unpriced" ? (
                    <span className="text-[var(--color-warn)]">{t.margin.unpriced}</span>
                  ) : (
                    <span className="g4-muted">{t.margin.noRevenue}</span>
                  );
                },
              },
              {
                key: "released",
                label: t.margin.colReleased,
                render: (r) =>
                  r.jobsReleased > 0 ? (
                    <span className="text-[var(--color-warn)]">
                      {fmt(t.margin.releasedCell, {
                        jobs: r.jobsReleased,
                        credits: r.creditsReleased.toLocaleString(),
                        cost: r.providerUsdReleased === null ? t.margin.unpriced : formatUsd(r.providerUsdReleased),
                      })}
                    </span>
                  ) : (
                    <span className="g4-muted">—</span>
                  ),
              },
              {
                key: "flags",
                label: t.margin.colFlags,
                render: (r) =>
                  r.flags.length > 0 ? (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0 g4-muted g4-small">
                      {r.flags.map((f) => (
                        <li key={f}>{flagText[f]}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="g4-muted">—</span>
                  ),
              },
            ]}
          />

          <section aria-labelledby="margin-rules" className="flex flex-col gap-2">
            <h2 id="margin-rules" className="t-panel">
              {t.margin.rulesTitle}
            </h2>
            <p className="g4-note">{t.margin.ruleRevenue}</p>
            <p className="g4-note">{t.margin.ruleCost}</p>
            <p className="g4-note">{t.margin.ruleReleased}</p>
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
    <div>
      <div className="t-label">{label}</div>
      <div className={`t-figure mt-3 ${unknown ? "text-[var(--color-warn)]" : ""}`}>{value}</div>
      {sub && <div className="mt-2 text-sm font-light text-[var(--color-muted)]">{sub}</div>}
    </div>
  );
}
