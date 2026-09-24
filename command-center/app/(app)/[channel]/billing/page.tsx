import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { getDictionary } from "@/lib/i18n/server";
import { PROVIDERS } from "@/lib/providers";
import { isGithubConfigured, listConfiguredSecretNames } from "@/lib/server/github-secrets";
import { BillingBoard, type ProviderView, type RunwayView } from "@/components/billing/BillingBoard";
import {
  BILLED_PROVIDERS,
  daysLeft,
  elevenLabsRunway,
  latestBalance,
  ledgerBalanceUsd,
  providerBurn,
  type BalanceRow,
  type BillingSettingsRow,
  type CostRowLite,
  type TopupRow,
} from "@/lib/billing";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Billing — balances, burn and runway for every paid provider.
 *
 * Provider accounts are repository-wide (one key per provider, shared by every
 * channel), so this page reads spend across all channels rather than the
 * selected one. Balances come from `provider_balances` (written by the pipeline
 * with the provider's own API); providers without a balance API are tracked
 * from the operator's confirmed top-ups. See lib/billing.ts for the rules.
 */
export default async function BillingPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const supabase = await createClient();

  let costs: CostRowLite[] = [];
  let balances: BalanceRow[] = [];
  let settings: BillingSettingsRow[] = [];
  let topups: TopupRow[] = [];
  let migrationMissing = false;

  if (supabase) {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const [c, b, s, tp] = await Promise.all([
      supabase
        .from("video_costs")
        .select("unit,quantity,stage,recorded_at,video_id,slug")
        .gte("recorded_at", since)
        .limit(10000),
      supabase.from("provider_balances").select("*").order("checked_at", { ascending: false }).limit(200),
      supabase.from("provider_billing_settings").select("*"),
      supabase.from("provider_topups").select("provider,amount_usd,paid_at").order("paid_at", { ascending: false }).limit(1000),
    ]);
    costs = (c.data ?? []) as CostRowLite[];
    balances = (b.data ?? []) as BalanceRow[];
    settings = (s.data ?? []) as BillingSettingsRow[];
    topups = (tp.data ?? []) as TopupRow[];
    migrationMissing = [b.error, s.error, tp.error].some((e) => e?.code === "42P01");
  }

  let configured = new Set<string>();
  if (isGithubConfigured) {
    try {
      configured = new Set(await listConfiguredSecretNames());
    } catch {
      configured = new Set();
    }
  }
  const secretOf = new Map(PROVIDERS.map((p) => [p.id, p.secretName]));

  const views: ProviderView[] = BILLED_PROVIDERS.map((p) => {
    const st = settings.find((x) => x.provider === p.id) ?? null;
    const price = st?.usd_per_unit === null || st?.usd_per_unit === undefined ? null : Number(st.usd_per_unit);
    const burn = providerBurn(p, costs, price);
    const snap = latestBalance(balances, p.id);
    const ledgerUsd = ledgerBalanceUsd(p, topups, costs, price);

    // Days left: a native-unit balance against native-unit burn (ElevenLabs
    // credits vs characters), else the USD ledger against USD burn.
    let left: number | "never" | null = null;
    if (snap && snap.remaining !== null && p.id === "elevenlabs") left = daysLeft(snap.remaining, burn.unitsPerDay);
    else if (ledgerUsd !== null) left = daysLeft(ledgerUsd, burn.usdPerDay);
    else if (burn.units === 0) left = "never";

    const secret = secretOf.get(p.id);
    return {
      id: p.id,
      name: p.name,
      billingUrl: p.billingUrl,
      unitLabel: p.unitLabel,
      keySet: secret ? configured.has(secret) : false,
      price,
      units30: burn.units,
      usdPerDay: burn.usdPerDay,
      apiBalance: snap
        ? { remaining: snap.remaining, total: snap.total, unit: snap.unit, tier: snap.tier, resetsAt: snap.resets_at, checkedAt: snap.checked_at }
        : null,
      ledgerUsd,
      daysLeft: left,
      lowBalanceDays: st?.low_balance_days ?? 3,
      includeInBulk: st?.include_in_bulk ?? true,
      cardSaved: st?.card_saved_on_provider ?? false,
      autoRecharge: st?.auto_recharge_on_provider ?? false,
    };
  });

  const eleven = latestBalance(balances, "elevenlabs");
  const runway: RunwayView | null =
    eleven && eleven.remaining !== null
      ? {
          ...elevenLabsRunway(eleven.remaining, costs),
          total: eleven.total,
          resetsAt: eleven.resets_at,
          tier: eleven.tier,
          checkedAt: eleven.checked_at,
        }
      : null;

  return (
    <div className="rhythm">
      <PageHeader icon="billing" title={t.billing.title} subtitle={t.billing.subtitle} />
      {migrationMissing && (
        <div className="panel p-4" role="status">
          <p className="text-[13px] text-[var(--color-warn)]">{t.billing.migrationMissing}</p>
        </div>
      )}
      <BillingBoard providers={views} runway={runway} githubConfigured={isGithubConfigured} />
    </div>
  );
}
