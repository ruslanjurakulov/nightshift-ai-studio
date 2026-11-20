import { CardHead, HubFrame, HubState, Kpi, hubContext } from "@/components/owner-analytics/HubFrame";
import { DrillChart } from "@/components/owner-analytics/DrillChart";
import { DataTable } from "@/components/owner-analytics/DataTable";
import { readActivityFor, readMoneyFor } from "@/lib/server/owner-analytics-data";
import { overviewTable, revenueKpis, revenueSeriesTable } from "@/lib/owner-analytics/kpis";
import { moneySeries } from "@/lib/owner-analytics/money";
import { fill, int, pct, usd } from "@/lib/owner-analytics/format";
import "./owner-analytics.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Owner analytics — overview. The platform owner's headline figures for a period, each measured from the platform's own records
 * (migration 0182) or shown as unknown with the reason. Owner-only: the database refuses everyone else, admins included; this
 * page asks first so a customer who types the URL learns nothing.
 *
 * Read as the signed-in owner through the anon key; no service key. Nothing here writes, spends or publishes.
 */
export default async function OwnerAnalyticsOverview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { access, ctx } = await hubContext(await searchParams);
  if (access !== "owner") return <HubState state={access} ctx={ctx} />;
  const { d, sel, locale } = ctx;

  const [money, activity] = await Promise.all([readMoneyFor(sel), readActivityFor(sel)]);
  if (!money.ok) return <HubState state={money.reason} ctx={ctx} />;
  const act = activity && activity.ok ? activity.data : null;

  const k = revenueKpis(money.data, act, sel.current);
  const prev = sel.previous ? revenueKpis(money.data, act, sel.previous) : null;
  const s = k.summary;
  const money$ = (n: number) => usd(n, locale);
  const floor = (n: number) => (n > 0 ? d.incomplete : undefined);

  const series = moneySeries(money.data, sel.current);
  const table = revenueSeriesTable(d, money.data, sel.current, ctx.present);

  return (
    <HubFrame ctx={ctx} section="overview">
      {money.truncated && <p className="oa-note" data-tone="warn">{d.truncated}</p>}
      <section className="oa-grid-kpi" aria-label={d.tabOverview}>
        <Kpi ctx={ctx} label={d.gross} value={s.gross.usd} previous={prev?.summary.gross.usd} format={money$} badge={floor(s.gross.unknownCount)} />
        <Kpi ctx={ctx} label={d.refunds} value={s.refunds.usd} previous={prev?.summary.refunds.usd} format={money$} invert badge={floor(s.refunds.unknownCount)} />
        <Kpi ctx={ctx} label={d.disputes} value={s.disputes.usd} previous={prev?.summary.disputes.usd} format={money$} invert badge={floor(s.disputes.unknownCount)} />
        <Kpi ctx={ctx} label={d.fees} value={null} format={money$} note={d.feesUnknown} />
        <Kpi ctx={ctx} label={d.net} value={s.netBeforeFees.usd} previous={prev?.summary.netBeforeFees.usd} format={money$} badge={floor(s.netBeforeFees.unknownCount)} />
        <Kpi ctx={ctx} label={d.sales} value={s.sales} previous={prev?.summary.sales} format={(n) => int(n, locale)} />
        <Kpi ctx={ctx} label={d.mrr} value={k.mrr.usd} previous={prev?.mrr.usd} format={money$} unknownText={d.noSubscriptions} note={d.mrrNote} badge={k.mrr.incomplete ? d.incomplete : undefined} />
        <Kpi ctx={ctx} label={d.arr} value={k.arr} previous={prev?.arr} format={money$} unknownText={d.noSubscriptions} />
        <Kpi ctx={ctx} label={d.arpu} value={k.arpu} previous={prev?.arpu} format={money$} note={d.arpuNote} unknownText={act ? d.notEnoughData : d.unknown} />
        <Kpi ctx={ctx} label={d.arppu} value={k.arppu} previous={prev?.arppu} format={money$} note={d.arppuNote} unknownText={d.notEnoughData} />
        <Kpi ctx={ctx} label={d.subscribers} value={k.mrr.usd === null ? null : k.mrr.subscribers} previous={prev && prev.mrr.usd !== null ? prev.mrr.subscribers : undefined} format={(n) => int(n, locale)} unknownText={d.noSubscriptions} />
        <Kpi
          ctx={ctx}
          label={d.churn}
          value={k.churn.rate}
          previous={prev?.churn.rate}
          format={(n) => pct(n, locale)}
          invert
          unknownText={fill(d.notEnoughDataN, { n: k.churn.base })}
        />
        <Kpi
          ctx={ctx}
          label={d.ltv}
          value={k.ltv}
          previous={prev?.ltv}
          format={money$}
          badge={d.estimate}
          note={d.ltvNote}
          unknownText={k.churn.rate === 0 ? d.ltvNoChurn : fill(d.notEnoughDataN, { n: k.churn.base })}
        />
      </section>
      {s.netBeforeFees.unknownCount > 0 && <p className="oa-note" data-tone="warn">{fill(d.incompleteNote, { n: s.netBeforeFees.unknownCount })}</p>}
      {s.otherCurrency.length > 0 && <p className="oa-note">{fill(d.otherCurrency, { n: s.otherCurrency.reduce((a, o) => a + o.count, 0) })}</p>}
      {s.internalExcluded > 0 && <p className="oa-note">{fill(d.internalExcluded, { n: s.internalExcluded })}</p>}

      <section className="oa-card">
        <CardHead title={d.revenueOverTime} what="revenue.series" ctx={ctx} />
        <DrillChart
          tableId="oa-overview-series"
          title={d.revenueOverTime}
          unit="usd"
          series={[
            { key: "gross", label: d.gross, points: series.map((p) => ({ x: p.x, y: p.gross })) },
            { key: "net", label: d.net, points: series.map((p) => ({ x: p.x, y: p.net })) },
            { key: "refunds", label: d.refunds, points: series.map((p) => ({ x: p.x, y: p.refunds })) },
          ]}
        />
        <DataTable table={table} id="oa-overview-series" unknownText={d.unknown} format={[undefined, money$, money$, money$]} />
      </section>

      <section className="oa-card">
        <CardHead title={d.tabOverview} what="overview.kpis" ctx={ctx} note={`${d.fees}: ${d.feesUnknown}`} />
        <DataTable table={overviewTable(d, k, prev, sel.current, ctx.present)} id="oa-overview-kpis" unknownText={d.unknown} />
      </section>
    </HubFrame>
  );
}
