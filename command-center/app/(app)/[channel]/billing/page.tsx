import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { StateBlock } from "@/components/states/StateBlock";
import "../../app-pages-g5.css";
import { getDictionary } from "@/lib/i18n/server";
import { PROVIDERS } from "@/lib/providers";
import { isGithubConfigured, listConfiguredSecretNames } from "@/lib/server/github-secrets";
import { BillingBoard, type ProviderView, type RunwayView } from "@/components/billing/BillingBoard";
import { UnitEconomicsCard } from "@/components/billing/UnitEconomicsCard";
import { getChannelContext } from "@/lib/channels-server";
import { guardOperatorPage } from "@/lib/auth/org-roles";
import { ErrorState } from "@/components/ReadError";
import { readFailed } from "@/lib/readState";
import { readAllPages } from "@/lib/paged-read";
import { num, ownerTime } from "@/lib/format";
import { timed } from "@/lib/server/read-timeout";
import { fmt } from "@/lib/i18n";
import { channelInScope, channelName, inSelection, isScoped, orgWide, scopeQuery } from "@/lib/channels";
import { unitEconomics, type DurationRow, type LedgerRow } from "@/lib/unitEconomics";
import {
  BILLED_PROVIDERS,
  daysLeft,
  elevenLabsRunway,
  firstUseMs,
  isTracked,
  latestBalance,
  ledgerBalanceUsd,
  oldestRowMs,
  providerBurn,
  providerHistoryStart,
  type BalanceRow,
  type BillingSettingsRow,
  type TopupRow,
} from "@/lib/billing";

