import { CardHead, HubFrame, HubState, hubContext } from "@/components/owner-analytics/HubFrame";
import { Bars, DrillChart } from "@/components/owner-analytics/DrillChart";
import { DataTable } from "@/components/owner-analytics/DataTable";
import { readMoneyFor } from "@/lib/server/owner-analytics-data";
import { revenueEventsTable, revenueItemsTable, revenueKindsTable, revenueSeriesTable } from "@/lib/owner-analytics/kpis";
import { applyScope, moneySeries, summarize } from "@/lib/owner-analytics/money";
import { fill, int, usd } from "@/lib/owner-analytics/format";
import "../owner-analytics.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Owner analytics — revenue: where the money came from (plans, packs, API top-ups), how many of each sold, initial vs renewal,
 * and every sale, refund and dispute behind the totals. Migration 0182; owner-only; read-only.
 */
export default async function OwnerAnalyticsRevenue({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { access, ctx } = await hubContext(await searchParams);
  if (access !== "owner") return <HubState state={access} ctx={ctx} />;
  const { d, sel, locale, present } = ctx;

  const money = await readMoneyFor(sel);
  if (!money.ok) return <HubState state={money.reason} ctx={ctx} />;
  const p = sel.current;
  const rows = applyScope(money.data, sel.includeInternal);
  const s = summarize(rows, p);
  const prev = sel.previous ? summarize(rows, sel.previous) : null;
  const money$ = (n: number) => usd(n, locale);
  const n$ = (n: number) => int(n, locale);

  const series = moneySeries(rows, p);
  const prevSeries = sel.previous ? moneySeries(rows, sel.previous) : null;
  const items = revenueItemsTable(d, s, p, present);
  const plans = s.byItem.filter((i) => i.kind === "plan");
  const packs = s.byItem.filter((i) => i.kind === "pack");

  return (
    <HubFrame ctx={ctx} section="revenue">
      {money.truncated && <p className="oa-note" data-tone="warn">{d.truncated}</p>}
      <section className="oa-card">
        <CardHead title={d.revenueOverTime} what="revenue.series" ctx={ctx} note={`${d.fees}: ${d.feesUnknown}`} />
        <DrillChart
          tableId="oa-rev-series"
          title={d.revenueOverTime}
          unit="usd"
          series={[
            { key: "gross", label: d.gross, points: series.map((x) => ({ x: x.x, y: x.gross })) },
            { key: "net", label: d.net, points: series.map((x) => ({ x: x.x, y: x.net })) },
            // The previous period drawn on this period's days, so the two lines share one x-axis.
            ...(prevSeries
              ? [{ key: "prev", label: `${d.gross} · ${d.previous}`, points: prevSeries.slice(0, series.length).map((x, i) => ({ x: series[i].x, y: x.gross })) }]
              : []),
          ]}
        />
        <DataTable table={revenueSeriesTable(d, rows, p, present)} id="oa-rev-series" emptyText={d.noData} unknownText={d.unknown} format={[undefined, money$, money$, money$]} />
        {s.netBeforeFees.unknownCount > 0 && <p className="oa-note" data-tone="warn">{fill(d.incompleteNote, { n: s.netBeforeFees.unknownCount })}</p>}
        {s.otherCurrency.length > 0 && <p className="oa-note">{fill(d.otherCurrency, { n: s.otherCurrency.reduce((a, o) => a + o.count, 0) })}</p>}
        {s.uncredited.count > 0 && (
          <p className="oa-note" data-tone="warn">
            {fill(d.uncredited, { n: s.uncredited.count, amount: s.uncredited.usd.unknownCount || s.uncredited.otherCurrency ? d.unknown : money$(s.uncredited.usd.usd) })}
          </p>
        )}
        {s.internalExcluded > 0 && <p className="oa-note">{fill(d.internalExcluded, { n: s.internalExcluded })}</p>}
      </section>

      <div className="oa-cols">
        <section className="oa-card">
          <CardHead title={d.byKind} what="revenue.kinds" ctx={ctx} />
          <Bars
            unit="usd"
            data={(["plan", "pack", "api_topup", "unknown"] as const).map((k) => ({
              key: k,
              label: k === "plan" ? d.kindPlan : k === "pack" ? d.kindPack : k === "api_topup" ? d.kindApiTopup : d.kindUnknown,
              value: s.byKind[k].gross.unknownCount > 0 ? null : s.byKind[k].gross.usd,
              note: `${d.sales}: ${n$(s.byKind[k].count)}${prev ? ` · ${d.previous}: ${n$(prev.byKind[k].count)}` : ""}`,
            }))}
          />
          <DataTable table={revenueKindsTable(d, s, p, present)} id="oa-rev-kinds" emptyText={d.noData} unknownText={d.unknown} format={[undefined, n$, money$]} />
        </section>
        <section className="oa-card">
          <CardHead title={`${d.planSales} · ${d.packSales}`} what="revenue.items" ctx={ctx} />
          <Bars
            unit="count"
            data={[...plans, ...packs].map((i) => ({
              key: `${i.kind}:${i.item}`,
              label: `${i.kind === "plan" ? d.kindPlan : d.kindPack}: ${i.item === "?" ? d.notRecorded : i.item}`,
              value: i.count,
              note: i.kind === "plan" ? `${d.initial} ${i.initial} · ${d.renewal} ${i.renewal} · ${d.chargeUnknown} ${i.chargeUnknown}` : undefined,
            }))}
          />
          <DataTable table={items} id="oa-rev-items" emptyText={d.noData} unknownText={d.unknown} format={[undefined, undefined, n$, n$, n$, n$, money$]} />
        </section>
      </div>

      <section className="oa-card">
        <CardHead title={d.salesTable} what="revenue.events" ctx={ctx} />
        <DataTable
          table={revenueEventsTable(d, rows, p, present)}
          id="oa-rev-events" emptyText={d.noData}
          unknownText={d.unknown}
          limit={200}
          showingText={(n, total) => fill(d.showingRows, { n: n$(n), total: n$(total) })}
        />
      </section>
    </HubFrame>
  );
}
