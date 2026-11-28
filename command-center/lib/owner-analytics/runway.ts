/**
 * Provider runway: per paid provider and per model, what was spent, what is left, how fast it goes and when it runs out.
 * Pure. Built on the Billing page's own ledger (lib/billing.ts providerLedger / providerSpendSince), so the hub and Billing
 * cannot show two different "spent" or "left" figures for one provider.
 *
 * What is measured and what is estimated stays visible all the way to the screen and the file:
 * - "left" is the provider's own reading (with its time) when one exists, else top-ups minus spend since the first top-up,
 *   labelled an estimate with its method; unknown when either side is unknown.
 * - Spend that has no bill is priced from a list price and is flagged an estimate; spend with no price at all is unknown.
 * - A provider whose newest job or probe was refused with error_code 'quota' is EMPTY, whatever an estimate says is left.
 * - Burn is per day over the last 24 hours and the last 7 days; "runs out" is at the 7-day pace, with the range the two paces
 *   span, and can be re-run at an expected volume the owner types (a share of the last 7 days' volume).
 */

import {
  BILLED_PROVIDERS,
  billingIdFor,
  isTracked,
  providerBurn,
  providerLedger,
  providerSpendSince,
  type BalanceRow,
  type BilledProvider,
  REFUSED_BEFORE_WORK,
  type BillingSettingsRow,
  type CostRowLite,
  type LedgerInputs,
  type ProbeRunRow,
  type ProviderLedger,
  type RegistryPrice,
  type StudioCostRow,
  type TopupRow,
} from "@/lib/billing";
import { daysLeft, runsOutAt } from "@/lib/stats";

const DAY = 86_400_000;
/** Below this many days at the 7-day pace a provider is "low". */
export const LOW_RUNWAY_DAYS = 3;

export interface ModelActivity {
  model: string;
  unit: string;
  jobs: number;
  completed: number;
  failed: number;
  quotaFailed: number;
  units: number;
  /** How many of the jobs said how much they used; fewer than `jobs` makes `units` a floor. */
  unitsCounted: number;
  firstAt: string | null;
  lastAt: string | null;
  lastStatus: string | null;
  lastErrorCode: string | null;
  /** The model's last completed job, and its last refusal for want of balance — routing failovers included (0184). */
  lastOkAt: string | null;
  lastQuotaAt: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function coerceModelActivity(data: unknown): ModelActivity[] {
  if (!Array.isArray(data)) return [];
  const out: ModelActivity[] = [];
  for (const r of data) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    const model = str(o.model);
    const jobs = num(o.jobs);
    if (!model || jobs === null) continue;
    out.push({
      model,
      unit: str(o.unit) ?? "unknown",
      jobs,
      completed: num(o.completed) ?? 0,
      failed: num(o.failed) ?? 0,
      quotaFailed: num(o.quota_failed) ?? 0,
      units: num(o.units) ?? 0,
      unitsCounted: num(o.units_counted) ?? 0,
      firstAt: str(o.first_at),
      lastAt: str(o.last_at),
      lastStatus: str(o.last_status),
      lastErrorCode: str(o.last_error_code),
      lastOkAt: str(o.last_ok_at),
      lastQuotaAt: str(o.last_quota_at),
    });
  }
  return out;
}

export interface RunwayData {
  now: number;
  sinceMs: number;
  horizonCapped: boolean;
  topups: TopupRow[];
  topupsUnread: boolean;
  balances: BalanceRow[];
  balancesUnread: boolean;
  /** Null when provider_billing_settings could not be read: pipeline spend is then unknown. */
  settings: BillingSettingsRow[] | null;
  pipelineRows: CostRowLite[];
  pipelineUnread: boolean;
  /** When the nightly mirror last wrote a pipeline cost row: pipeline spend is known only up to here. */
  lastSyncMs: number | null;
  pipelineFromMs: number | null;
  studioRows: StudioCostRow[];
  studioUnread: boolean;
  studioFromMs: number | null;
  probeRows: ProbeRunRow[];
  probesUnread: boolean;
  probesFromMs: number | null;
  registry: RegistryPrice[] | null;
  /** The job counts could not be read (a timeout, a refusal): "empty" cannot be detected. */
  activityUnread: boolean;
  /** Jobs per model since the window start, over 7 days and over 24 hours; null when 0184's function could not be read. */
  activity: { all: ModelActivity[] | null; d7: ModelActivity[] | null; d1: ModelActivity[] | null; missing: boolean };
}

