import { CardHead, HubFrame, HubState, Kpi, hubContext } from "@/components/owner-analytics/HubFrame";
import { Bars } from "@/components/owner-analytics/DrillChart";
import { DataTable } from "@/components/owner-analytics/DataTable";
import { BalanceForm, CostEntryForm, DeleteCost } from "@/components/owner-analytics/CostForms";
import { readBalances, readCostEntries } from "@/lib/server/owner-analytics";
import { readMoneyFor, readSpendFor } from "@/lib/server/owner-analytics-data";
import { grossProfit, monthlyResults, summarizeSpend } from "@/lib/owner-analytics/costs";
import { costEntriesTable, monthlyTable, spendModelsTable, spendProvidersTable } from "@/lib/owner-analytics/cost-tables";
import { applyScope } from "@/lib/owner-analytics/money";
import { tashkentDay, tashkentDayStartUtc } from "@/lib/owner-analytics/period";
import { fill, int, num, pct, tashkentDateTime, usd } from "@/lib/owner-analytics/format";
import "../owner-analytics.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Owner analytics — costs and profit (migration 0184). Provider spend from what each job's provider cost when it ran, balances
 * only where the provider reports one (or the owner typed one in, and it says so), and the owner's own monthly costs. Profit is
 * computed here, at request time, for this screen only: it is never stored, published or logged.
 */
