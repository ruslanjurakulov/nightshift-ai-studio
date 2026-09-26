import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { getDictionary } from "@/lib/i18n/server";
import { PROVIDERS } from "@/lib/providers";
import { isGithubConfigured, listConfiguredSecretNames } from "@/lib/server/github-secrets";
import { BillingBoard, type ProviderView, type RunwayView } from "@/components/billing/BillingBoard";
import { UnitEconomicsCard } from "@/components/billing/UnitEconomicsCard";
import { getChannelContext } from "@/lib/channels-server";
import { channelInScope, channelName, inSelection, isScoped, orgWide, scopeQuery } from "@/lib/channels";
import { unitEconomics, type DurationRow, type LedgerRow } from "@/lib/unitEconomics";
import {
  BILLED_PROVIDERS,
  daysLeft,
  elevenLabsRunway,
  latestBalance,
  ledgerBalanceUsd,
  providerBurn,
  type BalanceRow,
  type BillingSettingsRow,
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
  const { channels, selection, scope } = await getChannelContext();

  let costs: LedgerRow[] = [];
  let balances: BalanceRow[] = [];
  let settings: BillingSettingsRow[] = [];
  let topups: TopupRow[] = [];
  let migrationMissing = false;

  // Provider accounts are the platform operator's (0018 gives them to the
  // default organization). Inside any other organization — including when a
  // platform admin has switched into a tenant — they are not this org's
  // business, and neither is the platform-wide spend behind their burn rate.
  const operatorView = scope.includeGlobal;

  if (supabase) {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const ledger = supabase
      .from("video_costs")
      .select("unit,quantity,stage,recorded_at,video_id,slug,channel_id,estimated_usd");
    const [c, b, s, tp] = await Promise.all([
      // In the operator's view the ledger stays whole: the provider keys are
      // shared by every channel, so their burn and runway are only true when
      // measured over everything they paid for. Unit economics is narrowed to
      // the view below. In a tenant's view only its own channels are read.
      (operatorView ? ledger : scopeQuery(ledger, orgWide(scope))).gte("recorded_at", since).limit(10000),
      operatorView
        ? supabase.from("provider_balances").select("*").order("checked_at", { ascending: false }).limit(200)
        : null,
      operatorView ? supabase.from("provider_billing_settings").select("*") : null,
      operatorView
        ? supabase.from("provider_topups").select("provider,amount_usd,paid_at").order("paid_at", { ascending: false }).limit(1000)
        : null,
    ]);
    costs = (c.data ?? []) as LedgerRow[];
    balances = (b?.data ?? []) as BalanceRow[];
    settings = (s?.data ?? []) as BillingSettingsRow[];
    topups = (tp?.data ?? []) as TopupRow[];
    migrationMissing = [b?.error, s?.error, tp?.error].some((e) => e?.code === "42P01");
  }

  // Unit economics is per channel (a price per video is a property of what the
  // channel makes), unlike the provider accounts above, which are shared.
  const channelCosts = costs.filter((r) => inSelection(r.channel_id, scope));
  let ue = unitEconomics(channelCosts);
  if (supabase && ue.sampleSize > 0) {
    // Length of each sampled video from its Video IR (narration is the master
    // clock). Missing migration 0013 or a pre-IR video just leaves the length
    // unknown, and that video out of the per-minute figures.
    const slugs = [...new Set(ue.videos.flatMap((v) => (v.slug ? [v.slug] : [])))];
    const ids = [...new Set(ue.videos.flatMap((v) => (v.videoId ? [v.videoId] : [])))];
    const cols = "video_id,slug,channel_id,duration_s:manifest->audio->duration_s";
    const [bySlug, byId] = await Promise.all([
      slugs.length ? supabase.from("videos").select(cols).in("slug", slugs) : null,
      ids.length ? supabase.from("videos").select(cols).in("video_id", ids) : null,
    ]);
    // A slug is not unique across organizations; only this view's videos
    // may lend a length to its figures.
    const durations = [
      ...((bySlug?.data ?? []) as unknown as DurationRow[]),
      ...((byId?.data ?? []) as unknown as DurationRow[]),
    ].filter((d) => channelInScope(d.channel_id, scope));
    if (durations.length) ue = unitEconomics(channelCosts, { durations });
  }
  const ueScope = isScoped(selection) ? channelName(channels, selection) : t.channels.allChannels;

  let configured = new Set<string>();
  if (isGithubConfigured && operatorView) {
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
      // USD balance for the top-up planner: the ledger when there is one, else
      // ElevenLabs credits priced at the operator's rate. Unknown otherwise.
      balanceUsd:
        ledgerUsd ??
        (p.id === "elevenlabs" && snap?.remaining != null && price !== null
          ? (snap.remaining / p.unitSize) * price
          : null),
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
      <UnitEconomicsCard ue={ue} scope={ueScope} />
      {operatorView ? (
        <BillingBoard providers={views} runway={runway} githubConfigured={isGithubConfigured} />
      ) : (
        <div className="panel p-4" role="status">
          <p className="text-[13px] text-[var(--color-muted)]">{t.billing.providersOperatorOnly}</p>
        </div>
      )}
    </div>
  );
}