export type RunwayStatus = "empty" | "low" | "ok" | "unknown";

export interface ModelRunway {
  model: string;
  unit: string | null;
  /** Jobs in the last 24 hours / 7 days (creative jobs); null when the job counts could not be read. */
  jobs1d: number | null;
  jobs7d: number | null;
  /** Units the jobs used over 7 days; null when unknown, `unitsFloor` when some job did not say. */
  units7d: number | null;
  unitsFloor: boolean;
  /** Probes (each a paid call) over 7 days. */
  probes7d: number;
  /** USD of the model's Studio cost rows and probes over 7 days; null when any is unpriced. */
  usd7d: number | null;
  usd7dPriced: number;
  usd7dEstimate: boolean;
  lastAt: string | null;
  lastStatus: string | null;
  lastErrorCode: string | null;
  lastOkAt: string | null;
  lastQuotaAt: string | null;
}

export interface ProviderRunway {
  id: string;
  name: string;
  ledger: ProviderLedger;
  /** Left in USD, the figure the runway is computed from; null when unknown. */
  leftUsd: number | null;
  /** The provider's own reading in its own unit (credits, tokens…), when it reported one. */
  leftNative: { amount: number; unit: string } | null;
  /** The runway is counted in the provider's own unit (its reading against the pipeline's use of that unit), as Billing does. */
  nativeRunway: boolean;
  /** What "runs out" divides: left and the 7-day pace, in USD or in the native unit (`nativeRunway`); null when unknown. */
  left: number | null;
  perDay7d: number | null;
  /** The same over 14 days: the owner's payment plan paces on this, a longer and steadier window than 7 days. */
  perDay14d: number | null;
  /** The 14-day pace prices some spend from a price list rather than a recorded amount. */
  perDay14dEstimate: boolean;
  /** When the provider's own reading was taken (reported balances only). */
  checkedAt: string | null;
  usd24h: number | null;
  usd7d: number | null;
  burn24h: number | null;
  burn7d: number | null;
  /** Days left at the 7-day pace; "never" when nothing is being spent; null when unknown. */
  runsOut: number | "never" | null;
  /** The days-left range the 24-hour and the 7-day pace span (low, high); null when either is unknown. */
  runsOutRange: [number | "never", number | "never"] | null;
  /** Rests on a list price or on top-ups minus spend rather than the provider's own balance. */
  estimate: boolean;
  status: RunwayStatus;
  /** The newest job or probe was refused for want of balance (error_code 'quota'), and when. */
  quotaAt: string | null;
  /** Spend was recorded before the first top-up — or the reads do not reach before it — so the balance before tracking is unknown. */
  beforeTrackingUnknown: boolean;
  /** The 24-hour or 7-day pipeline share is not known yet: the nightly mirror has not written that far. */
  pipelineStale: boolean;
  /** "Empty" could not be checked (job counts or the registry unread). */
  emptyUnchecked: boolean;
  /** The provider recharges itself (provider_billing_settings): no "low" warning. */
  autoRecharge: boolean;
  models: ModelRunway[];
}

function inputsFor(p: BilledProvider, x: RunwayData): LedgerInputs {
  const st = x.settings?.find((s) => s.provider === p.id) ?? null;
  const price = st?.usd_per_unit === null || st?.usd_per_unit === undefined ? null : Number(st.usd_per_unit);
  return {
    provider: p,
    now: x.now,
    topups: x.topups,
    topupsUnread: x.topupsUnread,
    pipelineRows: x.pipelineRows,
    pipelineUnread: x.pipelineUnread || x.settings === null,
    pipelineNoRows: !x.pipelineUnread && x.pipelineRows.length === 0,
    pipelineFromMs: x.pipelineFromMs,
    usdPerUnit: price,
    studioRows: x.studioRows,
    studioUnread: x.studioUnread,
    studioFromMs: x.studioFromMs,
    probeRows: x.probeRows,
    probesUnread: x.probesUnread,
    probesFromMs: x.probesFromMs,
    registry: x.registry,
    balances: x.balances,
    balancesUnread: x.balancesUnread,
  };
}

