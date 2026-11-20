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
  daysLeft,
  isTracked,
  providerLedger,
  providerSpendSince,
  type BalanceRow,
  type BilledProvider,
  type BillingSettingsRow,
  type CostRowLite,
  type LedgerInputs,
  type ProbeRunRow,
  type ProviderLedger,
  type RegistryPrice,
  type StudioCostRow,
  type TopupRow,
} from "@/lib/billing";

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
  pipelineFromMs: number | null;
  studioRows: StudioCostRow[];
  studioUnread: boolean;
  studioFromMs: number | null;
  probeRows: ProbeRunRow[];
  probesUnread: boolean;
  probesFromMs: number | null;
  registry: RegistryPrice[] | null;
  /** Jobs per model since the window start, over 7 days and over 24 hours; null when 0183's function could not be read. */
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
}

export interface ProviderRunway {
  id: string;
  name: string;
  ledger: ProviderLedger;
  /** Left in USD, the figure the runway is computed from; null when unknown. */
  leftUsd: number | null;
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
  /** Spend was recorded before the first top-up: what the balance was before tracking began is not known. */
  beforeTrackingUnknown: boolean;
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
    const credits = num(pr.vendor_credits);
    const usd = credits !== null && p.creditUsd ? credits * p.creditUsd : pr.ok ? model.probeUsd : null;
    if (credits === null) r.usd7dEstimate = true;
    if (usd === null) {
      // A refused key made nothing and billed nothing; any other failure may have billed: unknown, never free.
      if (!(pr.ok === false && ["auth", "quota", "rate_limited", "not_configured"].includes(String(pr.error_code)))) r.usd7d = null;
    } else {
      r.usd7dPriced += usd;
      if (r.usd7d !== null) r.usd7d += usd;
    }
  }
  return [...byModel.values()].sort((a, b) => (b.usd7dPriced - a.usd7dPriced) || ((b.jobs7d ?? 0) - (a.jobs7d ?? 0)) || a.model.localeCompare(b.model));
}

/** Spend recorded before the first top-up, in any source: what the balance was before tracking began is unknown. */
function spentBeforeTracking(p: BilledProvider, x: RunwayData, firstTopupDay: number): boolean {
  if (x.pipelineRows.some((r) => p.usage(r) > 0 && Date.parse(r.recorded_at) < firstTopupDay)) return true;
  if (x.studioRows.some((r) => billingIdFor(r.provider, r.vendor_model) === p.id && Date.parse(r.recorded_at) < firstTopupDay)) return true;
  const mine = new Set((x.registry ?? []).filter((m) => m.billingId === p.id).map((m) => m.id));
  return x.probeRows.some((r) => mine.has(r.model_id) && Date.parse(r.created_at) < firstTopupDay);
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

    const s1 = providerSpendSince(inputs, x.now - DAY);
    const s7 = providerSpendSince(inputs, x.now - 7 * DAY);
    const burn24h = s1.usd;
    const burn7d = s7.usd === null ? null : s7.usd / 7;
    const leftUsd = ledger.remaining.kind === "reported" || ledger.remaining.kind === "estimate" ? ledger.remaining.usd : null;
    const runsOut = daysLeft(leftUsd, burn7d);
    const r24 = daysLeft(leftUsd, burn24h);
    const rank = (v: number | "never") => (v === "never" ? Infinity : v);
    const runsOutRange: ProviderRunway["runsOutRange"] =
      runsOut === null || r24 === null ? null : rank(runsOut) <= rank(r24) ? [runsOut, r24] : [r24, runsOut];

    // EMPTY: the newest thing this provider did was refused for want of balance.
    const newest = models.reduce<ModelRunway | null>((a, m) => (m.lastAt && (!a || later(a.lastAt, m.lastAt) === m.lastAt) ? m : a), null);
    const quotaAt = newest && newest.lastErrorCode === "quota" ? newest.lastAt : null;
    const autoRecharge = x.settings?.find((st) => st.provider === p.id)?.auto_recharge_on_provider ?? false;
    const status: RunwayStatus = quotaAt
      ? "empty"
      : runsOut === null
        ? "unknown"
        : runsOut !== "never" && runsOut < LOW_RUNWAY_DAYS && !autoRecharge
          ? "low"
          : "ok";

    out.push({
      id: p.id,
      name: p.name,
      ledger,
      leftUsd,
      checkedAt: ledger.remaining.kind === "reported" ? ledger.remaining.checkedAt : null,
      usd24h: s1.usd,
      usd7d: s7.usd,
      burn24h,
      burn7d,
      runsOut,
      runsOutRange,
      estimate: ledger.runsOutEstimate || ledger.remaining.kind === "estimate" || s7.estimate,
      status,
      quotaAt,
      beforeTrackingUnknown:
        ledger.remaining.kind === "estimate" && ledger.bought.state === "ok" && spentBeforeTracking(p, x, ledger.startMs),
      autoRecharge,
      models,
    });
  }
  const order: Record<RunwayStatus, number> = { empty: 0, low: 1, unknown: 2, ok: 3 };
  return out.sort((a, b) => order[a.status] - order[b.status] || (b.usd7d ?? -1) - (a.usd7d ?? -1) || a.name.localeCompare(b.name));
}

/** Days left at an expected volume: `share` of the last 7 days' daily spend (1 = the same, 2 = twice as much). */
export function runsOutAt(leftUsd: number | null, burn7d: number | null, share: number): number | "never" | null {
  if (burn7d === null || !(share >= 0)) return null;
  return daysLeft(leftUsd, burn7d * share);
}
