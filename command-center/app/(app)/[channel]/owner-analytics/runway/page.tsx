import { CardHead, HubFrame, HubState, hubContext } from "@/components/owner-analytics/HubFrame";
import { DataTable } from "@/components/owner-analytics/DataTable";
import { RunwayVolume } from "@/components/owner-analytics/RunwayVolume";
import { readRunway } from "@/lib/server/owner-runway";
import { providerRunways } from "@/lib/owner-analytics/runway";
import { runwayModelsTable, runwayProvidersTable } from "@/lib/owner-analytics/runway-tables";
import { fill, int, num, tashkentDateTime, usd } from "@/lib/owner-analytics/format";
import "../owner-analytics.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Owner analytics — provider runway. Per paid provider and per model: what was spent (24 h, 7 days, since the first top-up),
 * what is left and how that is known, and when it runs out at the 7-day pace. Built on the Billing page's own ledger
 * (lib/billing.ts) so the two pages agree. The period picker does not change it: a runway is always measured up to now.
 * Owner-only; read-only.
 */
export default async function OwnerAnalyticsRunway({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { access, ctx } = await hubContext(await searchParams);
  if (access !== "owner") return <HubState state={access} ctx={ctx} />;
  const { d, locale } = ctx;
  const nowMs = ctx.now.getTime();
  const data = await readRunway(nowMs);
  if (!data) return <HubState state="not_configured" ctx={ctx} />;
  const rows = providerRunways(data);
  const money$ = (n: number) => usd(n, locale);
  const days = (n: number) => num(n, locale, 1);
  const n$ = (n: number) => int(n, locale);
  const empty = rows.filter((r) => r.status === "empty").length;
  const low = rows.filter((r) => r.status === "low").length;
  const anyRead = !(data.topupsUnread && data.balancesUnread && data.studioUnread && data.probesUnread && data.pipelineUnread);
  if (!anyRead) return <HubState state="error" ctx={ctx} />;

  return (
    <HubFrame ctx={ctx} section="runway">
      <p className="oa-note">{fill(d.runwayAsOf, { when: tashkentDateTime(new Date(nowMs).toISOString()) })} · {d.runwayMethod}</p>
      {empty > 0 && (
        <p className="oa-note" data-tone="warn" role="status">
          {fill(d.runwayEmptyNote, { n: n$(empty) })}
        </p>
      )}
      {low > 0 && (
        <p className="oa-note" data-tone="warn" role="status">
          {fill(d.runwayLowNote, { n: n$(low) })}
        </p>
      )}
      {(data.topupsUnread || data.balancesUnread || data.studioUnread || data.probesUnread || data.pipelineUnread || data.settings === null) && (
        <p className="oa-note" data-tone="warn">{d.readFailed}</p>
      )}
      {data.activity.missing && <p className="oa-note" data-tone="warn">{d.runwayNotEnabled}</p>}
      {data.horizonCapped && <p className="oa-note" data-tone="warn">{d.runwayHorizon}</p>}

      <section className="oa-card">
        <CardHead title={d.runwayProviders} what="runway.providers" ctx={ctx} />
        <DataTable
          table={runwayProvidersTable(d, rows, nowMs)}
          id="oa-runway-providers"
          unknownText={d.unknown}
          emptyText={d.runwayNone}
          format={[undefined, undefined, money$, undefined, money$, money$, money$, money$, money$, days, undefined, undefined]}
        />
      </section>

      {rows.length > 0 && (
        <section className="oa-card">
          <h2>{d.runwayAtVolume}</h2>
          <RunwayVolume rows={rows.map((r) => ({ id: r.id, name: r.name, leftUsd: r.leftUsd, burn7d: r.burn7d }))} />
        </section>
      )}

      <section className="oa-card">
        <CardHead title={d.runwayModels} what="runway.models" ctx={ctx} note={d.runwayModelsNote} />
        <DataTable
          table={runwayModelsTable(d, rows, nowMs)}
          id="oa-runway-models"
          unknownText={d.unknown}
          emptyText={d.noData}
          format={[undefined, undefined, n$, n$, (n) => num(n, locale, 2), undefined, n$, money$, undefined, undefined]}
        />
      </section>
    </HubFrame>
  );
}
