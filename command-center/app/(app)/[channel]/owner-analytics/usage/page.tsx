import { CardHead, HubFrame, HubState, Kpi, hubContext } from "@/components/owner-analytics/HubFrame";
import { DrillChart } from "@/components/owner-analytics/DrillChart";
import { DataTable } from "@/components/owner-analytics/DataTable";
import { readJobsFor } from "@/lib/server/owner-analytics-data";
import { jobsSeries, jobsTable } from "@/lib/owner-analytics/kpis";
import { applyScope } from "@/lib/owner-analytics/money";
import { jobsByModel, rate } from "@/lib/owner-analytics/people";
import { fill, int, num, pct } from "@/lib/owner-analytics/format";
import "../owner-analytics.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Owner analytics — usage: jobs by model and kind, success and failure, time to result and credits charged. Migration 0182;
 * owner-only; read-only. Internal and test workspaces are left out unless the owner includes them.
 */
export default async function OwnerAnalyticsUsage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { access, ctx } = await hubContext(await searchParams);
  if (access !== "owner") return <HubState state={access} ctx={ctx} />;
  const { d, sel, locale, present } = ctx;

  const jobs = await readJobsFor(sel);
  if (!jobs.ok) return <HubState state={jobs.reason} ctx={ctx} />;
  const all = applyScope(jobs.data, sel.includeInternal);
  const p = sel.current;
  const inP = (pp: typeof p) => all.filter((j) => j.day >= pp.startDay && j.day <= pp.endDay);
  const cur = jobsByModel(inP(p));
  const prev = sel.previous ? jobsByModel(inP(sel.previous)) : null;
  const total = (xs: typeof cur) =>
    xs.reduce(
      (a, j) => ({ jobs: a.jobs + j.jobs, ok: a.ok + j.succeeded, failed: a.failed + j.failed, credits: a.credits + j.credits, counted: a.counted + j.creditsCounted }),
      { jobs: 0, ok: 0, failed: 0, credits: 0, counted: 0 },
    );
  const t = total(cur);
  const pt = prev ? total(prev) : null;
  const success = rate(t.ok, t.ok + t.failed);
  const series = jobsSeries(inP(p), p);
  const n$ = (n: number) => int(n, locale);
  const uncharged = t.jobs - t.counted;

  return (
    <HubFrame ctx={ctx} section="usage">
      {jobs.truncated && <p className="oa-note" data-tone="warn">{d.truncated}</p>}
      <section className="oa-grid-kpi" aria-label={d.tabUsage}>
        <Kpi ctx={ctx} label={d.jobs} value={t.jobs} previous={pt?.jobs} format={n$} />
        <Kpi
          ctx={ctx}
          label={d.successRate}
          value={success}
          previous={pt ? rate(pt.ok, pt.ok + pt.failed) : undefined}
          format={(n) => pct(n, locale)}
          unknownText={fill(d.notEnoughDataN, { n: t.ok + t.failed })}
        />
        <Kpi
          ctx={ctx}
          label={d.credits}
          value={t.counted > 0 || t.jobs === 0 ? t.credits : null}
          previous={pt && (pt.counted > 0 || pt.jobs === 0) ? pt.credits : undefined}
          format={(n) => num(n, locale, 2)}
          badge={uncharged > 0 && t.counted > 0 ? d.incomplete : undefined}
        />
      </section>
      {uncharged > 0 && <p className="oa-note">{fill(d.creditsUnknown, { n: n$(uncharged) })}</p>}

      <section className="oa-card">
        <CardHead title={d.jobsOverTime} ctx={ctx} />
        <DrillChart
          tableId="oa-usage-series"
          title={d.jobsOverTime}
          unit="count"
          series={[
            { key: "ok", label: d.jobsSucceeded, points: series.map((x) => ({ x: x.x, y: x.ok })) },
            { key: "failed", label: d.jobsFailed, points: series.map((x) => ({ x: x.x, y: x.failed })) },
          ]}
        />
        <DataTable
          table={{ name: d.jobsOverTime, columns: [d.date, d.jobsSucceeded, d.jobsFailed], rows: series.map((x) => [x.x, x.ok, x.failed]) }}
          id="oa-usage-series"
          unknownText={d.unknown}
        />
      </section>

      <section className="oa-card">
        <CardHead title={d.jobsByModel} what="usage.models" ctx={ctx} />
        <DataTable
          table={jobsTable(d, inP(p), p, present)}
          id="oa-usage-models"
          unknownText={d.notEnoughData}
          format={[undefined, undefined, n$, (n) => `${num(n, locale)}%`, (n) => fill(d.seconds, { n: n$(n) }), (n) => num(n, locale, 2)]}
        />
      </section>

      <section className="oa-card">
        <h2>{d.templates}</h2>
        <p className="oa-note">{d.templatesNotYet}</p>
      </section>
    </HubFrame>
  );
}