/** A day, and how far back the spend ledger is ever read for a top-up older than 90 days. */
const DAY = 86_400_000;
const HORIZON_DAYS = 180;
type CostPageRow = LedgerRow & { id?: number; synced_at?: string | null };

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
  // Reads the operator's key names with the server's GitHub token: signed out
  // → /login, anyone else → 404, before any read (BR-H-001).
  const mayReadGithub = await guardOperatorPage();
  // One clock for the whole render: the window edges and the rows they are tested against must agree to the millisecond.
  const NOW = Date.now();
  const { t, locale } = await getDictionary();
  const tt = t.ownerTruth;
  const supabase = await createClient();
  const { channels, selection, scope } = await getChannelContext();

  let costs: CostPageRow[] = [];
  let balances: BalanceRow[] = [];
  let settings: BillingSettingsRow[] = [];
  let topups: TopupRow[] = [];
  let migrationMissing = false;
  // A failed read is "unknown", never an empty list that computes to $0 burn and "lasts never".
  let costsFailed = false;
  let settingsFailed = false;
  let balancesFailed = false;
  let topupsFailed = false;
  // The ledger read stopped at its ceiling: only the newest rows are counted.
  let costsCut = false;
  // The earliest top-up is older than the longest look-back (180 days): balances that depend on it are unknown.
  let horizonCapped = false;
  let coveredFromMs: number | null = null;
  // The newest time the nightly mirror wrote a cost row: the ledger is only as fresh as this.
  let lastSyncMs: number | null = null;

  // Provider accounts are the platform operator's (0018 gives them to the
  // default organization). Inside any other organization — including when a
  // platform admin has switched into a tenant — they are not this org's
  // business, and neither is the platform-wide spend behind their burn rate.
  const operatorView = scope.includeGlobal;

  if (supabase) {
    // The small tables first: the earliest top-up decides how far back the spend ledger must reach for the running
    // balance to be true (a top-up older than the window would leave its balance overstated).
    const [b, s, tp] = await Promise.all([
      operatorView
        ? timed(supabase.from("provider_balances").select("*").order("checked_at", { ascending: false }).limit(200))
        : null,
      operatorView ? timed(supabase.from("provider_billing_settings").select("*")) : null,
      operatorView
        ? timed(supabase.from("provider_topups").select("provider,amount_usd,paid_at").order("paid_at", { ascending: false }).limit(1000))
        : null,
    ]);
    balancesFailed = readFailed(b) && b?.error?.code !== "42P01";
    settingsFailed = readFailed(s) && s?.error?.code !== "42P01";
    topupsFailed = readFailed(tp) && tp?.error?.code !== "42P01";
    balances = (b?.data ?? []) as BalanceRow[];
    settings = (s?.data ?? []) as BillingSettingsRow[];
    topups = (tp?.data ?? []) as TopupRow[];
    migrationMissing = [b?.error, s?.error, tp?.error].some((e) => e?.code === "42P01");

    const firstTopup = Math.min(Infinity, ...topups.map((x) => Date.parse(x.paid_at)).filter(Number.isFinite));
    // Back 90 days, or to the earliest top-up so its balance is true, but never past 180 days (a long look-back is a long read).
    const wantMs = Math.min(NOW - 90 * DAY, Number.isFinite(firstTopup) ? firstTopup : Infinity);
    const sinceMs = Math.max(wantMs, NOW - HORIZON_DAYS * DAY);
    horizonCapped = wantMs < sinceMs;
    const sinceIso = new Date(sinceMs).toISOString();
    // In the operator's view the ledger stays whole: the provider keys are shared by every channel, so their burn
    // and runway are only true when measured over everything they paid for. Unit economics is narrowed to the view
    // below. In a tenant's view only its own channels are read. Newest first with a unique tie-break, a page at a
    // time (lib/paged-read.ts): one `.limit(10000)` came back as an arbitrary 1,000 rows (PostgREST's cap). `id` is read
    // so a row repeated by an insert between two pages is counted once.
    const read = await readAllPages<CostPageRow>(
      (from, to) => {
        const base = supabase
          .from("video_costs")
          // The exact total is asked for on the FIRST page only: counting is a scan, and the total does not change by page.
          .select("id,unit,quantity,stage,recorded_at,video_id,slug,channel_id,estimated_usd,synced_at", from === 0 ? { count: "exact" } : undefined);
        return timed(
          (operatorView ? base : scopeQuery(base, orgWide(scope)))
            .gte("recorded_at", sinceIso)
            .order("recorded_at", { ascending: false })
            .order("id", { ascending: false })
            .range(from, to),
        ) as unknown as PromiseLike<{ data: CostPageRow[] | null; error: unknown; count: number | null }>;
      },
      { keyOf: (r) => r.id },
    );
    costsFailed = Boolean(read.error);
    costs = read.rows;
    costsCut = read.truncated;
    for (const r of costs) {
      const t = r.synced_at ? Date.parse(r.synced_at) : NaN;
      if (Number.isFinite(t) && (lastSyncMs === null || t > lastSyncMs)) lastSyncMs = t;
    }
    // Spend is complete from here on: back to the cut-off, or only as far as the oldest row when the read stopped short.
    coveredFromMs = costsCut ? (oldestRowMs(costs) ?? NOW) : sinceMs;
  }

  // Unit economics is per channel (a price per video is a property of what the
  // channel makes), unlike the provider accounts above, which are shared.
  const channelCosts = costs.filter((r) => inSelection(r.channel_id, scope));
  let ue = unitEconomics(channelCosts);
  if (supabase && !costsFailed && ue.sampleSize > 0) {
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
  // Which keys are set is read from GitHub; when that read fails the lamp says "unknown", not "key missing".
  let keysUnknown = false;
  if (isGithubConfigured && operatorView && mayReadGithub) {
    try {
      configured = new Set(await listConfiguredSecretNames());
    } catch {
      configured = new Set();
      keysUnknown = true;
    }
  }
  const secretOf = new Map(PROVIDERS.map((p) => [p.id, p.secretName]));

  const firstTopupOf = (id: string): number | null => {
    const t = topups.filter((x) => x.provider === id).map((x) => Date.parse(x.paid_at)).filter(Number.isFinite);
    return t.length ? Math.min(...t) : null;
  };
  // Everything that needs the spend ledger AND the prices is unknown when either read failed.
  const usageUnknown = costsFailed || settingsFailed;
  // An empty ledger measured nothing: burn is unknown ("no rows yet"), not a measured zero.
  const burnUnknown = usageUnknown || costs.length === 0;

  const views: ProviderView[] = BILLED_PROVIDERS.map((p) => {
    const st = settings.find((x) => x.provider === p.id) ?? null;
    const price = st?.usd_per_unit === null || st?.usd_per_unit === undefined ? null : Number(st.usd_per_unit);
    const tracked = isTracked(p);
    const autoRecharge = st?.auto_recharge_on_provider ?? false;
    // The per-day figures are averaged over 30 days, or over THIS provider's own history when that is shorter.
    // When the read stopped short, rows older than the oldest one read are missing: the window must not reach before them.
    const ownStart = providerHistoryStart(firstUseMs(p, costs), firstTopupOf(p.id));
    const start = costsCut && coveredFromMs !== null ? Math.max(ownStart ?? coveredFromMs, coveredFromMs) : ownStart;
    const burn = providerBurn(p, costs, price, 30, NOW, start);
    const snap = balancesFailed ? null : latestBalance(balances, p.id);
    const ledgerUsd =
      usageUnknown || topupsFailed ? null : ledgerBalanceUsd(p, topups, costs, price, coveredFromMs);

    // Days left: a native-unit balance against native-unit burn (ElevenLabs
    // credits vs characters), else the USD ledger against USD burn. Never a
    // number for a provider whose spend is not recorded, and no alarm for one
    // that tops itself up.
    let left: ProviderView["daysLeft"] = null;
    if (usageUnknown) left = null;
    else if (!tracked) left = "untracked";
    else if (autoRecharge) left = "auto";
    else if (burnUnknown) left = null;
    else if (snap && snap.remaining !== null && p.id === "elevenlabs") left = daysLeft(snap.remaining, burn.unitsPerDay);
    else if (ledgerUsd !== null) left = daysLeft(ledgerUsd, burn.usdPerDay);
    // No balance known (no snapshot, no top-up logged, or a negative ledger) is unknown, even when nothing was spent:
    // "lasts never" is only true of a balance we can see.

    const secret = secretOf.get(p.id);
    return {
      id: p.id,
      name: p.name,
      billingUrl: p.billingUrl,
      unitLabel: p.unitLabel,
      keySet: secret ? configured.has(secret) : false,
      keyUnknown: keysUnknown,
      price: settingsFailed ? null : price,
      tracked,
      units30: burnUnknown || !tracked ? null : burn.units,
      windowDays: burn.windowDays,
      usdPerDay: burnUnknown || !tracked ? null : burn.usdPerDay,
      apiBalance: snap
        ? { remaining: snap.remaining, total: snap.total, unit: snap.unit, tier: snap.tier, resetsAt: snap.resets_at, checkedAt: snap.checked_at }
        : null,
      ledgerUsd,
      // USD balance for the top-up planner: the ledger when there is one, else
      // ElevenLabs credits priced at the operator's rate. Unknown otherwise.
      balanceUsd:
        ledgerUsd ??
        (p.id === "elevenlabs" && snap?.remaining != null && price !== null && !settingsFailed
          ? (snap.remaining / p.unitSize) * price
          : null),
      daysLeft: left,
      lowBalanceDays: st?.low_balance_days ?? 3,
      includeInBulk: st?.include_in_bulk ?? true,
      cardSaved: st?.card_saved_on_provider ?? false,
      autoRecharge,
    };
  });

  const eleven = latestBalance(balances, "elevenlabs");
  const runway: RunwayView | null =
    !balancesFailed && eleven && eleven.remaining !== null
      ? {
          ...elevenLabsRunway(eleven.remaining, costsFailed ? [] : costs),
          total: eleven.total,
          resetsAt: eleven.resets_at,
          tier: eleven.tier,
          checkedAt: eleven.checked_at,
        }
      : null;

  return (
    <div className="rhythm ns-open g5-page">
      <PageHeader icon="billing" title={t.billing.title} subtitle={t.billing.subtitle} />
      {migrationMissing && (
        <section className="panel">
          <StateBlock role="status" tone="warn" compact>
            {t.billing.migrationMissing}
          </StateBlock>
        </section>
      )}
      {(costsFailed || settingsFailed || balancesFailed || topupsFailed) && (
        <section className="panel">
          <ErrorState message={tt.billingReadFailed} />
        </section>
      )}
      {costsCut && (
        <section className="panel">
          <StateBlock role="status" tone="warn" compact>
            {fmt(tt.spendCut, { n: num(costs.length) })}
          </StateBlock>
        </section>
      )}
      {horizonCapped && (
        <section className="panel">
          <StateBlock role="status" tone="warn" compact>
            {fmt(tt.spendHorizon, { n: HORIZON_DAYS })}
          </StateBlock>
        </section>
      )}
      {costsFailed ? null : <UnitEconomicsCard ue={ue} scope={ueScope} />}
      {operatorView ? (
        <BillingBoard
          providers={views}
          runway={runway}
          githubConfigured={isGithubConfigured}
          spendUnknown={usageUnknown}
          spendNoRows={!costsFailed && costs.length === 0}
          lastSync={lastSyncMs === null ? null : ownerTime(new Date(lastSyncMs).toISOString(), locale, NOW)}
          basisDays={(() => {
            // The headline is "last 30 days" only when EVERY provider that contributes has a full window: the shortest one rules.
            const w = views.filter((v) => v.units30 !== null && v.units30 > 0).map((v) => v.windowDays ?? 30);
            return w.length ? Math.round(Math.min(...w)) : 30;
          })()}
          runwayUnknown={balancesFailed}
        />
      ) : (
        <section className="panel">
          <StateBlock role="status" tone="idle" compact>
            {t.billing.providersOperatorOnly}
          </StateBlock>
        </section>
      )}
    </div>
  );
}
