"use client";

import { useI18n } from "@/lib/i18n/context";
import { usd, int, pct } from "@/lib/owner-analytics/format";
import { BarList, LineChart, type BarDatum, type Series } from "./Charts";

/**
 * A line chart whose points lead to their table row: click (or Enter on) a point and the row below scrolls into view and is
 * highlighted. The chart itself holds no number the table does not.
 */
export function DrillChart({
  series,
  tableId,
  title,
  unit,
}: {
  series: Series[];
  tableId: string;
  title: string;
  unit: "usd" | "count";
}) {
  const { t, locale } = useI18n();
  const d = t.ownerAnalytics;
  const format = unit === "usd" ? (n: number) => usd(n, locale, true) : (n: number) => int(n, locale);
  return (
    <>
      <LineChart
        series={series}
        title={title}
        format={format}
        labels={{ unknown: d.unknown, projection: d.projection, noData: d.noData, show: d.legendShow, hide: d.legendHide }}
        onSelectX={(x) => {
          const row = document.getElementById(`${tableId}-${x}`);
          if (!row) return;
          document.querySelectorAll(`#${CSS.escape(tableId)} tr[data-focus]`).forEach((r) => r.removeAttribute("data-focus"));
          row.setAttribute("data-focus", "");
          const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          row.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
        }}
      />
      {series.some((x) => x.points.some((pt) => pt.y !== null)) && <p className="oa-note">{d.drillHint}</p>}
    </>
  );
}

export function Bars({ data, unit }: { data: BarDatum[]; unit: "usd" | "count" | "pct" }) {
  const { t, locale } = useI18n();
  const d = t.ownerAnalytics;
  const format =
    unit === "usd" ? (n: number) => usd(n, locale, true) : unit === "pct" ? (n: number) => pct(n, locale) : (n: number) => int(n, locale);
  return <BarList data={data} format={format} labels={{ unknown: d.unknown, noData: d.noData }} />;
}
