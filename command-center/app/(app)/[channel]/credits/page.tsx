import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/ui";
import { CreditLedger } from "@/components/credits/CreditLedger";
import { GrantCreditsForm } from "@/components/credits/GrantCreditsForm";
import { CreditPricesEditor } from "@/components/credits/CreditPricesEditor";
import { BuyCredits, BuyCreditsAdminOnly } from "@/components/credits/BuyCredits";
import { getOrgContext } from "@/lib/orgs-server";
import { createClient } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { coerceTransactions, formatCredits, isCreditExempt } from "@/lib/credits";
import { creditsEnforced, readCreditAccount, readCreditPrices } from "@/lib/server/credits";
import { buyAccess, paddleClient, paddleConfig } from "@/lib/paddle";
import { PLAN_ENV, planMatrix, subscribeAccess } from "@/lib/plans";
import { planValue, readBillingSummary, readCreditLots, readPlanCatalog } from "@/lib/server/plans";
import { PlanPanel } from "@/components/credits/PlanPanel";
import { CreditLots } from "@/components/credits/CreditLots";
import { ErrorState } from "@/components/ReadError";
import { readFailed } from "@/lib/readState";

const FAILED_READ = { state: "failed" as const };

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The current organization's credits: available and on hold, the ledger, and
 * — for a platform owner/admin — the grant form and the price list editor.
 *
 * Everything is read as the signed-in user; migration 0020's policies decide
 * what they see (their own organization's rows, the platform price list).
 * Writes go through the database too: grant_credits() refuses anyone but a
 * platform owner/admin, and credit_prices accepts writes only from them — the
 * forms are offered to the same people, so nobody sees a control that would
 * be refused.
 *
 * Buying credits (Paddle's overlay checkout) is offered to an owner/admin of
 * an organization that pays, when this deployment has Paddle configured. The
 * page never credits anything itself: the Paddle webhook does, with the
 * service role, outside this app (supabase/functions/paddle-webhook).
 */
export default async function CreditsPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t, locale } = await getDictionary();
  const [org, supabase] = await Promise.all([getOrgContext(), createClient()]);
  const header = <PageHeader icon="credits" title={t.credits.title} subtitle={t.credits.subtitle} />;
  const note = (text: string) => (
    <div className="rhythm">
      {header}
      <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{text}</div>
    </div>
  );

  if (!supabase || !org.supported) return note(t.org.notMigrated);
  if (!org.current) return note(t.credits.noOrg);
  const orgId = org.current.id;

  const [acct, priceRes, txns, admin, userRes, catalogRead, summaryRead, lotsRead] = await Promise.all([
    readCreditAccount(supabase, orgId),
    readCreditPrices(supabase),
    supabase
      .from("credit_transactions")
      .select("id,kind,amount,balance_after,reserved_after,job_id,note,created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(200),
    supabase.rpc("is_platform_admin"),
    supabase.auth.getUser(),
    // Plans (0034). Each read is ok / unsupported (migration not applied: the
    // page shows what it showed before) / failed (unknown: never a plan name,
    // "Free", a 0 or an empty list in its place).
    readPlanCatalog(supabase).catch(() => FAILED_READ),
    readBillingSummary(supabase, orgId).catch(() => FAILED_READ),
    readCreditLots(supabase, orgId).catch(() => FAILED_READ),
  ]);
  if (!acct.supported || !priceRes.supported) return note(t.credits.notMigrated);

  const exempt = isCreditExempt(orgId);
  const platformAdmin = admin.data === true;
  // acct.account is null exactly when the read failed: the balance is unknown,
  // and no figure, purchase flow or "no prices" line may stand in for it.
  const account = acct.account;
  const balanceUnknown = acct.failed || account === null;
  const ledgerFailed = readFailed(txns);
  const user = userRes.data.user;
  const buy = buyAccess(orgId, org.current.role, paddleConfig);
  const catalog = planValue(catalogRead);
  const summary = planValue(summaryRead);
  const lots = planValue(lotsRead);
  const catalogFailed = catalogRead.state === "failed";
  const summaryFailed = summaryRead.state === "failed";
  const lotsFailed = lotsRead.state === "failed";
  const matrix = planMatrix(catalog, PLAN_ENV, paddleClient);
  // Whether the organization already has a live subscription is unknown when
  // its summary could not be read: offering a second checkout then could
  // double-charge, so nothing is offered until it reads.
  const planAccess = summaryFailed ? "hidden" : subscribeAccess(orgId, org.current.role, matrix, summary);

  return (
    <div className="rhythm">
      {header}

      <div className="panel flex flex-col gap-4 p-4">
        {exempt ? (
          <div className="flex flex-col gap-1">
            <h2 className="t-section">{t.credits.exemptTitle}</h2>
            <p className="text-[13px] text-[var(--color-muted)]">{t.credits.exempt}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              label={t.credits.available}
              value={account ? formatCredits(account.available, locale) : t.common.unknown}
              tone={account ? (account.available > 0 ? "ok" : "warn") : "idle"}
              sub={account ? undefined : t.common.couldNotRead}
            />
            <StatCard
              label={t.credits.reserved}
              value={account ? formatCredits(account.reserved, locale) : t.common.unknown}
              tone={account ? undefined : "idle"}
              sub={account ? undefined : t.common.couldNotRead}
            />
            <StatCard
              label={t.credits.balance}
              value={account ? formatCredits(account.balance, locale) : t.common.unknown}
              tone={account ? undefined : "idle"}
              sub={account ? undefined : t.common.couldNotRead}
            />
          </div>
        )}
        {!exempt && balanceUnknown && (
          <ErrorState compact message={t.credits.readFailed} />
        )}
        <p className="mono text-[11px] text-[var(--color-muted)]">
          {creditsEnforced ? t.credits.enforcedOn : t.credits.enforcedOff}
        </p>
      </div>

      {!exempt && summaryFailed && (
        <section id="plans" className="panel flex scroll-mt-24 flex-col gap-2 p-4" aria-labelledby="plan-title">
          <h2 id="plan-title" className="t-section">
            {t.plans.panelTitle}
          </h2>
          <ErrorState compact message={t.plans.billingReadFailed} />
        </section>
      )}
      {!exempt && summary && (
        <PlanPanel
          summary={summary}
          matrix={matrix}
          access={planAccess}
          orgId={orgId}
          userId={user?.id ?? null}
          email={user?.email ?? null}
          plansUnread={catalogFailed}
        />
      )}

      {buy === "allowed" && paddleConfig && account && (
        <BuyCredits
          config={paddleConfig}
          orgId={orgId}
          orgName={org.current.name}
          userId={user?.id ?? null}
          email={user?.email ?? null}
          balance={account.balance}
        />
      )}
      {buy === "admin_only" && <BuyCreditsAdminOnly />}
      {!paddleConfig && platformAdmin && !exempt && (
        <p className="mono text-[11px] text-[var(--color-muted)]">{t.credits.buy.notConfigured}</p>
      )}

      {platformAdmin && <GrantCreditsForm orgId={orgId} orgName={org.current.name} />}

      {!exempt && lotsFailed && (
        <div className="panel p-4">
          <h2 className="t-section">{t.plans.lotsTitle}</h2>
          <ErrorState compact message={t.plans.lotsReadFailed} />
        </div>
      )}
      {!exempt && lots && <CreditLots lots={lots} />}

      {ledgerFailed ? (
        <div className="panel p-4">
          <h2 className="t-section">{t.credits.ledgerTitle}</h2>
          <ErrorState compact />
        </div>
      ) : (
        <CreditLedger rows={coerceTransactions(txns.data)} />
      )}

      {priceRes.failed ? (
        <div className="panel p-4">
          <h2 className="t-section">{t.credits.pricesTitle}</h2>
          <ErrorState compact />
        </div>
      ) : (
        <CreditPricesEditor prices={Object.values(priceRes.prices)} canEdit={platformAdmin} />
      )}
    </div>
  );
}
