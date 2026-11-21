import { getDictionary } from "@/lib/i18n/server";
import { OwnerPage, OwnerTools } from "@/components/owner-console/OwnerPage";
import { AsOf, Count, FactsUnavailable, Gap, Kpi, Kpis, Table, Tag, when } from "@/components/owner-console/OwnerFacts";
import { ownerSection } from "@/lib/owner-console/nav";
import { block, peopleView, type PlanCount } from "@/lib/owner-console/facts-view";
import { int } from "@/lib/owner-analytics/format";
import { mfaVerifyUrl } from "@/lib/security/admin-mfa";
import { requireOwnerConsole } from "@/lib/server/owner-console";
import { loadOwnerFacts } from "../_facts";

export const dynamic = "force-dynamic";

/** Owner Console — Users & plans, from the owner's facts. Owner check first; read-only. */
export default async function OwnerConsoleUsers() {
  await requireOwnerConsole();
  const { t, locale } = await getDictionary();
  const c = t.ownerConsole;
  const f = c.facts;
  const u = f.users;
  const head = { title: c.sections.users.title, subtitle: c.sections.users.subtitle };
  const load = await loadOwnerFacts();
  if (!load.ok) {
    return (
      <OwnerPage {...head}>
        <FactsUnavailable kind={load.kind} f={f} verifyHref={mfaVerifyUrl("/owner/users")} retryHref="/owner/users" />
      </OwnerPage>
    );
  }
  const b = block(load.facts.people);
  const n = (v: number) => int(v, locale);
  const plans = (rows: PlanCount[]) =>
    rows.length === 0 ? (
      <p className="oc-note">{u.noPlans}</p>
    ) : (
      <ul role="list" className="m-0 flex list-none flex-col gap-1 p-0">
        {rows.map((r) => (
          <li key={r.plan} className="flex justify-between gap-3">
            <span>{r.plan}</span>
            <Count n={r.count} f={f} format={n} />
          </li>
        ))}
      </ul>
    );

  return (
    <OwnerPage {...head}>
      <div className="oc-stack">
        {!b.ok ? (
          <Gap why={b.why} f={f} />
        ) : (
          (() => {
            const p = peopleView(b.doc);
            return (
              <>
                <AsOf iso={b.asOf} f={f} />
                <h2 className="oc-h2">{u.signups}</h2>
                <Kpis label={u.signups}>
                  <Kpi label={u.d1}><Count n={p.signups.d1} f={f} format={n} /></Kpi>
                  <Kpi label={u.d7}><Count n={p.signups.d7} f={f} format={n} /></Kpi>
                  <Kpi label={u.d30}><Count n={p.signups.d30} f={f} format={n} /></Kpi>
                  <Kpi label={u.total}><Count n={p.signups.total} f={f} format={n} /></Kpi>
                  <Kpi label={u.unconfirmed}><Count n={p.signups.unconfirmedD30} f={f} format={n} /></Kpi>
                </Kpis>
                <h2 className="oc-h2">{u.signedIn}</h2>
                <Kpis label={u.signedIn}>
                  <Kpi label={u.d7} hint={u.signedInFloor}><Count n={p.signedIn.d7} f={f} format={n} /></Kpi>
                  <Kpi label={u.d30} hint={u.signedInFloor}><Count n={p.signedIn.d30} f={f} format={n} /></Kpi>
                </Kpis>
                <h2 className="oc-h2">{u.plans}</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  <section className="oc-card" aria-label={u.paying}>
                    <h3 className="m-0 text-sm font-semibold">{u.paying}</h3>
                    {plans(p.paying)}
                  </section>
                  <section className="oc-card" aria-label={u.trialing}>
                    <h3 className="m-0 text-sm font-semibold">{u.trialing}</h3>
                    {plans(p.trialing)}
                  </section>
                </div>
                <Kpis label={u.plans}>
                  <Kpi label={u.pastDue}><Count n={p.pastDue} f={f} format={n} /></Kpi>
                  <Kpi label={u.cancelling}><Count n={p.cancelling} f={f} format={n} /></Kpi>
                  <Kpi label={u.canceled30}><Count n={p.canceledD30} f={f} format={n} /></Kpi>
                </Kpis>
                <h2 className="oc-h2">{u.recent}</h2>
                <section className="oc-card">
                  {p.recent.length === 0 ? (
                    <p className="oc-note">{u.noRecent}</p>
                  ) : (
                    <Table caption={u.recent} head={[u.colWorkspace, u.colPlan, u.colStatus, u.colWhen]}>
                      {p.recent.map((r, i) => (
                        <tr key={`${r.workspaceId ?? "x"}-${i}`}>
                          {/* Customer-typed text, drawn as text (React escapes it), with the id beside it. */}
                          <td>
                            {/* <bdi>: a right-to-left override in a name must not reorder the id beside it. */}
                            <bdi>{r.workspace ?? f.none}</bdi> <span className="oc-why">{r.workspaceId ? `#${r.workspaceId}` : ""}</span>
                          </td>
                          <td>{r.plan ?? f.none}</td>
                          <td>{r.status === null ? f.none : Object.hasOwn(u.status, r.status) ? u.status[r.status as keyof typeof u.status] : <Tag state="unknown" f={f} />}</td>
                          <td className="oc-nowrap">{when(r.at, f)}</td>
                        </tr>
                      ))}
                    </Table>
                  )}
                  <p className="oc-note">{u.untrusted}</p>
                </section>
                {p.internalExcluded && <p className="oc-note">{u.internal}</p>}
              </>
            );
          })()
        )}
        <OwnerTools section={ownerSection("users")} c={c} note={f.moreTools} />
      </div>
    </OwnerPage>
  );
}
