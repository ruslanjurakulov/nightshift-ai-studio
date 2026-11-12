import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/ReadError";
import { CustomersReport } from "@/components/customers/CustomersReport";
import { isOperator } from "@/lib/auth/org-roles";
import { createClient } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { isMissingFunction } from "@/lib/orgs";
import {
  DAILY_DAYS,
  accountsArgs,
  coerceAccounts,
  coerceDaily,
  coerceTotals,
  parsePage,
  parseSearch,
  parseSort,
} from "@/lib/customers";
import "../../app-pages-g4.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Param = string | string[] | undefined;

/**
 * Customers — how many people and workspaces there are, and per workspace the credits it spent, bought and holds
 * (migration 0138). Operator-only: the rail and the layout redirect keep everyone else out (lib/navigation.ts), this page
 * checks again, and the data comes from three functions the database refuses to anyone but a platform admin — hiding the
 * link was never the protection.
 *
 * Read as the signed-in operator through the anon key; no service key. Search, sort and the page are in the address bar
 * and go to the database as they are (it sorts and pages; one page is at most 50 rows). Nothing here writes, grants or
 * spends.
 */
export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: Param; sort?: Param; page?: Param }> }) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const c = t.customers;
  const header = <PageHeader icon="customers" title={c.title} subtitle={c.subtitle} />;
  const note = (text: string) => (
    <div className="rhythm ns-open g4">
      {header}
      <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{text}</div>
    </div>
  );

  // A customer who types the URL learns nothing: no title, no description of what the page holds, no role words.
  const unavailable = (
    <div className="rhythm ns-open g4">
      <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{c.forbidden}</div>
    </div>
  );
  if (!(await isOperator())) return unavailable;
  const supabase = await createClient();
  if (!supabase) return <NotConfigured />;

  const sp = await searchParams;
  const q = parseSearch(sp.q);
  const sort = parseSort(sp.sort);
  const page = parsePage(sp.page);
  const [totals, daily, accounts] = await Promise.all([
    supabase.rpc("operator_customer_totals"),
    supabase.rpc("operator_customer_daily", { p_days: DAILY_DAYS }),
    supabase.rpc("operator_customer_accounts", accountsArgs(q, sort, page)),
  ]);

  const errors = [totals.error, daily.error, accounts.error].filter((e): e is NonNullable<typeof e> => !!e);
  if (errors.some((e) => isMissingFunction(e))) return note(c.notEnabled);
  if (errors.some((e) => e.code === "42501")) return unavailable;
  const headline = coerceTotals(totals.data);
  // One figure the page cannot stand behind and the whole read is "failed": a partial page reads as the whole.
  if (errors.length > 0 || headline === null || !Array.isArray(daily.data) || !Array.isArray(accounts.data)) {
    return (
      <div className="rhythm ns-open g4">
        {header}
        <div className="panel p-5 sm:p-6">
          <ErrorState compact message={c.readFailed} />
        </div>
      </div>
    );
  }

  return (
    <div className="rhythm ns-open g4">
      {header}
      <CustomersReport totals={headline} daily={coerceDaily(daily.data)} accounts={coerceAccounts(accounts.data)} q={q} sort={sort} page={page} />
    </div>
  );
}
