import { CardHead, HubFrame, HubState, Kpi, hubContext } from "@/components/owner-analytics/HubFrame";
import { DrillChart } from "@/components/owner-analytics/DrillChart";
import { DataTable } from "@/components/owner-analytics/DataTable";
import { InternalOrgs } from "@/components/owner-analytics/InternalOrgs";
import { readInternalOrgs } from "@/lib/server/owner-analytics";
import { readActivityFor, readMoneyFor } from "@/lib/server/owner-analytics-data";
import { overviewTable, revenueKpis, revenueSeriesTable } from "@/lib/owner-analytics/kpis";
import { applyScope, moneySeries, type RevenueSummary } from "@/lib/owner-analytics/money";
import { fill, int, pct, usd } from "@/lib/owner-analytics/format";
import "./owner-analytics.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** A previous figure that is incomplete is not compared against: the change would be measured from a floor. */
const known = (a: { usd: number; unknownCount: number } | undefined) => (a && a.unknownCount === 0 ? a.usd : undefined);

/**
 * Owner analytics — overview. The platform owner's headline figures for a period, each measured from the platform's own records
 * (migration 0182) or shown as unknown with the reason. Owner-only: the database refuses everyone else, admins included; this
 * page asks first so a customer who types the URL learns nothing.
 *
 * Read as the signed-in owner through the anon key; no service key. Nothing here spends or publishes; the one write is the
 * owner's internal-workspace flag, which changes only what the hub counts.
 */
export default async function OwnerAnalyticsOverview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { access, ctx } = await hubContext(await searchParams);
  if (access !== "owner") return <HubState state={access} ctx={ctx} />;
  const { d, sel, locale } = ctx;

  const [money, activity, internal] = await Promise.all([readMoneyFor(sel), readActivityFor(sel), ctx.present ? null : readInternalOrgs()]);
  if (!money.ok) return <HubState state={money.reason} ctx={ctx} />;
  const rows = applyScope(money.data, sel.includeInternal);
  const act = activity && activity.read.ok ? applyScope(activity.read.data, sel.includeInternal) : null;

  const k = revenueKpis(rows, act, sel.current);
  const prev = sel.previous ? revenueKpis(rows, activity?.previous ? act : null, sel.previous) : null;
  const s = k.summary;
  const ps: RevenueSummary | undefined = prev?.summary;
  const money$ = (n: number) => usd(n, locale);
  const floor = (n: number) => (n > 0 ? d.incomplete : undefined);
  const prevBad = (a: { unknownCount: number } | undefined) => Boolean(a && a.unknownCount > 0);

  const series = moneySeries(rows, sel.current);
  const table = revenueSeriesTable(d, rows, sel.current, ctx.present);
  const truncated = money.truncated || Boolean(activity && activity.read.ok && activity.read.truncated);

  return (
    <HubFrame ctx={ctx} section="overview">
      {truncated && <p className="oa-note" data-tone="warn">{d.truncated}</p>}
      <section className="oa-grid-kpi" aria-label={d.tabOverview}>
        <Kpi ctx={ctx} label={d.gross} value={s.gross.usd} previous={known(ps?.gross)} previousIncomplete={prevBad(ps?.gross)} format={money$} badge={floor(s.gross.unknownCount)} />
        <Kpi ctx={ctx} label={d.refunds} value={s.refunds.usd} previous={known(ps?.refunds)} previousIncomplete={prevBad(ps?.refunds)} format={money$} invert badge={floor(s.refunds.unknownCount)} />
        <Kpi ctx={ctx} label={d.disputes} value={s.disputes.usd} previous={known(ps?.disputes)} previousIncomplete={prevBad(ps?.disputes)} format={money$} invert badge={floor(s.disputes.unknownCount)} />
        <Kpi ctx={ctx} label={d.fees} value={null} format={money$} note={d.feesUnknown} />
        <Kpi ctx={ctx} label={d.net} value={s.netBeforeFees.usd} previous={known(ps?.netBeforeFees)} previousIncomplete={prevBad(ps?.netBeforeFees)} format={money$} badge={floor(s.netBeforeFees.unknownCount)} />
        <Kpi ctx={ctx} label={d.sales} value={s.sales} previous={ps?.sales} format={(n) => int(n, locale)} />
        <Kpi ctx={ctx} label={d.mrr} value={k.mrr.usd} previous={prev?.mrr.incomplete ? undefined : prev?.mrr.usd} previousIncomplete={prev?.mrr.incomplete} format={money$} unknownText={d.noSubscriptions} note={d.mrrNote} badge={k.mrr.incomplete ? d.incomplete : undefined} />
        <Kpi ctx={ctx} label={d.arr} value={k.arr} previous={prev?.mrr.incomplete ? undefined : prev?.arr} previousIncomplete={prev?.mrr.incomplete} format={money$} unknownText={d.noSubscriptions} badge={k.mrr.incomplete ? d.incomplete : undefined} />
        <Kpi ctx={ctx} label={d.arpu} value={k.arpu} previous={prev?.arpu} format={money$} note={d.arpuNote} unknownText={act ? (s.netBeforeFees.unknownCount ? d.incomplete : d.notEnoughData) : d.unknown} />
        <Kpi ctx={ctx} label={d.arppu} value={k.arppu} previous={prev?.arppu} format={money$} note={d.arppuNote} unknownText={s.netBeforeFees.unknownCount ? d.incomplete : d.notEnoughData} />
        <Kpi ctx={ctx} label={d.subscribers} value={k.mrr.usd === null ? null : k.mrr.subscribers} previous={prev && prev.mrr.usd !== null ? prev.mrr.subscribers : undefined} format={(n) => int(n, locale)} unknownText={d.noSubscriptions} />
        <Kpi ctx={ctx} label={d.churn} value={k.churn.rate} previous={prev?.churn.rate} format={(n) => pct(n, locale)} invert note={d.churnNote} unknownText={fill(d.notEnoughDataN, { n: k.churn.base })} />
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
      {s.uncredited.count > 0 && (
        <p className="oa-note" data-tone="warn">
          {fill(d.uncredited, { n: s.uncredited.count, amount: s.uncredited.usd.unknownCount || s.uncredited.otherCurrency ? d.unknown : money$(s.uncredited.usd.usd) })}
        </p>
      )}
      {s.otherCurrency.length > 0 && <p className="oa-note">{fill(d.otherCurrency, { n: s.otherCurrency.reduce((a, o) => a + o.count, 0) })}</p>}
      {s.internalExcluded > 0 && <p className="oa-note">{fill(d.internalExcluded, { n: s.internalExcluded })}</p>}
      {!act && <p className="oa-note">{d.activityNotRead}</p>}

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
        <DataTable table={table} id="oa-overview-series" emptyText={d.noData} unknownText={d.unknown} format={[undefined, money$, money$, money$]} />
      </section>

      <section className="oa-card">
        <CardHead title={d.tabOverview} what="overview.kpis" ctx={ctx} note={`${d.fees}: ${d.feesUnknown}`} />
        <DataTable table={overviewTable(d, k, prev, sel.current, ctx.present)} id="oa-overview-kpis" emptyText={d.noData} unknownText={d.unknown} />
      </section>

      {internal && internal.ok && <InternalOrgs rows={internal.data} />}
      {internal && !internal.ok && <p className="oa-note" data-tone="warn">{d.readFailed}</p>}
    </HubFrame>
  );
}
