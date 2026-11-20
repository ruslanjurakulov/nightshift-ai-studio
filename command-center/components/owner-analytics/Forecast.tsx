"use client";

/**
 * The forecast panel. Sliders start from what was measured (each says "measured, from N" or "assumption"), the projection is
 * recomputed in the browser as they move — arithmetic only, nothing is fetched, saved or spent — and the chart draws measured
 * MRR solid and every projected line dashed and labelled.
 */

import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fill, int, pct, usd } from "@/lib/owner-analytics/format";
import { BAND_SPREAD, HORIZONS, project, type Baseline, type Measured, type ScenarioInputs } from "@/lib/owner-analytics/forecast";
import { LineChart, type Series } from "./Charts";

type Key = "newUsersPerMonth" | "growth" | "conversion" | "churn" | "arpu" | "costPerPayer" | "fixedMonthly" | "cash";
interface SliderSpec {
  key: Key;
  label: string;
  min: number;
  max: number;
  step: number;
  kind: "count" | "pct" | "usd";
  measured: Measured<number> | null;
}

/** The inputs a projection cannot run without. Null means nobody measured it and the owner has not set it yet. */
const REQUIRED: Key[] = ["newUsersPerMonth", "conversion", "churn", "arpu", "costPerPayer", "fixedMonthly"];

