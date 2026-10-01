import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/ReadError";
import { MarginReport } from "@/components/margin/MarginReport";
import { isOperator } from "@/lib/auth/org-roles";
import { createClient } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { isMissingFunction } from "@/lib/orgs";
import { coerceMarginRows, parsePeriod, periodRange } from "@/lib/margin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Margin — what each creative generation cost at the provider next to what it
 * earned, per model, capability and day (migration 0063). Operator-only: the
 * rail and the layout redirect keep everyone else out (lib/navigation.ts), this
 * page checks again, and the data comes from operator_margin_report(), which
 * the database refuses to anyone but a platform admin — hiding the link was
 * never the protection.
 *
 * Read as the signed-in operator through the anon key; no service key. Nothing
 * here writes, spends or re-prices anything.
 */
export default async function MarginPage({ searchParams }: { searchParams: Promise<{ days?: string | string[] }> }) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const header = <PageHeader icon="margin" title={t.margin.title} subtitle={t.margin.subtitle} />;
  const note = (text: string) => (
    <div className="rhythm">
      {header}
      <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{text}</div>
    </div>
  );

  if (!(await isOperator())) return note(t.margin.forbidden);
  const supabase = await createClient();
  if (!supabase) return <NotConfigured />;

  const days = parsePeriod((await searchParams).days);
  const { from, to } = periodRange(days);
  const { data, error } = await supabase.rpc("operator_margin_report", { p_from: from, p_to: to });

  if (error || !Array.isArray(data)) {
    if (error && isMissingFunction(error)) return note(t.margin.notEnabled);
    if (error?.code === "42501") return note(t.margin.forbidden);
    return (
      <div className="rhythm">
        {header}
        <div className="panel p-4">
          <ErrorState compact message={t.margin.readFailed} />
        </div>
      </div>
    );
  }

  return (
    <div className="rhythm">
      {header}
      <MarginReport rows={coerceMarginRows(data)} days={days} />
    </div>
  );
}