const later = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : Date.parse(a) >= Date.parse(b) ? a : b);

function modelsOf(p: BilledProvider, x: RunwayData): ModelRunway[] {
  const reg = x.registry ?? [];
  const mine = new Map(reg.filter((m) => m.billingId === p.id).map((m) => [m.id, m]));
  const from7 = x.now - 7 * DAY;
  const byModel = new Map<string, ModelRunway>();
  const row = (model: string): ModelRunway => {
    let r = byModel.get(model);
    if (!r) {
      r = {
        model,
        unit: null,
        jobs1d: x.activity.d1 ? 0 : null,
        jobs7d: x.activity.d7 ? 0 : null,
        units7d: x.activity.d7 ? 0 : null,
        unitsFloor: false,
        probes7d: 0,
        usd7d: 0,
        usd7dPriced: 0,
        usd7dEstimate: false,
        lastAt: null,
        lastStatus: null,
        lastErrorCode: null,
        lastOkAt: null,
        lastQuotaAt: null,
      };
      byModel.set(model, r);
    }
    return r;
  };
  for (const a of x.activity.d7 ?? []) {
    if (!mine.has(a.model)) continue;
    const r = row(a.model);
    r.jobs7d = (r.jobs7d ?? 0) + a.jobs;
    r.units7d = (r.units7d ?? 0) + a.units;
    r.unitsFloor = r.unitsFloor || a.unitsCounted < a.jobs;
    r.unit = r.unit === null || r.unit === a.unit ? a.unit : "mixed";
  }
  for (const a of x.activity.d1 ?? []) if (mine.has(a.model)) row(a.model).jobs1d = (row(a.model).jobs1d ?? 0) + a.jobs;
  for (const a of x.activity.all ?? []) {
    if (!mine.has(a.model)) continue;
    const r = row(a.model);
    if (a.lastAt && later(r.lastAt, a.lastAt) === a.lastAt) {
      r.lastAt = a.lastAt;
      r.lastStatus = a.lastStatus;
      r.lastErrorCode = a.lastErrorCode;
    }
    r.lastOkAt = later(r.lastOkAt, a.lastOkAt);
    r.lastQuotaAt = later(r.lastQuotaAt, a.lastQuotaAt);
  }
  // Studio cost rows name the vendor's model id; the registry maps it back to the registry model the jobs carry.
  const regOfVendor = (vendorModel: string | null) => reg.find((m) => m.billingId === p.id && vendorModel !== null && m.vendorModels.includes(vendorModel))?.id;
  for (const c of x.studioRows) {
    const t = Date.parse(c.recorded_at);
    if (billingIdFor(c.provider, c.vendor_model) !== p.id || !(t >= from7 && t <= x.now)) continue;
    const r = row(regOfVendor(c.vendor_model) ?? c.vendor_model ?? "unknown");
    const usd = num(c.usd_estimate);
    const model = mine.get(r.model);
    const qty = num(c.quantity);
    const priced = usd ?? (model?.usdPerUnit != null && qty !== null && model.unit === c.unit ? model.usdPerUnit * qty : null);
    r.usd7dEstimate = true; // the worker's figure and a list price are both estimates (0037 calls the column one)
    if (priced === null) r.usd7d = null;
    else {
      r.usd7dPriced += priced;
      if (r.usd7d !== null) r.usd7d += priced;
    }
  }
  for (const pr of x.probeRows) {
    const t = Date.parse(pr.created_at);
    const model = mine.get(pr.model_id);
    if (!model || !(t >= from7 && t <= x.now)) continue;
    const r = row(pr.model_id);
    r.probes7d++;
    if (later(r.lastAt, pr.created_at) === pr.created_at) {
      r.lastAt = pr.created_at;
      r.lastStatus = pr.ok ? "probe_ok" : "probe_failed";
      r.lastErrorCode = pr.ok ? null : pr.error_code;
    }
    if (pr.ok) r.lastOkAt = later(r.lastOkAt, pr.created_at);
    else if (pr.error_code === "quota") r.lastQuotaAt = later(r.lastQuotaAt, pr.created_at);
    const credits = num(pr.vendor_credits);
    // The vendor's own credits with no fixed price are unpriced, as the ledger counts them (probeUse) — not a list price.
    const usd = credits !== null ? (p.creditUsd ? credits * p.creditUsd : null) : pr.ok ? model.probeUsd : null;
    if (credits === null) r.usd7dEstimate = true;
    if (usd === null) {
      // A refused key made nothing and billed nothing; any other failure may have billed: unknown, never free.
      if (!(pr.ok === false && REFUSED_BEFORE_WORK.has(String(pr.error_code)))) r.usd7d = null;
    } else {
      r.usd7dPriced += usd;
      if (r.usd7d !== null) r.usd7d += usd;
    }
  }
  return [...byModel.values()].sort((a, b) => (b.usd7dPriced - a.usd7dPriced) || ((b.jobs7d ?? 0) - (a.jobs7d ?? 0)) || a.model.localeCompare(b.model));
}

