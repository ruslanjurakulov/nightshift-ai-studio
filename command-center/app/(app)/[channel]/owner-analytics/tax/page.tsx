import { CardHead, HubFrame, HubState, hubContext } from "@/components/owner-analytics/HubFrame";
import { DataTable } from "@/components/owner-analytics/DataTable";
import { FxForm } from "@/components/owner-analytics/CostForms";
import { readCostEntries, readFxRates } from "@/lib/server/owner-analytics";
import { readMoneyFor } from "@/lib/server/owner-analytics-data";
import { applyScope } from "@/lib/owner-analytics/money";
import { monthlyTotals, periodTotals, quarterlyTotals, registerRows, registerTable, totalsNotes, totalsSummaryTable, totalsTable } from "@/lib/owner-analytics/tax";
import { tashkentDay } from "@/lib/owner-analytics/period";
import { fill, int, num, tashkentDateTime, usd } from "@/lib/owner-analytics/format";
import "../owner-analytics.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Owner analytics — the income register: every sale, refund and dispute in the period, in its own currency, with a UZS
 * equivalent only where the owner froze a rate (migration 0185). Inputs for an accountant; it says so on screen and in every
 * file, and it never claims to be a declaration. The register is for the accountant of NIGHTSHIFT AI STUDIO MCHJ; it computes no tax.
 */
export default async function OwnerAnalyticsTax({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { access, ctx } = await hubContext(await searchParams);
  if (access !== "owner") return <HubState state={access} ctx={ctx} />;
  const { d, sel, locale, present } = ctx;
  const p = sel.current;

  const [money, fx, entries] = await Promise.all([
    readMoneyFor(sel),
    readFxRates(p.startDay, p.endDay),
    readCostEntries(`${p.startDay.slice(0, 7)}-01`, `${p.endDay.slice(0, 7)}-01`),
  ]);
  if (!money.ok) return <HubState state={money.reason} ctx={ctx} />;
  const scoped = applyScope(money.data, sel.includeInternal);
  const rows = registerRows(scoped, fx.ok ? fx.data : [], p);
  // A costs read that failed (or 0184 missing) is "unknown" expenses, never 0.
  const totals = periodTotals(scoped, entries.ok ? entries.data : null, p);
  const totalsTbl = totalsSummaryTable(d, totals, p, present);
  const currencies = [...new Set(rows.map((r) => r.currency).filter((c): c is string => Boolean(c) && c !== "UZS"))];
  const amount = (n: number) => num(n, locale, 2);
  const register = registerTable(d, rows, p, present, totals);
  const amountCols = register.columns.map((c) =>
    [d.gross, d.refunds, d.netTax, d.uzsAmount].includes(c) ? amount : c === d.fxRate ? (n: number) => num(n, locale, 4) : undefined,
  );

  return (
    <HubFrame ctx={ctx} section="tax">
      <p className="oa-present-banner">{d.taxCompanyLine}</p>
      <p className="oa-present-banner">{d.taxNotADeclaration}</p>
      <p className="oa-note">{d.taxFxNote}</p>
      {!fx.ok && <p className="oa-note" data-tone="warn">{fx.reason === "missing" ? d.fxNotEnabled : d.readFailed}</p>}
      {(money.truncated || (fx.ok && fx.truncated)) && <p className="oa-note" data-tone="warn">{d.truncated}</p>}

      <section className="oa-card" aria-label={d.taxTotalsTitle}>
        <CardHead title={d.taxTotalsTitle} what="tax.totals" ctx={ctx} formats={["xlsx", "pdf", "csv"]} />
        <DataTable
          table={{ ...totalsTbl, columns: totalsTbl.columns.slice(0, 3), rows: totalsTbl.rows.map((r) => r.slice(0, 3)) }}
          id="oa-tax-totals"
          unknownText={d.unknown}
          emptyText={d.noData}
          format={[undefined, (n) => usd(n, locale)]}
        />
        <ul className="oa-list">
          <li>{d.taxIncomeSource}</li>
          <li>{d.taxExpensesSource}</li>
          <li>{d.taxBeforeTaxSource}</li>
        </ul>
        {totalsNotes(d, totals).map((n) => (
          <p key={n} className="oa-note" data-tone="warn">{n}</p>
        ))}
      </section>

      <section className="oa-card">
        <CardHead title={d.taxRegister} what="tax.register" ctx={ctx} formats={["xlsx", "pdf", "csv"]} />
        <DataTable
          table={register}
          id="oa-tax-register"
          unknownText={d.unknown}
          emptyText={d.noData}
          format={amountCols}
          limit={300}
          showingText={(n, total) => fill(d.showingRows, { n: int(n, locale), total: int(total, locale) })}
        />
      </section>

      <div className="oa-cols">
        <section className="oa-card">
          <CardHead title={d.monthlyTotals} what="tax.monthly" ctx={ctx} formats={["xlsx", "pdf", "csv"]} />
          <DataTable
            table={totalsTable(d, monthlyTotals(rows), d.monthlyTotals, p, present)}
            id="oa-tax-monthly"
            unknownText={d.incomplete}
            emptyText={d.noData}
            format={[undefined, undefined, (n) => int(n, locale), amount, amount, (n) => int(n, locale)]}
          />
        </section>
        <section className="oa-card">
          <CardHead title={d.quarterlyTotals} what="tax.quarterly" ctx={ctx} formats={["xlsx", "pdf", "csv"]} />
          <DataTable
            table={totalsTable(d, quarterlyTotals(rows), d.quarterlyTotals, p, present)}
            id="oa-tax-quarterly"
            unknownText={d.incomplete}
            emptyText={d.noData}
            format={[undefined, undefined, (n) => int(n, locale), amount, amount, (n) => int(n, locale)]}
          />
        </section>
      </div>

      {fx.ok && !present && (
        <section className="oa-card">
          <CardHead title={d.fxTitle} ctx={ctx} note={d.fxNote} />
          {fx.data.length > 0 && (
            <div className="oa-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{d.fxDate}</th>
                    <th scope="col">{d.currency}</th>
                    <th scope="col" className="oa-num">{d.fxRate}</th>
                    <th scope="col">{d.fxSource}</th>
                    <th scope="col">{d.fxEnteredAt}</th>
                  </tr>
                </thead>
                <tbody>
                  {fx.data.map((r) => (
                    <tr key={`${r.day}:${r.currency}`}>
                      <th scope="row">{r.day}</th>
                      <td>{r.currency}</td>
                      <td className="oa-num">{num(r.uzsPerUnit, locale, 4)}</td>
                      <td>{r.source}</td>
                      <td>{r.enteredAt ? tashkentDateTime(r.enteredAt) : d.unknown}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <FxForm maxDay={tashkentDay(ctx.now)} currencies={currencies.length ? currencies : ["USD"]} period={{ startDay: p.startDay, endDay: p.endDay }} />
        </section>
      )}

      <section className="oa-card">
        <h2>{d.taxSourcesTitle}</h2>
        <p className="oa-note">{d.taxSourcesNote}</p>
        <ul className="oa-list">
          <li>{d.taxPointAccountant}</li>
          <li>{d.taxPointFigures}</li>
        </ul>
      </section>
    </HubFrame>
  );
}
