import { getDictionary } from "@/lib/i18n/server";
import { OwnerPage, OwnerTools } from "@/components/owner-console/OwnerPage";
import { AsOf, Count, FactValue, FactsUnavailable, Gap, Kpi, Kpis, Tag } from "@/components/owner-console/OwnerFacts";
import { ownerSection } from "@/lib/owner-console/nav";
import { block, healthView, peopleView } from "@/lib/owner-console/facts-view";
import { fill, int, pct, usd } from "@/lib/owner-analytics/format";
import { mfaVerifyUrl } from "@/lib/security/admin-mfa";
import { requireOwnerConsole } from "@/lib/server/owner-console";
import { loadOwnerFacts } from "./_facts";

export const dynamic = "force-dynamic";

/**
 * Owner Console — Overview: the platform at a glance, from the owner's facts. It checks the platform owner itself first (the
 * layout's 404 is not a lock on a page). Read-only: every tile links on to the page that holds its detail.
 */
export default async function OwnerConsoleOverview() {
  await requireOwnerConsole();
  const { t, locale } = await getDictionary();
  const c = t.ownerConsole;
  const f = c.facts;
  const load = await loadOwnerFacts();
  if (!load.ok) {
    return (
      <OwnerPage title={c.sections.overview.title} subtitle={c.sections.overview.subtitle}>
        <FactsUnavailable kind={load.kind} f={f} verifyHref={mfaVerifyUrl("/owner")} retryHref="/owner" />
      </OwnerPage>
    );
  }
  const { facts } = load;
  const people = block(facts.people);
  const health = block(facts.health);
  const p = people.ok ? peopleView(people.doc) : null;
  const h = health.ok ? healthView(health.doc) : null;
  const rev = facts.revenue.state === "unknown" ? null : facts.revenue.value;
  const plan = facts.providers.state === "unknown" ? null : facts.providers.value.plan;
  const money = (v: number) => usd(v, locale);
  const n = (v: number) => int(v, locale);

  return (
    <OwnerPage title={c.sections.overview.title} subtitle={c.sections.overview.subtitle}>
      <div className="oc-stack">
        <AsOf iso={facts.as_of} f={f} />
        <Kpis label={c.sections.overview.title}>
          <Kpi label={f.kpi.signups7d}>{p ? <Count n={p.signups.d7} f={f} format={n} /> : <Gap why={people.ok ? "" : people.why} f={f} inline />}</Kpi>
          <Kpi label={f.kpi.paying}>{p ? <Count n={p.payingTotal} f={f} format={n} /> : <Gap why={people.ok ? "" : people.why} f={f} inline />}</Kpi>
          <Kpi label={f.kpi.net30d}>
            {rev ? <FactValue fact={rev.net_before_fees_30d} f={f} format={money} /> : <Gap why={facts.revenue.state === "unknown" ? facts.revenue.why : ""} f={f} inline />}
          </Kpi>
          <Kpi label={f.kpi.mrr}>{rev ? <FactValue fact={rev.mrr} f={f} format={money} /> : <Gap why={facts.revenue.state === "unknown" ? facts.revenue.why : ""} f={f} inline />}</Kpi>
          <Kpi label={f.kpi.churn}>{rev ? <FactValue fact={rev.monthly_churn_30d} f={f} format={(v) => pct(v, locale)} /> : <Gap why={facts.revenue.state === "unknown" ? facts.revenue.why : ""} f={f} inline />}</Kpi>
          <Kpi label={f.kpi.due} hint={plan && plan.unknown.length > 0 ? `${f.providers.unknown}: ${plan.unknown.length}` : undefined}>
            {plan ? (
              plan.due.length + plan.unknown.length + plan.fine.length === 0 ? (
                <span className="oc-why">{f.providers.none}</span>
              ) : (
                <span className="oc-fact">
                  <span className="oc-val">{fill(f.dueOf, { n: plan.due.length, total: plan.due.length + plan.unknown.length + plan.fine.length })}</span>{" "}
                  <Tag state="estimated" f={f} />
                </span>
              )
            ) : (
              <Gap why={facts.providers.state === "unknown" ? facts.providers.why : ""} f={f} inline />
            )}
          </Kpi>
          <Kpi label={f.kpi.critical}>{h ? <Count n={h.alerts.critical} f={f} format={n} /> : <Gap why={health.ok ? "" : health.why} f={f} inline />}</Kpi>
          <Kpi label={f.kpi.doctor}>
            {h ? <span className={h.doctor.verdict === "fail" ? "oc-flag-fail" : undefined}>{f.doctor[h.doctor.verdict]}</span> : <Gap why={health.ok ? "" : health.why} f={f} inline />}
          </Kpi>
        </Kpis>
        <OwnerTools section={ownerSection("overview")} c={c} note={f.moreTools} />
      </div>
    </OwnerPage>
  );
}
