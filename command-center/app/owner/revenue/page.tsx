import { getDictionary } from "@/lib/i18n/server";
import { OwnerPage, OwnerTools } from "@/components/owner-console/OwnerPage";
import { AsOf, FactValue, FactsUnavailable, Gap, Kpi, Kpis } from "@/components/owner-console/OwnerFacts";
import { ownerSection } from "@/lib/owner-console/nav";
import { int, pct, usd } from "@/lib/owner-analytics/format";
import { mfaVerifyUrl } from "@/lib/security/admin-mfa";
import { requireOwnerConsole } from "@/lib/server/owner-console";
import { loadOwnerFacts } from "../_facts";

export const dynamic = "force-dynamic";

/** Owner Console — Revenue, from the owner's facts (0182's money rows: the same figures as Owner Analytics). Read-only. */
export default async function OwnerConsoleRevenue() {
  await requireOwnerConsole();
  const { t, locale } = await getDictionary();
  const c = t.ownerConsole;
  const f = c.facts;
  const r = f.revenue;
  const head = { title: c.sections.revenue.title, subtitle: c.sections.revenue.subtitle };
  const load = await loadOwnerFacts();
  if (!load.ok) {
    return (
      <OwnerPage {...head}>
        <FactsUnavailable kind={load.kind} f={f} verifyHref={mfaVerifyUrl("/owner/revenue")} retryHref="/owner/revenue" />
      </OwnerPage>
    );
  }
  const rev = load.facts.revenue;
  const money = (v: number) => usd(v, locale);
  const n = (v: number) => int(v, locale);

  return (
    <OwnerPage {...head}>
      <div className="oc-stack">
        {rev.state === "unknown" ? (
          <Gap why={rev.why} f={f} />
        ) : (
          <>
            <AsOf iso={rev.as_of} f={f} />
            <Kpis label={r.title}>
              <Kpi label={r.net7}><FactValue fact={rev.value.net_before_fees_7d} f={f} format={money} /></Kpi>
              <Kpi label={r.net30}><FactValue fact={rev.value.net_before_fees_30d} f={f} format={money} /></Kpi>
              <Kpi label={f.kpi.mrr}><FactValue fact={rev.value.mrr} f={f} format={money} /></Kpi>
              <Kpi label={f.kpi.churn}><FactValue fact={rev.value.monthly_churn_30d} f={f} format={(v) => pct(v, locale)} /></Kpi>
            </Kpis>
            <h2 className="oc-h2">{r.title}</h2>
            <Kpis label={r.title}>
              <Kpi label={r.sales}><span className="oc-val">{n(rev.value.sales_30d)}</span></Kpi>
              <Kpi label={r.refunds}><span className="oc-val">{n(rev.value.refunds_30d)}</span></Kpi>
              <Kpi label={r.disputes}><span className="oc-val">{n(rev.value.disputes_30d)}</span></Kpi>
              <Kpi label={r.payingWorkspaces}><span className="oc-val">{n(rev.value.paying_workspaces_30d)}</span></Kpi>
              <Kpi label={r.otherCurrency}><span className="oc-val">{n(rev.value.other_currency_payments_30d)}</span></Kpi>
            </Kpis>
            {rev.value.truncated && (
              <p className="oc-note" data-tone="warn" role="status">
                {r.truncated}
              </p>
            )}
            <p className="oc-note">{r.note}</p>
          </>
        )}
        <OwnerTools section={ownerSection("revenue")} c={c} note={f.moreTools} />
      </div>
    </OwnerPage>
  );
}
