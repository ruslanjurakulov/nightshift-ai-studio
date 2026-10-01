import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/ReadError";
import { ModelAvailabilityBoard } from "@/components/models/ModelAvailabilityBoard";
import { isOperator } from "@/lib/auth/org-roles";
import { createClient } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { isMissingFunction } from "@/lib/orgs";
import { readCreditPrices } from "@/lib/server/credits";
import { coerceAdminModels, latestProbes } from "@/lib/models-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Models — the platform operator sets each model's availability (migration
 * 0035): hidden → beta → ga, or back, or disabled. Operator-only: the rail and
 * the layout redirect keep everyone else out (lib/navigation.ts), this page
 * checks again, and the data itself comes from model_registry_admin(), which
 * the database refuses to anyone but a platform admin.
 *
 * Read as the signed-in operator; no service key. Prices are shown, not
 * edited here: the price list has one editor, on the Credits page.
 */
export default async function ModelsPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const header = <PageHeader icon="models" title={t.models.title} subtitle={t.models.subtitle} />;
  const note = (text: string) => (
    <div className="rhythm">
      {header}
      <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{text}</div>
    </div>
  );

  if (!(await isOperator())) return note(t.models.forbidden);
  const supabase = await createClient();
  if (!supabase) return <NotConfigured />;

  const [registry, probes, prices] = await Promise.all([
    supabase.rpc("model_registry_admin"),
    supabase
      .from("model_probe_runs")
      .select("model_id,ok,error_code,capability,created_at")
      .order("created_at", { ascending: false })
      .limit(2000),
    readCreditPrices(supabase),
  ]);

  if (registry.error) {
    if (isMissingFunction(registry.error)) return note(t.models.notEnabled);
    if (registry.error.code === "42501") return note(t.models.forbidden);
    return (
      <div className="rhythm">
        {header}
        <div className="panel p-4">
          <ErrorState compact message={t.models.readFailed} />
        </div>
      </div>
    );
  }

  const models = coerceAdminModels(registry.data);
  const priceList =
    prices.supported && !prices.failed
      ? Object.fromEntries(Object.values(prices.prices).map((p) => [p.unit, p.creditsPerUnit]))
      : null;

  return (
    <div className="rhythm">
      {header}
      {models.length === 0 ? (
        <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{t.models.empty}</div>
      ) : (
        <ModelAvailabilityBoard
          models={models}
          probes={probes.error ? null : latestProbes(probes.data)}
          prices={priceList}
        />
      )}
    </div>
  );
}
