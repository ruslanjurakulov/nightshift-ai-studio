import { CardHead, HubFrame, HubState, Kpi, hubContext } from "@/components/owner-analytics/HubFrame";
import { Bars, DrillChart } from "@/components/owner-analytics/DrillChart";
import { DataTable } from "@/components/owner-analytics/DataTable";
import { CohortHeatmap } from "@/components/owner-analytics/Charts";
import { readPeople } from "@/lib/server/owner-analytics";
import { readActivityFor, readCohortActivity, readMoneyFor } from "@/lib/server/owner-analytics-data";
import {
  breakdownTable,
  cohortTable,
  engagement,
  funnelTable,
  planCohortTable,
  reactivations,
  signupSeries,
  signupsTable,
  trailingMonth,
} from "@/lib/owner-analytics/kpis";
import { applyScope, churn } from "@/lib/owner-analytics/money";
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

  const [peopleRead, activity, cohortRead, money] = await Promise.all([
    readPeople(),
    readActivityFor(sel),
    readCohortActivity(sel),
    readMoneyFor(sel),
  ]);
  if (!peopleRead.ok) return <HubState state={peopleRead.reason} ctx={ctx} />;
  if (!money.ok) return <HubState state={money.reason} ctx={ctx} />;
  const inc = sel.includeInternal;
  const people = applyScope(peopleRead.data, inc);
  const sales = applyScope(money.data, inc);
  const act = activity && activity.read.ok ? applyScope(activity.read.data, inc) : null;
  const cohortAct = cohortRead.read.ok ? applyScope(cohortRead.read.data, inc) : null;
  const p = sel.current;
  const n$ = (n: number) => int(n, locale);

  const series = signupSeries(people, p);
  const prevSeries = sel.previous ? signupSeries(people, sel.previous) : null;
  const signups = series.reduce((a, x) => a + x.y, 0);
  const prevSignups = prevSeries?.reduce((a, x) => a + x.y, 0);
  const steps = funnel(people, p);
  const eng = act ? engagement(act, p) : null;
  // The previous period's engagement only when its own activity was read: never from the part that happened to be.
  const prevEng = act && sel.previous && activity?.previous ? engagement(act, sel.previous) : null;
  // The same churn as the Overview: the trailing 30 days, so one label means one number on every tab.
  const subsChurn = churn(sales, trailingMonth(p));
  const back = reactivations(sales, p);
  const stepLabel = { signup: d.stepSignup, project: d.stepProject, generation: d.stepGeneration, export: d.stepExport, payment: d.stepPayment };
  const cohorts = cohortAct ? signupCohorts(people, cohortAct, p.endDay.slice(0, 7), cohortRead.fromMonth) : [];
  const plans = planCohorts(sales, p.endDay.slice(0, 7));
  const truncated =
    peopleRead.truncated || Boolean(activity?.read.ok && activity.read.truncated) || Boolean(cohortRead.read.ok && cohortRead.read.truncated);

  return (
    <HubFrame ctx={ctx} section="users">
      {truncated && <p className="oa-note" data-tone="warn">{d.truncated}</p>}
      <section className="oa-grid-kpi" aria-label={d.tabUsers}>
        <Kpi ctx={ctx} label={d.signups} value={signups} previous={prevSignups} format={n$} note={d.unconfirmedNote} />
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
        <Kpi ctx={ctx} label={d.churn} value={subsChurn.rate} format={(n) => pct(n, locale)} invert note={d.churnNote} unknownText={fill(d.notEnoughDataN, { n: subsChurn.base })} />
        <Kpi ctx={ctx} label={d.reactivated} value={back} format={n$} note={d.reactivatedNote} />
      </section>
      <p className="oa-note">
        {d.activeNote}
        {eng && ` · ${fill(d.daysOfData, { n: eng.daysOfData })}`}
      </p>
      {!act && <p className="oa-note">{d.activityNotRead}</p>}

      <section className="oa-card">
        <CardHead title={d.signupsOverTime} what="users.signups" ctx={ctx} />
        <DrillChart
          tableId="oa-users-signups"
          title={d.signupsOverTime}
          unit="count"
          series={[
            { key: "signups", label: d.signups, points: series.map((x) => ({ x: x.x, y: x.y })) },
            ...(prevSeries
              ? [{ key: "prev", label: `${d.signups} · ${d.previous}`, points: prevSeries.slice(0, series.length).map((x, i) => ({ x: series[i].x, y: x.y })) }]
              : []),
          ]}
        />
        <DataTable table={signupsTable(d, people, p, present)} id="oa-users-signups" unknownText={d.unknown} />
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
          <DataTable table={funnelTable(d, people, p, present)} id="oa-users-funnel" unknownText={d.notEnoughData} />
        </section>
        <section className="oa-card">
          <CardHead title={d.byLocale} what="users.locale" ctx={ctx} note={d.countryNote} />
          <DataTable table={breakdownTable(d, people, p, present, "locale")} id="oa-users-locale" unknownText={d.unknown} />
          <CardHead title={d.byAcquisition} what="users.acquisition" ctx={ctx} note={d.acqNote} />
          <DataTable table={breakdownTable(d, people, p, present, "acquisition")} id="oa-users-acq" unknownText={d.unknown} />
        </section>
      </div>

      <section className="oa-card">
        <CardHead title={d.cohorts} what="users.cohorts" ctx={ctx} note={d.cohortsNote} />
        {cohortAct ? (
          <>
            <CohortHeatmap
              rows={cohorts.map((c) => ({ key: c.key, label: c.key, size: c.size, cells: c.cells }))}
              monthTemplate={d.monthN}
              sizeLabel={d.cohortSize}
              labels={{ noData: d.noData }}
            />
            <p className="oa-note">{fill(d.cohortsUnread, { month: cohortRead.fromMonth })}</p>
            <DataTable table={cohortTable(d, people, cohortAct, cohortRead.fromMonth, p, present)} id="oa-users-cohorts" unknownText="" />
          </>
        ) : (
          <p className="oa-note">{d.readFailed}</p>
        )}
      </section>

      <section className="oa-card">
        <CardHead title={d.planCohorts} what="users.plan_cohorts" ctx={ctx} note={d.planCohortsNote} />
        <CohortHeatmap
          rows={plans.map((c) => ({ key: c.key, label: `${c.plan === "?" ? d.notRecorded : c.plan} · ${c.month}`, size: c.size, cells: c.cells }))}
          monthTemplate={d.monthN}
          sizeLabel={d.cohortSize}
          labels={{ noData: d.noData }}
        />
        <DataTable table={planCohortTable(d, sales, p, present)} id="oa-users-plancohorts" unknownText="" />
      </section>
    </HubFrame>
  );
}
