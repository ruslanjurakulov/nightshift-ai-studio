import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/ReadError";
import { ModelAvailabilityBoard } from "@/components/models/ModelAvailabilityBoard";
import { ModelDiscovery } from "@/components/models/ModelDiscovery";
import { isOperator } from "@/lib/auth/org-roles";
import { createClient } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { isMissingFunction } from "@/lib/orgs";
import { readCreditPriceList } from "@/lib/server/credits";
import { readCustomerModels, readOperatorModels } from "@/lib/server/model-discovery";
import { coerceAdminModels, latestProbes } from "@/lib/models-admin";
import { filtersFromQuery } from "@/lib/models-discovery";
import { getChannelContext } from "@/lib/channels-server";
import { channelPath } from "@/lib/channels";
import { getOrgContext } from "@/lib/orgs-server";
import styles from "@/components/models/ModelDiscovery.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Models — the catalog of generative models, by task, for whoever opens it:
 *
 *  - a customer sees only what they may use: sellable_models() (0035 and its
 *    successors: beta/ga, a successful real probe, a positive price, no open
 *    vendor terms), read under their own session;
 *  - the platform operator sees the whole registry (model_registry_admin(),
 *    which the database refuses to anyone else), each model with what keeps
 *    it off sale, and keeps the availability switches (?view=manage).
 *
 * Read as the signed-in person; no service key. Prices come from the live
 * price list (credit_prices) and are only shown, never edited here (the price
 * list has one editor, on the Credits page). Nothing on this page spends:
 * "Use in Studio" only fills the Studio's form.
 */
export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const c = t.modelDiscovery;
  const operator = await isOperator();
  const q = await searchParams;
  const manage = operator && q.view === "manage";
  const { slug } = await getChannelContext();

  const header = (
    <PageHeader icon="models" title={c.title} subtitle={manage ? t.models.subtitle : operator ? c.subtitleOperator : c.subtitle} />
  );
  // The operator's two views: the catalog, and the availability switches.
  const views = operator ? (
    <nav aria-label={c.viewsLabel} className={styles.views}>
      <Link href={channelPath(slug, "/models")} aria-current={manage ? undefined : "page"}>
        {c.viewBrowse}
      </Link>
      <Link href={`${channelPath(slug, "/models")}?view=manage`} aria-current={manage ? "page" : undefined}>
        {c.viewManage}
      </Link>
    </nav>
  ) : null;
  const note = (text: string) => (
    <div className="rhythm">
      {header}
      {views}
      <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{text}</div>
    </div>
  );
  const failed = (
    <div className="rhythm">
      {header}
      {views}
      <div className="panel p-4">
        <ErrorState compact message={c.readFailed} />
      </div>
    </div>
  );

  const supabase = await createClient();
  if (!supabase) return <NotConfigured />;

  if (manage) {
    // The availability board, unchanged: the operator's switches (0035).
    const [registry, probes, prices] = await Promise.all([
      supabase.rpc("model_registry_admin"),
      supabase
        .from("model_probe_runs")
        .select("model_id,ok,error_code,capability,created_at")
        .order("created_at", { ascending: false })
        .limit(2000),
      // The operator's own list (base rates); 0084 shows it to no one else.
      readCreditPriceList(supabase),
    ]);
    if (registry.error) {
      if (isMissingFunction(registry.error)) return note(t.models.notEnabled);
      if (registry.error.code === "42501") return note(t.models.forbidden);
      return failed;
    }
    const adminModels = coerceAdminModels(registry.data);
    const priceList =
      prices.supported && !prices.failed
        ? Object.fromEntries(Object.values(prices.prices).map((p) => [p.unit, p.creditsPerUnit]))
        : null;
    if (adminModels.length === 0) return note(t.models.empty);
    return (
      <div className="rhythm">
        {header}
        {views}
        <ModelAvailabilityBoard models={adminModels} probes={probes.error ? null : latestProbes(probes.data)} prices={priceList} />
      </div>
    );
  }

  // The open organization, for the one gate that depends on it (`paid`: a first purchase).
  const org = operator ? null : await getOrgContext().catch(() => null);
  const read = operator ? await readOperatorModels(supabase) : await readCustomerModels(supabase, org?.current?.id ?? null);
  if (read.status === "not_enabled") return note(c.notEnabled);
  if (read.status === "forbidden") return note(c.forbidden);
  if (read.status !== "ok") return failed;
  if (read.models.length === 0) return note(operator ? c.emptyOperator : c.emptyCustomer);

  return (
    <div className="rhythm">
      {header}
      {views}
      <ModelDiscovery
        models={read.models}
        operator={operator}
        pricesRead={read.pricesRead}
        probesRead={read.probesRead}
        initialFilters={filtersFromQuery(q)}
        initialModel={typeof q.model === "string" ? q.model : null}
      />
    </div>
  );
}