export default async function OwnerAnalyticsCosts({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { access, ctx } = await hubContext(await searchParams);
  if (access !== "owner") return <HubState state={access} ctx={ctx} />;
  const { d, sel, locale, present } = ctx;
  const p = sel.current;

  const [money, spend, balances, entries] = await Promise.all([
    readMoneyFor(sel),
    readSpendFor(sel),
    readBalances(),
    readCostEntries(`${(sel.previous ?? p).startDay.slice(0, 7)}-01`, `${p.endDay.slice(0, 7)}-01`),
  ]);
  if (!money.ok) return <HubState state={money.reason} ctx={ctx} />;
  if (!spend.ok) {
    if (spend.reason === "missing") {
      return (
        <HubFrame ctx={ctx} section="costs">
          <p className="oa-note">{d.costsNotEnabled}</p>
        </HubFrame>
      );
    }
    return <HubState state={spend.reason} ctx={ctx} />;
  }
  const inc = sel.includeInternal;
  const rows = applyScope(money.data, inc);
  const spendRows = applyScope(spend.data, inc);
  const sp = summarizeSpend(spendRows, p);
  const prevSp = sel.previous ? summarizeSpend(spendRows, sel.previous) : null;
  const gp = grossProfit(rows, sp, p);
  const prevGp = sel.previous && prevSp ? grossProfit(rows, prevSp, sel.previous) : null;
  const costEntries = entries.ok ? entries.data : [];
  const months = monthlyResults(rows, spendRows, costEntries, p, tashkentDayStartUtc);
  const money$ = (n: number) => usd(n, locale);
  const n$ = (n: number) => int(n, locale);

  return (
    <HubFrame ctx={ctx} section="costs">
      <p className="oa-note">{d.costsOwnerOnly}</p>
      {(money.truncated || spend.truncated) && <p className="oa-note" data-tone="warn">{d.truncated}</p>}
      <section className="oa-grid-kpi" aria-label={d.tabCosts}>
        {/* A change is computed only between two complete figures: a floor against a total is not a trend. */}
        <Kpi
          ctx={ctx}
          label={d.providerSpend}
          value={sp.customer.usd}
          previous={prevSp && prevSp.customer.unpriced === 0 && sp.customer.unpriced === 0 ? prevSp.customer.usd : undefined}
          previousIncomplete={Boolean(prevSp && (prevSp.customer.unpriced > 0 || sp.customer.unpriced > 0))}
          format={money$}
          invert
          badge={sp.customer.unpriced > 0 ? d.incomplete : undefined}
        />
        {/* With internal workspaces included they are folded into the line above; a $0 here would look measured. */}
        <Kpi
          ctx={ctx}
          label={d.internalSpend}
          value={inc ? null : sp.internal.usd}
          unknownText={d.includedAbove}
          format={money$}
          badge={!inc && (sp.internal.unpriced > 0 || sp.undated > 0) ? d.incomplete : undefined}
        />
        <Kpi ctx={ctx} label={d.net} value={gp.net} previous={prevGp?.net} format={money$} unknownText={d.incomplete} />
        <Kpi ctx={ctx} label={d.grossProfit} value={gp.grossProfit} previous={prevGp?.grossProfit} format={money$} unknownText={d.unknown} note={`${d.fees}: ${d.feesUnknown}`} />
        <Kpi ctx={ctx} label={d.grossMargin} value={gp.margin} previous={prevGp?.margin} format={(n) => pct(n, locale)} unknownText={d.unknown} />
      </section>
      {sp.undated > 0 && <p className="oa-note" data-tone="warn">{fill(d.undatedNote, { n: n$(sp.undated) })}</p>}
      {sp.customer.unpriced + sp.internal.unpriced > 0 && (
        <p className="oa-note" data-tone="warn">{fill(d.unpricedNote, { n: n$(sp.customer.unpriced + sp.internal.unpriced) })}</p>
      )}

      <div className="oa-cols">
        <section className="oa-card">
          <CardHead title={d.spendByProvider} what="costs.providers" ctx={ctx} />
          <Bars
            unit="usd"
            data={sp.byProvider.map((x) => ({
              key: `${x.source}:${x.provider}`,
              label: `${x.provider} · ${x.source === "pipeline" ? d.sourcePipeline : d.sourceCreative}`,
              value: x.total.unpriced + x.internal.unpriced > 0 ? null : x.total.usd + x.internal.usd,
              note: `${d.costRows}: ${n$(x.total.rows + x.internal.rows)} · ${d.unpriced}: ${n$(x.total.unpriced + x.internal.unpriced)}`,
            }))}
          />
          <DataTable table={spendProvidersTable(d, sp, p, present)} id="oa-costs-providers" unknownText={d.unknown} emptyText={d.noData} format={[undefined, undefined, money$, n$, n$, money$]} />
        </section>
        <section className="oa-card">
          <CardHead title={d.spendByModel} what="costs.models" ctx={ctx} />
          <DataTable table={spendModelsTable(d, sp, p, present)} id="oa-costs-models" unknownText={d.unknown} emptyText={d.noData} format={[undefined, undefined, money$, n$, n$]} />
        </section>
      </div>

      <section className="oa-card">
        <CardHead title={d.monthly} what="costs.monthly" ctx={ctx} note={d.monthlyNote} />
        <DataTable
          table={monthlyTable(d, months, p, present)}
          id="oa-costs-monthly"
          unknownText={d.unknown}
          emptyText={d.noData}
          format={[undefined, undefined, money$, money$, money$, money$, money$]}
          nullText={[undefined, undefined, undefined, undefined, undefined, d.notEntered, undefined]}
        />
      </section>

      <section className="oa-card">
        <CardHead title={d.costEntries} what="costs.entries" ctx={ctx} />
        {!entries.ok ? (
          <p className="oa-note" data-tone="warn">{entries.reason === "missing" ? d.costsNotEnabled : d.readFailed}</p>
        ) : (
          <>
            <div className="oa-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{d.month}</th>
                    <th scope="col">{d.category}</th>
                    <th scope="col" className="oa-num">{d.amount}</th>
                    {!present && <th scope="col">{d.note}</th>}
                    {!present && <th scope="col">{d.tableActions}</th>}
                  </tr>
                </thead>
                <tbody>
                  {costEntryRows(costEntriesTable(d, costEntries, p, present).rows, costEntries, money$, present)}
                </tbody>
              </table>
            </div>
            {costEntries.length === 0 && <p className="oa-empty">{d.noData}</p>}
            {!present && <CostEntryForm maxMonth={tashkentDay(ctx.now)} />}
          </>
        )}
      </section>

      <section className="oa-card">
        <CardHead title={d.balances} ctx={ctx} note={d.balancesNote} />
        {!balances.ok ? (
          <p className="oa-note" data-tone="warn">{d.readFailed}</p>
        ) : balances.data.length === 0 ? (
          <p className="oa-empty">{d.noBalances}</p>
        ) : (
          <div className="oa-table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{d.providerName}</th>
                  <th scope="col">{d.metric}</th>
                  <th scope="col" className="oa-num">{d.remaining}</th>
                  <th scope="col">{d.unit}</th>
                  <th scope="col">{d.source}</th>
                </tr>
              </thead>
              <tbody>
                {balances.data.map((b) => (
                  <tr key={`${b.provider}:${b.metric}:${b.source}`}>
                    <th scope="row">{b.provider}</th>
                    <td>{b.metric}</td>
                    <td className="oa-num">{b.remaining === null ? d.unknown : num(b.remaining, locale, 2)}</td>
                    <td>{b.unit}</td>
                    <td>
                      {b.source === "manual" ? (
                        <span className="oa-badge" data-tone="warn">{fill(d.enteredByOwner, { date: tashkentDateTime(b.checkedAt) })}</span>
                      ) : (
                        `${d.fromApi} · ${tashkentDateTime(b.checkedAt)}`
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!present && (
          <>
            <h2>{d.enterBalance}</h2>
            <BalanceForm />
          </>
        )}
      </section>
    </HubFrame>
  );
}

function costEntryRows(cells: Array<Array<string | number | null>>, entries: Array<{ id: number }>, money$: (n: number) => string, present: boolean) {
  return cells.map((r, i) => (
    <tr key={entries[i].id}>
      <th scope="row">{r[0]}</th>
      <td>{r[1]}</td>
      <td className="oa-num">{typeof r[2] === "number" ? money$(r[2]) : r[2]}</td>
      {!present && <td>{r[3] ?? ""}</td>}
      {!present && (
        <td>
          <DeleteCost id={entries[i].id} />
        </td>
      )}
    </tr>
  ));
}