/** Spend recorded before the first top-up, in any source: what the balance was before tracking began is unknown. */
function spentBeforeTracking(p: BilledProvider, x: RunwayData, firstTopupDay: number): boolean {
  // The reads start at the first top-up's day: whether anything was spent before it was not checked, so it is not known.
  if (x.sinceMs >= firstTopupDay) return true;
  if (x.pipelineRows.some((r) => p.usage(r) > 0 && Date.parse(r.recorded_at) < firstTopupDay)) return true;
  if (x.studioRows.some((r) => billingIdFor(r.provider, r.vendor_model) === p.id && Date.parse(r.recorded_at) < firstTopupDay)) return true;
  const mine = new Set((x.registry ?? []).filter((m) => m.billingId === p.id).map((m) => m.id));
  // A probe the vendor refused before any work (a bad key, no balance) billed nothing.
  // One list with billing.ts: a copy here missed plan_required (Lens), so a plan refusal read as spending.
  return x.probeRows.some((r) => mine.has(r.model_id) && Date.parse(r.created_at) < firstTopupDay && !(r.ok === false && REFUSED_BEFORE_WORK.has(String(r.error_code))));
}

export function providerRunways(x: RunwayData): ProviderRunway[] {
  const out: ProviderRunway[] = [];
  for (const p of BILLED_PROVIDERS) {
    const inputs = inputsFor(p, x);
    const ledger = providerLedger(inputs);
    const models = modelsOf(p, x);
    const hasTopup = ledger.bought.state === "ok";
    const hasBalance = ledger.remaining.kind === "reported";
    const spent = ledger.used.pricedUsd > 0 || ledger.used.usd === null;
    // A provider nothing touched — no top-up, no reading, no job, no spend — is not a row: thirty empty lines hide the five real ones.
    if (!hasTopup && !hasBalance && models.length === 0 && !(spent && isTracked(p) && ledger.sources.pipeline.rows + ledger.sources.studio.rows + ledger.sources.probes.rows > 0)) continue;

    const st = x.settings?.find((v) => v.provider === p.id) ?? null;
    // The pipeline's spend reaches only as far as the nightly mirror has written: a window the mirror has not covered is not
    // a measured $0 for a provider the pipeline uses.
    const pipelineUser = p.pipeline !== false && isTracked(p);
    const synced = (from: number) => !pipelineUser || (x.lastSyncMs !== null && x.lastSyncMs >= from);
    const s1 = providerSpendSince(inputs, x.now - DAY);
    const s7 = providerSpendSince(inputs, x.now - 7 * DAY);
    const s14 = providerSpendSince(inputs, x.now - 14 * DAY);
    const pipelineStale = !synced(x.now - DAY) || !synced(x.now - 7 * DAY);
    const usd24h = synced(x.now - DAY) ? s1.usd : null;
    const usd7d = synced(x.now - 7 * DAY) ? s7.usd : null;
    const burn24h = usd24h;
    const burn7d = usd7d === null ? null : usd7d / 7;
    const rem = ledger.remaining;
    const leftUsd = rem.kind === "reported" || rem.kind === "estimate" ? rem.usd : null;
    const leftNative = rem.kind === "reported" ? { amount: rem.amount, unit: rem.unit } : null;
    // ElevenLabs reports credits with no fixed dollar price: like Billing, its runway is credits left against the pipeline's
    // characters a day (one credit a character), not unknown.
    const nativeRunway = leftUsd === null && leftNative !== null && p.id === "elevenlabs" && !x.pipelineUnread && x.pipelineRows.length > 0;
    const native7 = nativeRunway ? providerBurn(p, x.pipelineRows, null, 7, x.now).unitsPerDay : null;
    const native1 = nativeRunway ? providerBurn(p, x.pipelineRows, null, 1, x.now).unitsPerDay : null;
    const left = nativeRunway ? leftNative!.amount : leftUsd;
    const perDay7d = nativeRunway ? native7 : burn7d;
    const native14 = nativeRunway ? providerBurn(p, x.pipelineRows, null, 14, x.now).unitsPerDay : null;
    // 14 days needs the reads to reach back 14 days AND a fresh mirror: a mirror last synced 10 days ago reaches back 14 days but
    // misses the last 10, and dividing that by 14 would read as a slow pace, so an overdue top-up would look like "fine".
    const reaches14 =
      !pipelineStale && synced(x.now - 14 * DAY) && [x.pipelineFromMs, x.studioFromMs, x.probesFromMs].every((f) => f === null || f <= x.now - 14 * DAY);
    const perDay14d = !reaches14 ? null : nativeRunway ? native14 : s14.usd !== null ? s14.usd / 14 : null;
    const perDay14dEstimate = !nativeRunway && s14.estimate;
    const runsOut = daysLeft(left, perDay7d);
    const r24 = daysLeft(left, nativeRunway ? native1 : burn24h);
    const rank = (v: number | "never") => (v === "never" ? Infinity : v);
    const runsOutRange: ProviderRunway["runsOutRange"] =
      runsOut === null || r24 === null ? null : rank(runsOut) <= rank(r24) ? [runsOut, r24] : [r24, runsOut];

    // EMPTY: the provider's last refusal for want of balance is newer than anything it last completed (a job, a routed
    // failover's refusal, or a probe).
    let lastQuota: string | null = null;
    let lastOk: string | null = null;
    for (const m of models) {
      lastQuota = later(lastQuota, m.lastQuotaAt);
      lastOk = later(lastOk, m.lastOkAt);
    }
    const quotaAt = lastQuota !== null && (lastOk === null || Date.parse(lastQuota) > Date.parse(lastOk)) ? lastQuota : null;
    const autoRecharge = st?.auto_recharge_on_provider ?? false;
    const lowDays = st?.low_balance_days ?? LOW_RUNWAY_DAYS;
    // Without 0184's job counts, unread counts or an unread registry, a refusal for want of balance cannot be seen.
    const emptyUnchecked = x.activityUnread || x.activity.missing || x.registry === null;
    const status: RunwayStatus = quotaAt
      ? "empty"
      : runsOut === null
        ? "unknown"
        : runsOut !== "never" && runsOut < lowDays && !autoRecharge
          ? "low"
          : emptyUnchecked
            ? "unknown" // not "ok": whether the provider already refuses for want of balance was not checked
            : "ok";

    out.push({
      id: p.id,
      name: p.name,
      ledger,
      leftUsd,
      leftNative,
      nativeRunway,
      left,
      perDay7d,
      perDay14d,
      perDay14dEstimate,
      checkedAt: rem.kind === "reported" ? rem.checkedAt : null,
      usd24h,
      usd7d,
      burn24h,
      burn7d,
      runsOut,
      runsOutRange,
      estimate: ledger.runsOutEstimate || rem.kind === "estimate" || s7.estimate,
      status,
      quotaAt,
      beforeTrackingUnknown: rem.kind === "estimate" && ledger.bought.state === "ok" && spentBeforeTracking(p, x, ledger.startMs),
      pipelineStale,
      emptyUnchecked,
      autoRecharge,
      models,
    });
  }
  const order: Record<RunwayStatus, number> = { empty: 0, low: 1, unknown: 2, ok: 3 };
  return out.sort((a, b) => order[a.status] - order[b.status] || (b.usd7d ?? -1) - (a.usd7d ?? -1) || a.name.localeCompare(b.name));
}

// runsOutAt moved to lib/stats.ts: the owner's runway slider (a client component) calls it, and importing it from here
// shipped lib/billing.ts's vendor table into that chunk. Re-exported for the server code and tests that read it here.
export { runsOutAt };
