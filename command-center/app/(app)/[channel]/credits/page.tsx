import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { CreditActivity } from "@/components/credits/CreditActivity";
import { BalanceHero } from "@/components/credits/BalanceHero";
import { GrantCreditsForm } from "@/components/credits/GrantCreditsForm";
import { CreditPricesEditor } from "@/components/credits/CreditPricesEditor";
import { BuyCredits, BuyCreditsAdminOnly } from "@/components/credits/BuyCredits";
import { getOrgContext } from "@/lib/orgs-server";
import { createClient } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { coerceTransactions, isCreditExempt } from "@/lib/credits";
import { creditsEnforced, readCreditAccount, readCreditPriceList, readCreditPrices } from "@/lib/server/credits";
import { buyAccess, paddleClient, paddleConfig } from "@/lib/paddle";
import { PLAN_ENV, balanceSplit, generationRates, planMatrix, subscribeAccess } from "@/lib/plans";
import { CREDIT_EXPIRY_MONTHS } from "@/lib/legal";
import { readSellableModels } from "@/lib/creative/registry";
import { planValue, readBillingSummary, readCreditLots, readPlanCatalog } from "@/lib/server/plans";
import { PlanPanel } from "@/components/credits/PlanPanel";
import { CreditLots } from "@/components/credits/CreditLots";
import { InviteFriendsCard } from "@/components/credits/InviteFriendsCard";
import { InviteAdminPanel } from "@/components/credits/InviteAdminPanel";
import { readInviteAdmin, readMyInvite } from "@/lib/server/friend-invites";
import { ErrorState } from "@/components/ReadError";
import { readFailed } from "@/lib/readState";

const FAILED_READ = { state: "failed" as const };

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The current organization's credits, phone-first: the balance at the top
 * (available, on hold for jobs in progress, and by source with expiry), then
 * the plans and top-up packs with what each buys at today's prices and their
 * terms before the buttons, then the history in plain language. For a
 * platform owner/admin, the grant form and the price list editor at the end.
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
  const { t } = await getDictionary();
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

  const [acct, priceRes, txns, admin, userRes, catalogRead, summaryRead, lotsRead, modelsRead, inviteRead] = await Promise.all([
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
    readSellableModels(supabase),
    // Invite friends (0092): the person's own link and progress. Unsupported
    // (not applied yet) leaves the card out; a failed read says so.
    readMyInvite(supabase),
  ]);
  if (!acct.supported || !priceRes.supported) return note(t.credits.notMigrated);

  const exempt = isCreditExempt(orgId);
  const platformAdmin = admin.data === true;
  // The editor needs the base rates, margins and notes: the raw list, which
  // the database (0084) shows a platform owner/admin only. Never read for
  // anyone else, so a member's page never carries a margin.
  const priceList = platformAdmin ? await readCreditPriceList(supabase) : null;
  const inviteAdmin = platformAdmin ? await readInviteAdmin(supabase) : null;
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

  // What credits buy, from today's prices: the registry's sellable models
  // (0035, priced from credit_prices) and the per-minute price. A failed or
  // missing read leaves the equivalents out — never a hand-typed figure.
  const rates = priceRes.failed ? null : generationRates(modelsRead.status === "ok" ? modelsRead.models : null, priceRes.prices);
  const split = balanceSplit(account, summary, lots);
  // How long pack credits last: the database's policy (0034) when it was read;
  // before 0034 the deployment's documented term; otherwise not stated.
  const packValidMonths =
    catalogRead.state === "ok"
      ? catalogRead.value.packValidMonths
      : catalogRead.state === "unsupported"
        ? CREDIT_EXPIRY_MONTHS
        : undefined;
  const offersPacks = buy === "allowed" && Boolean(paddleConfig) && Boolean(account);
  const offersPlans = !exempt && Boolean(summary) && planAccess === "allowed";

  return (
    <div className="rhythm">
      {header}

      {exempt ? (
        <div className="panel flex flex-col gap-1 p-5 sm:p-6">
          <h2 className="t-section">{t.credits.exemptTitle}</h2>
          <p className="text-[13px] text-[var(--color-muted)]">{t.credits.exempt}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <BalanceHero split={split} rates={rates} offers={{ plans: offersPlans, packs: offersPacks }} />
          {balanceUnknown && (
            <div className="panel p-4">
              <ErrorState compact message={t.credits.readFailed} />
            </div>
          )}
        </div>
      )}

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
          rates={rates}
        />
      )}

      {offersPacks && paddleConfig && account && (
        <BuyCredits
          config={paddleConfig}
          orgId={orgId}
          userId={user?.id ?? null}
          email={user?.email ?? null}
          balance={account.balance}
          rates={rates}
          packValidMonths={packValidMonths}
        />
      )}
      {buy === "admin_only" && <BuyCreditsAdminOnly />}

      {/* Invite friends: for a workspace that pays, and for anyone who can run it
          (the reward is paid into it). Left out before migration 0092. */}
      {!exempt && org.current.role !== "viewer" && org.current.role !== "editor" && inviteRead.state === "ok" && (
        <InviteFriendsCard invite={inviteRead.value} orgId={orgId} />
      )}
      {!exempt && org.current.role !== "viewer" && org.current.role !== "editor" && inviteRead.state === "failed" && (
        <section id="invite" className="panel flex scroll-mt-24 flex-col gap-2 p-4" aria-labelledby="invite-title">
          <h2 id="invite-title" className="t-section">
            {t.invite.title}
          </h2>
          <ErrorState compact message={t.invite.readFailed} />
        </section>
      )}

      {ledgerFailed ? (
        <div className="panel p-4">
          <h2 className="t-section">{t.credits.ledgerTitle}</h2>
          <ErrorState compact />
        </div>
      ) : (
        <CreditActivity rows={coerceTransactions(txns.data)} showRefs={platformAdmin} />
      )}

      {!exempt && lotsFailed && (
        <div className="panel p-4">
          <h2 className="t-section">{t.plans.lotsTitle}</h2>
          <ErrorState compact message={t.plans.lotsReadFailed} />
        </div>
      )}
      {!exempt && lots && <CreditLots lots={lots} />}

      {/* Operator tools: the deployment switch, granting, and the raw price list. */}
      {platformAdmin && (
        <>
          <p className="mono text-[11px] text-[var(--color-muted)]">
            {creditsEnforced ? t.credits.enforcedOn : t.credits.enforcedOff}
          </p>
          {!paddleConfig && !exempt && <p className="mono text-[11px] text-[var(--color-muted)]">{t.credits.buy.notConfigured}</p>}
          <GrantCreditsForm orgId={orgId} orgName={org.current.name} />
          {inviteAdmin?.state === "ok" && <InviteAdminPanel admin={inviteAdmin.value} />}
          {inviteAdmin?.state === "failed" && (
            <div className="panel p-4">
              <h2 className="t-section">{t.invite.adminTitle}</h2>
              <ErrorState compact message={t.invite.adminReadFailed} />
            </div>
          )}
          {!priceList || priceList.failed || !priceList.supported ? (
            <div className="panel p-4">
              <h2 className="t-section">{t.credits.pricesTitle}</h2>
              <ErrorState compact />
            </div>
          ) : (
            <CreditPricesEditor prices={Object.values(priceList.prices)} canEdit />
          )}
        </>
      )}
    </div>
  );
}
