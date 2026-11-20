"use client";

/**
 * The forecast panel. Sliders start from what was measured (each says "measured, from N" or "assumption"), the projection is
 * recomputed in the browser as they move — arithmetic only, nothing is fetched, saved or spent — and the chart draws measured
 * MRR solid and every projected line dashed and labelled.
 */

import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fill, int, pct, usd } from "@/lib/owner-analytics/format";
import { HORIZONS, project, type Baseline, type ScenarioInputs } from "@/lib/owner-analytics/forecast";
import { LineChart, type Series } from "./Charts";

type Key = "newUsersPerMonth" | "growth" | "conversion" | "churn" | "arpu" | "costPerPayer" | "fixedMonthly" | "cash";
interface SliderSpec {
  key: Key;
  label: string;
  min: number;
  max: number;
  step: number;
  kind: "count" | "pct" | "usd";
  measured: { value: number | null; basis: number } | null;
}

export function Forecast({
  baseline,
  history,
}: {
  baseline: Baseline;
  /** Measured MRR at each past month end (YYYY-MM): null where no subscription existed yet. */
  history: Array<{ x: string; y: number | null }>;
}) {
  const { t, locale } = useI18n();
  const d = t.ownerAnalytics;
  const thin = baseline.days < 30;

  const initial: Record<Key, number> = {
    newUsersPerMonth: baseline.newUsersPerMonth.value ?? 0,
    growth: 0.05,
    conversion: baseline.conversion.value ?? 0,
    churn: baseline.churn.value ?? 0.05,
    arpu: baseline.arpu.value ?? 0,
    costPerPayer: baseline.costPerPayer.value ?? 0,
    fixedMonthly: baseline.fixedMonthly.value ?? 0,
    cash: 0,
  };
  const [v, setV] = useState(initial);

  const specs: SliderSpec[] = [
    { key: "newUsersPerMonth", label: d.sliderNewUsers, min: 0, max: Math.max(100, Math.ceil((initial.newUsersPerMonth * 4) / 10) * 10), step: 1, kind: "count", measured: baseline.newUsersPerMonth },
    { key: "growth", label: d.sliderGrowth, min: -0.2, max: 0.5, step: 0.01, kind: "pct", measured: null },
    { key: "conversion", label: d.sliderConversion, min: 0, max: 0.5, step: 0.005, kind: "pct", measured: baseline.conversion },
    { key: "churn", label: d.sliderChurn, min: 0, max: 0.5, step: 0.005, kind: "pct", measured: baseline.churn },
    { key: "arpu", label: d.sliderArpu, min: 0, max: Math.max(100, Math.ceil((initial.arpu * 4) / 10) * 10), step: 0.5, kind: "usd", measured: baseline.arpu },
    { key: "costPerPayer", label: d.sliderCostPerPayer, min: 0, max: Math.max(50, Math.ceil((initial.costPerPayer * 4) / 10) * 10), step: 0.1, kind: "usd", measured: baseline.costPerPayer },
    { key: "fixedMonthly", label: d.sliderFixed, min: 0, max: Math.max(5000, Math.ceil((initial.fixedMonthly * 4) / 1000) * 1000), step: 10, kind: "usd", measured: baseline.fixedMonthly },
    { key: "cash", label: d.sliderCash, min: 0, max: 500000, step: 500, kind: "usd", measured: null },
  ];

  const inputs: ScenarioInputs = { ...v, startingPayers: baseline.payers.value ?? 0 };
  const proj = useMemo(() => project(inputs), [inputs.newUsersPerMonth, inputs.growth, inputs.conversion, inputs.churn, inputs.arpu, inputs.costPerPayer, inputs.fixedMonthly, inputs.cash, inputs.startingPayers]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = (kind: SliderSpec["kind"], n: number) => (kind === "pct" ? pct(n, locale) : kind === "usd" ? usd(n, locale) : int(n, locale));
  const last = history.length ? history[history.length - 1].x : null;
  const futureX = (m: number) => {
    if (!last) return `+${m}`;
    const [y, mo] = last.split("-").map(Number);
    const dt = new Date(Date.UTC(y, mo - 1 + m, 1));
    return dt.toISOString().slice(0, 7);
  };
  const series: Series[] = [
    { key: "measured", label: `${d.mrr} · ${d.measured}`, points: history },
    {
      key: "projected",
      label: d.mrr,
      projected: true,
      // The projection starts where the measurement ends, so the two lines meet instead of leaving a gap.
      points: [
        ...(last ? [{ x: last, y: history[history.length - 1].y, lo: history[history.length - 1].y, hi: history[history.length - 1].y }] : []),
        ...proj.mid.map((pt, i) => ({ x: futureX(pt.month), y: pt.mrr, lo: Math.min(proj.low[i].mrr, proj.high[i].mrr), hi: Math.max(proj.low[i].mrr, proj.high[i].mrr) })),
      ],
    },
  ];

  return (
    <section className="oa-card" aria-label={d.forecastTitle}>
      <h2>{d.forecastTitle}</h2>
      <p className="oa-note">{d.forecastNote}</p>
      <p className="oa-note" data-tone={thin ? "warn" : undefined}>
        {thin ? fill(d.baselineThin, { n: baseline.days }) : fill(d.baselineFrom, { n: baseline.days })}
      </p>
      <div className="oa-sliders">
        {specs.map((s) => {
          const measured = s.measured && s.measured.value !== null;
          return (
            <label key={s.key} className="oa-slider">
              <span className="oa-slider-head">
                <span>{s.label}</span>
                <span className="oa-num">{fmt(s.kind, v[s.key])}</span>
              </span>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={v[s.key]}
                onChange={(e) => setV((o) => ({ ...o, [s.key]: Number(e.target.value) }))}
                aria-valuetext={fmt(s.kind, v[s.key])}
              />
              <span className="oa-badge" data-tone={measured ? undefined : "warn"}>
                {measured ? `${d.measured} · ${fill(d.basisN, { n: s.measured!.basis })}` : d.assumption}
              </span>
            </label>
          );
        })}
      </div>
      <p className="oa-note">
        {fill(d.startingPayers, { n: baseline.payers.value ?? 0 })} · {d.cashNote}
      </p>
      <div className="oa-export">
        <button type="button" className="oa-chip" onClick={() => setV(initial)}>
          {d.reset}
        </button>
      </div>

      <h2>{d.mrrHistory}</h2>
      <LineChart
        series={series}
        title={d.mrrHistory}
        format={(n) => usd(n, locale, true)}
        labels={{ unknown: d.unknown, projection: d.projection, noData: d.noData, show: d.legendShow, hide: d.legendHide }}
      />

      <div className="oa-table-wrap">
        <table>
          <caption className="sr-only">{d.forecastTitle}</caption>
          <thead>
            <tr>
              <th scope="col">{d.horizon}</th>
              <th scope="col" className="oa-num">{d.users}</th>
              <th scope="col" className="oa-num">{d.payers}</th>
              <th scope="col" className="oa-num">{d.mrr}</th>
              <th scope="col" className="oa-num">{d.tabCosts}</th>
              <th scope="col" className="oa-num">{d.profit}</th>
              <th scope="col" className="oa-num">{d.cash}</th>
            </tr>
          </thead>
          <tbody>
            {HORIZONS.map((h) => {
              const m = proj.mid[h - 1];
              const lo = proj.low[h - 1];
              const hi = proj.high[h - 1];
              const range = (a: number, b: number, f: (n: number) => string) => `${f(Math.min(a, b))} – ${f(Math.max(a, b))}`;
              return (
                <tr key={h}>
                  <th scope="row">
                    {fill(d.monthsN, { n: h })} <span className="oa-badge" data-tone="warn">{d.projection}</span>
                  </th>
                  <td className="oa-num">{int(m.users, locale)}</td>
                  <td className="oa-num">
                    {int(m.payers, locale)}
                    <div className="oa-dim">{range(lo.payers, hi.payers, (n) => int(n, locale))}</div>
                  </td>
                  <td className="oa-num">
                    {usd(m.mrr, locale)}
                    <div className="oa-dim">{range(lo.mrr, hi.mrr, (n) => usd(n, locale, true))}</div>
                  </td>
                  <td className="oa-num">{usd(m.costs, locale)}</td>
                  <td className="oa-num">{usd(m.profit, locale)}</td>
                  <td className="oa-num">{v.cash > 0 ? usd(m.cash, locale) : d.runwayNoCash}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="oa-note">
        {d.runway}:{" "}
        {v.cash <= 0 ? d.runwayNoCash : proj.runwayMonths === null ? d.runwayNone : fill(d.runwayMonths, { n: proj.runwayMonths })}
      </p>
    </section>
  );
}
