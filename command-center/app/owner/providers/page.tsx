import { getDictionary } from "@/lib/i18n/server";
import { OwnerPage, OwnerTools } from "@/components/owner-console/OwnerPage";
import { AsOf, FactsUnavailable, Gap, Table, Tag } from "@/components/owner-console/OwnerFacts";
import { ownerSection } from "@/lib/owner-console/nav";
import type { PlanLine } from "@/lib/owner-analytics/payment-plan";
import { fill, num, usd } from "@/lib/owner-analytics/format";
import { mfaVerifyUrl } from "@/lib/security/admin-mfa";
import { requireOwnerConsole } from "@/lib/server/owner-console";
import { loadOwnerFacts } from "../_facts";

export const dynamic = "force-dynamic";

/**
 * Owner Console — Providers & payments: the payment plan from the owner's facts (the provider runway, built on the Billing
 * ledger). It never pays: each line links to the provider's own page, and the owner tops up there. Owner check first.
 */
export default async function OwnerConsoleProviders() {
  await requireOwnerConsole();
  const { t, locale } = await getDictionary();
  const c = t.ownerConsole;
  const f = c.facts;
  const pv = f.providers;
  const head = { title: c.sections.providers.title, subtitle: c.sections.providers.subtitle };
  const load = await loadOwnerFacts();
  if (!load.ok) {
    return (
      <OwnerPage {...head}>
        <FactsUnavailable kind={load.kind} f={f} verifyHref={mfaVerifyUrl("/owner/providers")} retryHref="/owner/providers" />
      </OwnerPage>
    );
  }
  const prov = load.facts.providers;

  // A native reading (credits, characters) stays in its own unit: no invented dollar price.
  const amountIn = (v: number | null, unit: string) =>
    v === null ? null : unit === "usd" ? usd(v, locale) : `${num(v, locale, 0)} ${fill(pv.nativeUnit, { unit })}`;
  const cell = (v: string | null) => v ?? <Tag state="unknown" f={f} />;

  const rows = (lines: PlanLine[]) =>
    lines.map((l) => (
      <tr key={l.provider}>
        <td>
          <div className="font-medium">{l.name}</div>
          <div className={l.reason === "empty" ? "oc-flag-fail" : l.reason === "runs_out" ? "oc-flag" : "oc-why"}>{pv.reason[l.reason]}</div>
          {l.autoRecharge && <div className="oc-why">{pv.autoRecharge}</div>}
        </td>
        <td>
          {cell(amountIn(l.left, l.unit))} {l.left !== null && <Tag state={l.basis} f={f} />}
        </td>
        <td>{cell(amountIn(l.perDay, l.unit))}</td>
        <td>{l.runsOutOn === "never" ? pv.never : cell(l.runsOutOn)}</td>
        <td>{l.payBy ?? f.none}</td>
        <td>
          {cell(amountIn(l.amount, l.unit))}
          {l.amount !== null && (
            <div className="oc-why">{l.minimumTopUp === null ? pv.noMinimum : fill(pv.minimum, { amount: amountIn(l.minimumTopUp, l.unit) ?? "" })}</div>
          )}
        </td>
        <td>
          {l.topUpUrl ? (
            <a className="oc-link" href={l.topUpUrl} target="_blank" rel="noopener noreferrer">
              {pv.topUp} <span aria-hidden>↗</span>
            </a>
          ) : (
            f.none
          )}
        </td>
      </tr>
    ));
  const cols = [pv.colProvider, pv.colLeft, pv.colPace, pv.colRunsOut, pv.colPayBy, pv.colAmount, pv.topUp];

  return (
    <OwnerPage {...head}>
      <div className="oc-stack">
        {prov.state === "unknown" ? (
          <Gap why={prov.why} f={f} />
        ) : (
          (() => {
            const plan = prov.value.plan;
            const total = plan.due.length + plan.unknown.length + plan.fine.length;
            return (
              <>
                <AsOf iso={plan.asOf} f={f} />
                <h2 className="oc-h2">{fill(pv.plan, { days: plan.days })}</h2>
                <p className="oc-note">{fill(pv.planNote, { days: plan.days })}</p>
                {total === 0 ? (
                  <p className="oc-note">{pv.none}</p>
                ) : (
                  <>
                    <section className="oc-card" aria-label={pv.due}>
                      <h3 className="m-0 text-sm font-semibold">{pv.due}</h3>
                      {plan.due.length === 0 ? (
                        <p className="oc-note">{fill(pv.noDue, { days: plan.days })}</p>
                      ) : (
                        <Table caption={pv.due} head={cols}>
                          {rows(plan.due)}
                        </Table>
                      )}
                    </section>
                    {plan.unknown.length > 0 && (
                      <section className="oc-card" aria-label={pv.unknown}>
                        <h3 className="m-0 text-sm font-semibold">{pv.unknown}</h3>
                        <Table caption={pv.unknown} head={cols}>
                          {rows(plan.unknown)}
                        </Table>
                      </section>
                    )}
                    {plan.fine.length > 0 && (
                      <section className="oc-card" aria-label={pv.fine}>
                        <h3 className="m-0 text-sm font-semibold">{pv.fine}</h3>
                        <Table caption={pv.fine} head={cols}>
                          {rows(plan.fine)}
                        </Table>
                      </section>
                    )}
                  </>
                )}
              </>
            );
          })()
        )}
        <OwnerTools section={ownerSection("providers")} c={c} note={f.moreTools} />
      </div>
    </OwnerPage>
  );
}