export function Forecast({
  baseline,
  history,
}: {
  baseline: Baseline;
  /** Measured MRR at each past month end (YYYY-MM): $0 before the first subscription, null where it is incomplete. */
  history: Array<{ x: string; y: number | null }>;
}) {
  const { t, locale } = useI18n();
  const d = t.ownerAnalytics;
  const thin = baseline.days < 30;

  // An unmeasured input starts as null — "set a value" — never as 0: a 0 there would draw invented dollars as a projection.
  // Growth has no measurement and starts flat; cash is the owner's own number.
  const initial: Record<Key, number | null> = {
    newUsersPerMonth: baseline.newUsersPerMonth.value === null ? null : Math.round(baseline.newUsersPerMonth.value * 10) / 10,
    growth: 0,
    conversion: baseline.conversion.value,
    churn: baseline.churn.value,
    arpu: baseline.arpu.value,
    costPerPayer: baseline.costPerPayer.value,
    fixedMonthly: baseline.fixedMonthly.value,
    cash: 0,
  };
  const [v, setV] = useState(initial);
  const scale = (n: number | null, by: number, floor: number) => Math.max(floor, Math.ceil(((n ?? 0) * 4) / by) * by);

  const specs: SliderSpec[] = [
    { key: "newUsersPerMonth", label: d.sliderNewUsers, min: 0, max: scale(initial.newUsersPerMonth, 10, 100), step: 0.5, kind: "count", measured: baseline.newUsersPerMonth },
    { key: "growth", label: d.sliderGrowth, min: -0.2, max: 0.5, step: 0.01, kind: "pct", measured: null },
    { key: "conversion", label: d.sliderConversion, min: 0, max: 0.5, step: 0.005, kind: "pct", measured: baseline.conversion },
    { key: "churn", label: d.sliderChurn, min: 0, max: 0.5, step: 0.005, kind: "pct", measured: baseline.churn },
    { key: "arpu", label: d.sliderArpu, min: 0, max: scale(initial.arpu, 10, 100), step: 0.5, kind: "usd", measured: baseline.arpu },
    { key: "costPerPayer", label: d.sliderCostPerPayer, min: 0, max: scale(initial.costPerPayer, 10, 50), step: 0.1, kind: "usd", measured: baseline.costPerPayer },
    { key: "fixedMonthly", label: d.sliderFixed, min: 0, max: scale(initial.fixedMonthly, 1000, 5000), step: 10, kind: "usd", measured: baseline.fixedMonthly },
    { key: "cash", label: d.sliderCash, min: 0, max: 500000, step: 500, kind: "usd", measured: null },
  ];

  const unset = REQUIRED.filter((k) => v[k] === null);
  const ready = unset.length === 0;
  const num = (k: Key) => v[k] ?? 0;
  const cash = num("cash");
  // Only shown once every required input is known: `num` stands in for null only to keep the hook's inputs plain numbers.
  const inputs: ScenarioInputs = {
    newUsersPerMonth: num("newUsersPerMonth"),
    growth: num("growth"),
    conversion: num("conversion"),
    churn: num("churn"),
    arpu: num("arpu"),
    costPerPayer: num("costPerPayer"),
    fixedMonthly: num("fixedMonthly"),
    cash,
    startingPayers: baseline.payers.value ?? 0,
  };
  const proj = useMemo(() => project(inputs), [inputs.newUsersPerMonth, inputs.growth, inputs.conversion, inputs.churn, inputs.arpu, inputs.costPerPayer, inputs.fixedMonthly, inputs.cash, inputs.startingPayers]); // eslint-disable-line react-hooks/exhaustive-deps
  const basisText = (m: Measured<number>) =>
    fill(m.unit === "days" ? d.basisDays : m.unit === "people" ? d.basisPeople : m.unit === "months" ? d.basisMonths : d.basisSubscriptions, { n: m.basis });

  const fmt = (kind: SliderSpec["kind"], n: number) => (kind === "pct" ? pct(n, locale) : kind === "usd" ? usd(n, locale) : int(n, locale));
  const last = history.length ? history[history.length - 1].x : null;
  const futureX = (m: number) => {
    if (!last) return `+${m}`;
    const [y, mo] = last.split("-").map(Number);
    const dt = new Date(Date.UTC(y, mo - 1 + m, 1));
    return dt.toISOString().slice(0, 7);
  };
  const lastY = history.length ? history[history.length - 1].y : null;
  const series: Series[] = [{ key: "measured", label: `${d.mrr} · ${d.measured}`, points: history }];
  if (ready) {
    series.push({
      key: "projected",
      label: d.mrr,
      projected: true,
      // The projection starts where the measurement ends, so the two lines meet instead of leaving a gap.
      points: [
        ...(last ? [{ x: last, y: lastY, lo: lastY, hi: lastY }] : []),
        ...proj.mid.map((pt, i) => ({ x: futureX(pt.month), y: pt.mrr, lo: Math.min(proj.low[i].mrr, proj.high[i].mrr), hi: Math.max(proj.low[i].mrr, proj.high[i].mrr) })),
      ],
    });
  }
  const labelOf = (k: Key) => specs.find((s) => s.key === k)!.label;

  return (
    <section className="oa-card" aria-label={d.forecastTitle}>
      <h2>{d.forecastTitle}</h2>
      <p className="oa-note">{fill(d.forecastNote, { spread: pct(BAND_SPREAD, locale) })}</p>
      <p className="oa-note" data-tone={thin ? "warn" : undefined}>
        {thin ? fill(d.baselineThin, { n: baseline.days }) : fill(d.baselineFrom, { n: baseline.days })}
      </p>
      <div className="oa-sliders">
        {specs.map((s) => {
          const measured = s.measured !== null && s.measured.value !== null;
          const value = v[s.key];
          return (
            <label key={s.key} className="oa-slider">
              <span className="oa-slider-head">
                <span>{s.label}</span>
                <span className="oa-num" data-tone={value === null ? "warn" : undefined}>
                  {value === null ? d.setAValue : fmt(s.kind, value)}
                </span>
              </span>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={value ?? s.min}
                onChange={(e) => setV((o) => ({ ...o, [s.key]: Number(e.target.value) }))}
                onInput={(e) => setV((o) => ({ ...o, [s.key]: Number((e.target as HTMLInputElement).value) }))}
                aria-valuetext={value === null ? d.setAValue : fmt(s.kind, value)}
              />
              <span className="oa-badge" data-tone={measured ? undefined : "warn"}>
                {measured ? `${d.measured} · ${basisText(s.measured!)}` : d.assumption}
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
      {!ready && (
        <p className="oa-note" data-tone="warn" role="status">
          {fill(d.forecastNeedsInputs, { inputs: unset.map(labelOf).join(", ") })}
        </p>
      )}
      <LineChart
        series={series}
        title={d.mrrHistory}
        format={(n) => usd(n, locale, true)}
        labels={{ unknown: d.unknown, projection: d.projection, noData: d.noData, show: d.legendShow, hide: d.legendHide }}
      />

      {ready && (
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
                  <td className="oa-num">{cash > 0 ? usd(m.cash, locale) : d.runwayNoCash}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
      {ready && (
        <p className="oa-note">
          {d.runway}:{" "}
          {cash <= 0 ? d.runwayNoCash : proj.runwayMonths === null ? d.runwayNone : fill(d.runwayMonths, { n: proj.runwayMonths })}
        </p>
      )}
    </section>
  );
}
