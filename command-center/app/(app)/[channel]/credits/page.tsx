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
import { buyAccess, paddleConfig } from "@/lib/paddle";

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

  const [acct, priceRes, txns, admin, userRes] = await Promise.all([
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
  ]);
  if (!acct.supported || !priceRes.supported) return note(t.credits.notMigrated);

  const exempt = isCreditExempt(orgId);
  const platformAdmin = admin.data === true;
  const account = acct.account;
  const user = userRes.data.user;
  const buy = buyAccess(orgId, org.current.role, paddleConfig);

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
              value={formatCredits(account?.available ?? 0, locale)}
              tone={(account?.available ?? 0) > 0 ? "ok" : "warn"}
            />
            <StatCard label={t.credits.reserved} value={formatCredits(account?.reserved ?? 0, locale)} />
            <StatCard label={t.credits.balance} value={formatCredits(account?.balance ?? 0, locale)} />
          </div>
        )}
        <p className="mono text-[11px] text-[var(--color-muted)]">
          {creditsEnforced ? t.credits.enforcedOn : t.credits.enforcedOff}
        </p>
      </div>

      {buy === "allowed" && paddleConfig && (
        <BuyCredits
          config={paddleConfig}
          orgId={orgId}
          orgName={org.current.name}
          userId={user?.id ?? null}
          email={user?.email ?? null}
          balance={account?.balance ?? 0}
        />
      )}
      {buy === "admin_only" && <BuyCreditsAdminOnly />}
      {!paddleConfig && platformAdmin && !exempt && (
        <p className="mono text-[11px] text-[var(--color-muted)]">{t.credits.buy.notConfigured}</p>
      )}

      {platformAdmin && <GrantCreditsForm orgId={orgId} orgName={org.current.name} />}

      <CreditLedger rows={coerceTransactions(txns.data)} />

      <CreditPricesEditor prices={Object.values(priceRes.prices)} canEdit={platformAdmin} />
    </div>
  );
}
