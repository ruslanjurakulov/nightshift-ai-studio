import { CardHead, HubFrame, HubState, Kpi, hubContext } from "@/components/owner-analytics/HubFrame";
import { Bars, DrillChart } from "@/components/owner-analytics/DrillChart";
import { DataTable } from "@/components/owner-analytics/DataTable";
import { CohortHeatmap } from "@/components/owner-analytics/Charts";
import { readPeople } from "@/lib/server/owner-analytics";
import { readActivityFor, readMoneyFor } from "@/lib/server/owner-analytics-data";
import {
  breakdownTable,
  cohortTable,
  engagement,
  funnelTable,
  planCohortTable,
  reactivations,
  signupSeries,
  signupsTable,
} from "@/lib/owner-analytics/kpis";
import { churn } from "@/lib/owner-analytics/money";
import { funnel, planCohorts, signupCohorts } from "@/lib/owner-analytics/people";
import { fill, int, num, pct } from "@/lib/owner-analytics/format";
import "../owner-analytics.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Owner analytics — users: signups, the activation funnel, engagement, and retention by signup month and by first plan.
 * People are opaque ids end to end: no e-mail or name is read by this page (migration 0182 never returns one), so presentation
 * mode cannot leak one either. Owner-only; read-only.
 */
export default async function OwnerAnalyticsUsers({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { access, ctx } = await hubContext(await searchParams);
  if (access !== "owner") return <HubState state={access} ctx={ctx} />;
  const { d, sel, locale, present } = ctx;

  const [people, activity, money] = await Promise.all([readPeople(), readActivityFor(sel), readMoneyFor(sel)]);
  if (!people.ok) return <HubState state={people.reason} ctx={ctx} />;
  if (!money.ok) return <HubState state={money.reason} ctx={ctx} />;
  const act = activity && activity.ok ? activity.data : null;
  const p = sel.current;
  const n$ = (n: number) => int(n, locale);

  const series = signupSeries(people.data, p);
  const prevSeries = sel.previous ? signupSeries(people.data, sel.previous) : null;
  const signups = series.reduce((a, x) => a + x.y, 0);
  const prevSignups = prevSeries?.reduce((a, x) => a + x.y, 0);
  const steps = funnel(people.data, p);
  const eng = act ? engagement(act, p) : null;
  const prevEng = act && sel.previous ? engagement(act, sel.previous) : null;
  const subsChurn = churn(money.data, p);
  const back = reactivations(money.data, p);
  const stepLabel = { signup: d.stepSignup, project: d.stepProject, generation: d.stepGeneration, export: d.stepExport, payment: d.stepPayment };
  // Cohorts need history beyond the period: the activity read covers at most ~13 months, which is what the heatmap shows.
  const cohorts = act ? signupCohorts(people.data, act, p.endDay.slice(0, 7)) : [];
  const plans = planCohorts(money.data, p.endDay.slice(0, 7));

  return (
    <HubFrame ctx={ctx} section="users">
      {(people.truncated || (activity && activity.ok && activity.truncated)) && <p className="oa-note" data-tone="warn">{d.truncated}</p>}
      <section className="oa-grid-kpi" aria-label={d.tabUsers}>
        <Kpi ctx={ctx} label={d.signups} value={signups} previous={prevSignups} format={n$} />
        <Kpi ctx={ctx} label={d.dau} value={eng?.dau ?? null} previous={prevEng?.dau} format={(n) => num(n, locale)} />
        <Kpi ctx={ctx} label={d.wau} value={eng ? eng.wau : null} previous={prevEng?.wau} format={n$} />
        <Kpi ctx={ctx} label={d.mau} value={eng ? eng.mau : null} previous={prevEng?.mau} format={n$} />
        <Kpi
          ctx={ctx}
          label={d.stickiness}
          value={eng?.stickiness ?? null}
          previous={prevEng?.stickiness}
          format={(n) => pct(n, locale)}
          unknownText={eng ? fill(d.notEnoughDataN, { n: eng.mau }) : d.unknown}
        />
        <Kpi
          ctx={ctx}
          label={d.churn}
          value={subsChurn.rate}
          format={(n) => pct(n, locale)}
          invert
          unknownText={fill(d.notEnoughDataN, { n: subsChurn.base })}
        />
        <Kpi ctx={ctx} label={d.reactivated} value={back} format={n$} note={d.reactivatedNote} />
      </section>
      <p className="oa-note">
        {d.activeNote}
        {eng && ` · ${fill(d.daysOfData, { n: eng.daysOfData })}`}
      </p>

      <section className="oa-card">
        <CardHead title={d.signupsOverTime} what="users.signups" ctx={ctx} />
        <DrillChart
          tableId="oa-users-signups"
          title={d.signupsOverTime}
          unit="count"
          series={[
            { key: "signups", label: d.signups, points: series.map((x) => ({ x: x.x, y: x.y })) },
            ...(prevSeries ? [{ key: "prev", label: `${d.signups} · ${d.previous}`, points: prevSeries.map((x, i) => ({ x: series[i]?.x ?? x.x, y: x.y })) }] : []),
          ]}
        />
        <DataTable table={signupsTable(d, people.data, p, present)} id="oa-users-signups" unknownText={d.unknown} />
      </section>

      <div className="oa-cols">
        <section className="oa-card">
          <CardHead title={d.funnel} what="users.funnel" ctx={ctx} note={d.funnelNote} />
          <Bars
            unit="count"
            data={steps.map((s) => ({
              key: s.key,
              label: stepLabel[s.key],
              value: s.count,
              note: s.ofSignups === null ? (s.key === "signup" ? undefined : fill(d.notEnoughDataN, { n: steps[0].count })) : pct(s.ofSignups, locale),
            }))}
          />
          <DataTable table={funnelTable(d, people.data, p, present)} id="oa-users-funnel" unknownText={d.notEnoughData} />
        </section>
        <section className="oa-card">
          <CardHead title={d.byLocale} what="users.locale" ctx={ctx} note={d.countryNote} />
          <DataTable table={breakdownTable(d, people.data, p, present, "locale")} id="oa-users-locale" unknownText={d.unknown} />
          <CardHead title={d.byAcquisition} what="users.acquisition" ctx={ctx} note={d.acqNote} />
          <DataTable table={breakdownTable(d, people.data, p, present, "acquisition")} id="oa-users-acq" unknownText={d.unknown} />
        </section>
      </div>

      <section className="oa-card">
        <CardHead title={d.cohorts} what="users.cohorts" ctx={ctx} note={d.cohortsNote} />
        {act ? (
          <CohortHeatmap
            rows={cohorts.map((c) => ({ key: c.key, label: c.key, size: c.size, cells: c.cells }))}
            monthLabel={(i) => d.monthN.replace("{n}", String(i))}
            sizeLabel={d.cohortSize}
            labels={{ noData: d.noData }}
          />
        ) : (
          <p className="oa-note">{d.unknown}</p>
        )}
        {act && <DataTable table={cohortTable(d, people.data, act, p, present)} id="oa-users-cohorts" unknownText="—" />}
      </section>

      <section className="oa-card">
        <CardHead title={d.planCohorts} what="users.plan_cohorts" ctx={ctx} note={d.planCohortsNote} />
        <CohortHeatmap
          rows={plans.map((c) => ({ key: c.key, label: `${c.plan === "?" ? d.notRecorded : c.plan} · ${c.month}`, size: c.size, cells: c.cells }))}
          monthLabel={(i) => d.monthN.replace("{n}", String(i))}
          sizeLabel={d.cohortSize}
          labels={{ noData: d.noData }}
        />
        <DataTable table={planCohortTable(d, money.data, p, present)} id="oa-users-plancohorts" unknownText="—" />
      </section>
    </HubFrame>
  );
}
