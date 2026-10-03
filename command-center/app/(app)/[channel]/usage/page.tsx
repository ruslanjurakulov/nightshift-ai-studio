import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/ReadError";
import { UsageView } from "@/components/usage/UsageView";
import { CreditsLink } from "@/components/usage/CreditsLink";
import { getOrgContext } from "@/lib/orgs-server";
import { createClient } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { isCreditExempt } from "@/lib/credits";
import { atLeast } from "@/lib/auth/roles-shared";
import { buyAccess, paddleClient, paddleConfig } from "@/lib/paddle";
import { PLAN_ENV, planMatrix, subscribeAccess } from "@/lib/plans";
import { freeGaps, offerUpgrade } from "@/lib/usage";
import { planValue, readBillingSummary, readPlanCatalog } from "@/lib/server/plans";
import { readUsageSummary } from "@/lib/server/usage";

const FAILED_READ = { state: "failed" as const };

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The Usage page: how much of the plan's credits this billing period has
 * used, the plan's other limits, and the extra-credits switch (migration
 * 0094). Phone-first, one column.
 *
 * Everything is read as the signed-in person, through usage_summary(), which
 * answers for their own workspace only. The Credits page keeps buying and the
 * ledger; this page only links there ("Buy credits", "Upgrade plan"), so no
 * checkout is duplicated and the terms stay where the price is.
 *
 * Reads end three ways and never blur (CLAUDE.md #5): a real summary, "not
 * available yet" (0094 not applied: the page says so and the Credits page is
 * unchanged) and "could not read" (no figure, no 0%, a retry).
 */
export default async function UsagePage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const [org, supabase] = await Promise.all([getOrgContext(), createClient()]);
  const header = <PageHeader icon="usage" title={t.usage.title} subtitle={t.usage.subtitle} actions={<CreditsLink />} />;
  const note = (text: React.ReactNode) => (
    <div className="rhythm">
      {header}
      <div className="panel flex flex-col items-start gap-3 p-4 text-sm text-[var(--color-muted)]">{text}</div>
    </div>
  );

  if (!supabase || !org.supported) return note(t.org.notMigrated);
  if (!org.current) return note(t.credits.noOrg);
  const orgId = org.current.id;
  const role = org.current.role;

  if (isCreditExempt(orgId)) {
    return (
      <div className="rhythm">
        {header}
        <div className="panel flex flex-col gap-1 p-5 sm:p-6">
          <h2 className="t-section">{t.credits.exemptTitle}</h2>
          <p className="text-sm text-[var(--color-muted)]">{t.credits.exempt}</p>
        </div>
      </div>
    );
  }

  const [usageRead, catalogRead, billingRead] = await Promise.all([
    readUsageSummary(supabase, orgId).catch(() => FAILED_READ),
    readPlanCatalog(supabase).catch(() => FAILED_READ),
    readBillingSummary(supabase, orgId).catch(() => FAILED_READ),
  ]);

  if (usageRead.state === "unsupported") return note(t.usage.notMigrated);
  if (usageRead.state === "failed") {
    return (
      <div className="rhythm">
        {header}
        <div className="panel p-4">
          <ErrorState compact message={t.usage.readFailed} />
        </div>
      </div>
    );
  }

  const summary = usageRead.value;
  if (summary.exempt) {
    return (
      <div className="rhythm">
        {header}
        <div className="panel flex flex-col gap-1 p-5 sm:p-6">
          <h2 className="t-section">{t.credits.exemptTitle}</h2>
          <p className="text-sm text-[var(--color-muted)]">{t.credits.exempt}</p>
        </div>
      </div>
    );
  }

  const matrix = planMatrix(planValue(catalogRead), PLAN_ENV, paddleClient);
  // The same two rules the Credits page uses to show packs and plan cards, so
  // a link here never points at a section that is not there.
  const canBuy = buyAccess(orgId, role, paddleConfig) === "allowed";
  const planAccess = billingRead.state === "failed" ? "hidden" : subscribeAccess(orgId, role, matrix, planValue(billingRead));
  const canUpgrade = planAccess !== "hidden" && offerUpgrade(summary, matrix);

  return (
    <div className="rhythm">
      {header}
      <UsageView
        summary={summary}
        nowMs={Date.now()}
        orgId={orgId}
        canChange={atLeast(role, "admin")}
        canBuy={canBuy}
        canUpgrade={canUpgrade}
        gaps={freeGaps(matrix)}
      />
    </div>
  );
}
