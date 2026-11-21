import { getDictionary } from "@/lib/i18n/server";
import { OwnerPage, OwnerTools } from "@/components/owner-console/OwnerPage";
import { AsOf, Count, FactsUnavailable, Gap, Kpi, Kpis, Table, Tag, when } from "@/components/owner-console/OwnerFacts";
import { ownerSection } from "@/lib/owner-console/nav";
import { block, channelNeedsLook, healthView, type QueueView } from "@/lib/owner-console/facts-view";
import { fill, int } from "@/lib/owner-analytics/format";
import { mfaVerifyUrl } from "@/lib/security/admin-mfa";
import { requireOwnerConsole } from "@/lib/server/owner-console";
import { loadOwnerFacts } from "../_facts";

export const dynamic = "force-dynamic";

/** Owner Console — System health, from the owner's facts: queues, workers, channels, alerts and the readiness check. */
export default async function OwnerConsoleHealth() {
  await requireOwnerConsole();
  const { t, locale } = await getDictionary();
  const c = t.ownerConsole;
  const f = c.facts;
  const hz = f.health;
  const head = { title: c.sections.health.title, subtitle: c.sections.health.subtitle };
  const load = await loadOwnerFacts();
  if (!load.ok) {
    return (
      <OwnerPage {...head}>
        <FactsUnavailable kind={load.kind} f={f} verifyHref={mfaVerifyUrl("/owner/health")} retryHref="/owner/health" />
      </OwnerPage>
    );
  }
  const b = block(load.facts.health);
  const n = (v: number) => int(v, locale);
  const queue = (label: string, q: QueueView, withQuota: boolean) => (
    <section className="oc-card" aria-label={label}>
      <h3 className="m-0 text-sm font-semibold">{label}</h3>
      <Kpis label={label}>
        <Kpi label={hz.queued} hint={q.oldestQueuedAt === null || q.queued === 0 ? undefined : <>{hz.oldest}: {when(q.oldestQueuedAt, f)}</>}>
          <Count n={q.queued} f={f} format={n} />
        </Kpi>
        <Kpi label={hz.running}><Count n={q.running} f={f} format={n} /></Kpi>
        {withQuota && <Kpi label={hz.stuck}><Count n={q.stuck} f={f} format={n} /></Kpi>}
        <Kpi label={hz.failed24}><Count n={q.failed24h} f={f} format={n} /></Kpi>
        {withQuota && <Kpi label={hz.quota24}><Count n={q.quotaFailed24h} f={f} format={n} /></Kpi>}
      </Kpis>
    </section>
  );

  return (
    <OwnerPage {...head}>
      <div className="oc-stack">
        {!b.ok ? (
          <Gap why={b.why} f={f} />
        ) : (
          (() => {
            const h = healthView(b.doc);
            return (
              <>
                <AsOf iso={b.asOf} f={f} />
                <Kpis label={hz.alerts}>
                  <Kpi label={hz.doctor} hint={h.doctor.at === null ? undefined : when(h.doctor.at, f)}>
                    <span className={h.doctor.verdict === "fail" ? "oc-flag-fail" : undefined}>{f.doctor[h.doctor.verdict]}</span>
                  </Kpi>
                  <Kpi label={`${hz.alerts}: ${hz.critical}`}><Count n={h.alerts.critical} f={f} format={n} /></Kpi>
                  <Kpi label={`${hz.alerts}: ${hz.warn}`}><Count n={h.alerts.warn} f={f} format={n} /></Kpi>
                  <Kpi label={hz.criticalPlatform}><Count n={h.alerts.criticalPlatform} f={f} format={n} /></Kpi>
                </Kpis>
                <p className="oc-note">{hz.alertsNote}</p>

                <h2 className="oc-h2">{hz.queues}</h2>
                <div className="grid gap-3 lg:grid-cols-2">
                  {queue(hz.creative, h.creative, true)}
                  {queue(hz.render, h.render, false)}
                </div>

                <h2 className="oc-h2">{hz.workers}</h2>
                <section className="oc-card">
                  {h.workers.length === 0 ? (
                    <p className="oc-note">{hz.noWorkers}</p>
                  ) : (
                    <ul role="list" className="m-0 flex list-none flex-col gap-1 p-0">
                      {h.workers.map((w) => (
                        <li key={w.id} className="flex flex-wrap justify-between gap-2">
                          <span>
                            {w.id} <span className="oc-why">{[w.kind, w.state].filter(Boolean).join(" · ")}</span>
                          </span>
                          <span className={w.stale ? "oc-why oc-warn" : "oc-why"}>
                            {w.stale === null ? <Tag state="unknown" f={f} /> : w.stale ? hz.stale : hz.fresh} · {when(w.updatedAt, f)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <h2 className="oc-h2">{hz.channels}</h2>
                <section className="oc-card">
                  {h.channels.length === 0 ? (
                    <p className="oc-note">{hz.noChannels}</p>
                  ) : (
                    <Table caption={hz.channels} head={[hz.colChannel, hz.colLastRun, hz.colFail24, hz.colFail7, hz.colHeld, hz.colYoutube]}>
                      {h.channels.map((ch) => (
                        <tr key={ch.id}>
                          <td>
                            {/* Customer-typed text, drawn as text. */}
                            <div className="font-medium">{ch.name ?? ch.id}</div>
                            <div className="oc-why">
                              {ch.id}
                              {channelNeedsLook(ch) && <span className="oc-flag"> · {hz.needsLook}</span>}
                            </div>
                          </td>
                          <td className="oc-nowrap">{when(ch.lastRunAt, f)}</td>
                          <td><Count n={ch.failures24h} f={f} format={n} /></td>
                          <td><Count n={ch.failures7d} f={f} format={n} /></td>
                          <td><Count n={ch.held} f={f} format={n} /></td>
                          <td>
                            {ch.tokenStored === false ? (
                              <span className="oc-flag">{hz.ytNoToken}</span>
                            ) : ch.rejected ? (
                              // The credential row may still say "connected": a refusal after its last check outranks it.
                              <span className="oc-flag-fail">{hz.ytRejected}</span>
                            ) : ch.credentialStatus === "connected" ? (
                              hz.yt.connected
                            ) : ch.credentialStatus ? (
                              <span className="oc-flag">
                                {Object.hasOwn(hz.yt, ch.credentialStatus) ? hz.yt[ch.credentialStatus as keyof typeof hz.yt] : <Tag state="unknown" f={f} />}
                              </span>
                            ) : (
                              <Tag state="unknown" f={f} />
                            )}
                            {ch.credentialCheckedAt !== undefined && ch.credentialCheckedAt !== null && (
                              <div className="oc-why">
                                {hz.checked.split("{time}")[0]}
                                {when(ch.credentialCheckedAt, f)}
                                {hz.checked.split("{time}")[1]}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </Table>
                  )}
                  {h.lookbackDays !== null && <p className="oc-note">{fill(hz.lookback, { days: h.lookbackDays })}</p>}
                </section>
                <p className="oc-note">{hz.ci}</p>
              </>
            );
          })()
        )}
        <OwnerTools section={ownerSection("health")} c={c} note={f.moreTools} />
      </div>
    </OwnerPage>
  );
}
