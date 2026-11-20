/**
 * Billing derivations — what each paid provider has left, how fast it is being
 * spent, and when it runs out.
 *
 * Inputs are plain rows the Billing page reads from Supabase:
 *   - `video_costs`               (what the pipeline consumed, migration 0002)
 *   - `creative_job_costs`        (what Studio jobs consumed at the provider, 0037)
 *   - `model_probe_runs`          (the probes of tools/probe_models.py; the vendor's own bill since 0152)
 *   - `model_registry_admin()`    (the registry's list prices, to estimate what has no bill, 0035)
 *   - `provider_balances`         (what a provider's own API says is left, 0012)
 *   - `provider_billing_settings` (operator's price per unit + flags, 0012)
 *   - `provider_topups`           (top-ups confirmed after the provider's checkout, 0012)
 *
 * The project's rule holds here too: **null is not zero.** A USD figure exists
 * only when the operator set a price for that provider; a balance exists only
 * when the provider reported one or the operator logged a top-up. Otherwise the
 * value is null and the page says "unknown" — never an invented number.
 *
 * Pure functions, unit-tested in tests/billing.test.ts.
 */

export interface CostRowLite {
  unit: string;
  quantity: number;
  stage: string | null;
  recorded_at: string;
  video_id?: string | null;
  slug?: string | null;
}

export interface BalanceRow {
  provider: string;
  metric: string;
  remaining: number | null;
  total: number | null;
  unit: string;
  tier: string | null;
  resets_at: string | null;
  source: string;
  checked_at: string;
}

export interface BillingSettingsRow {
  provider: string;
  usd_per_unit: number | null;
  include_in_bulk: boolean;
  card_saved_on_provider: boolean;
  auto_recharge_on_provider: boolean;
  low_balance_days: number;
}

export interface TopupRow {
  provider: string;
  amount_usd: number;
  paid_at: string;
}

/** A paid provider as the Billing page sees it. */
export interface BilledProvider {
  id: string;
  name: string;
  /**
   * The provider's own billing / top-up page — the card is entered there. Null when no page was verified in the vendor's own
   * documentation: the row then shows no link rather than a guessed one.
   */
  billingUrl: string | null;
  /** Human label for one priced unit, e.g. "1M tokens", "1K credits", "clip". */
  unitLabel: string;
  /** How many native units one priced unit is (1e6 tokens, 1000 credits, 1 clip). */
  unitSize: number;
  /** Native units this ledger row consumed on this provider (0 when unrelated). */
  usage: (row: CostRowLite) => number;
  /**
   * False when nothing in the cost ledger maps to this provider (Anthropic and OpenAI spend is not written to
   * `video_costs`). Its burn is then UNKNOWN, not zero: "0 used, lasts never" would be a lie.
   */
  tracked?: boolean;
  /**
   * False when the YouTube pipeline never calls this vendor (it is used by Studio and the probes only). Its pipeline spend is
   * then a true "not used by the pipeline", which is not the same as "not recorded" (`tracked: false`).
   */
  pipeline?: boolean;
  /**
   * USD per vendor credit, for a vendor that sells prepaid credits at one fixed price, copied from its own pricing page. Only
   * set where that page was read; everywhere else credits are not converted to dollars.
   */
  creditUsd?: number;
}

/** Does the cost ledger carry this provider's usage at all? */
export const isTracked = (p: BilledProvider): boolean => p.tracked !== false;

const clipsOf = (id: string) => (r: CostRowLite) =>
  r.unit === "video_gen_clips" && r.stage === `broll:${id}` ? r.quantity : 0;
const imagesOf = (id: string) => (r: CostRowLite) =>
  r.unit === "image_generations" && r.stage === `image:${id}` ? r.quantity : 0;
const none = () => 0;

/**
 * Every vendor of schemas/model_registry.json, mapped to the Billing row its bill lands on (tests/billing.test.ts compares the
 * keys with the file, so a vendor added to the registry without a row here fails the build). The registry names Google
 * "google", ByteDance "bytedance" and Alibaba "alibaba" (lib/model-keys.ts uses the same ids); their bills already had rows
 * here as Gemini/Veo, Seedance and Wan, so they land there. `unassigned-video-vendor` is the registry's placeholder for the
 * generic video ops, not a vendor, and has no row.
 */
export const REGISTRY_BILLING: Readonly<Record<string, string>> = Object.freeze({
  alibaba: "wan",
  assemblyai: "assemblyai",
  bfl: "bfl",
  bytedance: "seedance",
  elevenlabs: "elevenlabs",
  google: "gemini",
  ideogram: "ideogram",
  kling: "kling",
  krea: "krea",
  lightricks: "lightricks",
  luma: "luma",
  meta: "meta",
  minimax: "minimax",
  openai: "openai",
  pika: "pika",
  recraft: "recraft",
  runway: "runway",
  sonilo: "sonilo",
  vidu: "vidu",
  xai: "xai",
});

/**
 * The Billing row a registry vendor's spend lands on, or null for a vendor with none. Google bills Veo and Gemini through
 * the same account but the page has kept them apart (a clip and a million tokens are not one unit): a Veo model is told
 * apart by its vendor model id ("veo-3.1-generate-preview").
 */
export function billingIdFor(registryProvider: string | null | undefined, vendorModel?: string | null): string | null {
  const p = String(registryProvider ?? "").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(REGISTRY_BILLING, p)) return null;
  if (p === "google" && /^veo[-_.]/i.test(String(vendorModel ?? ""))) return "veo";
  return REGISTRY_BILLING[p];
}

interface VendorMeta {
  name: string;
  /** Verified in the vendor's own docs (the URL in the comment beside it), or null. */
  billingUrl: string | null;
  /** The pipeline's own `image:<id>` stage for this vendor, when the pipeline can generate stills with it. */
  pipelineImage?: string;
  creditUsd?: number;
}

/**
 * The registry vendors that had no Billing row before Studio and the probes were counted. Names as lib/model-keys.ts gives
 * them. A billing URL is set only where the vendor's documentation names that page as where credits are bought or the
 * balance is read (curl of the docs, 2026-11-13); every other one is null, never a guess.
 */
const REGISTRY_VENDORS: Readonly<Record<string, VendorMeta>> = {
  assemblyai: {
    name: "AssemblyAI",
    // "Monitor your balance on the Billing page ... in the dashboard" (assemblyai.com/docs/billing-and-pricing).
    billingUrl: "https://www.assemblyai.com/dashboard/home",
  },
  bfl: {
    name: "Black Forest Labs (FLUX)",
    // "Go to dashboard.bfl.ai and sign in ... Navigate to Credits" (docs.bfl.ml/account_management/credits_billing).
    billingUrl: "https://dashboard.bfl.ai",
    pipelineImage: "flux",
  },
  ideogram: { name: "Ideogram", billingUrl: null, pipelineImage: "ideogram" },
  krea: {
    name: "Krea",
    // "Add funds at krea.ai/app/api/" (krea.ai/docs/developers/api-keys-and-billing).
    billingUrl: "https://krea.ai/app/api/",
  },
  lightricks: {
    name: "Lightricks (LTX)",
    // Auto top-up and the usage page live in the Developer Console (docs.ltx.io/auto-top-up).
    billingUrl: "https://console.ltx.io",
  },
  luma: { name: "Luma (Ray)", billingUrl: null },
  meta: { name: "Meta (Model API)", billingUrl: null },
  pika: { name: "Pika", billingUrl: null },
  recraft: { name: "Recraft", billingUrl: null },
  runway: {
    name: "Runway",
    // "Credits can be purchased for $0.01 per credit in the developer portal" (docs.dev.runwayml.com/guides/pricing, read
    // 2026-11-13), whose "Create an account" link is dev.runway.com.
    billingUrl: "https://dev.runway.com/",
    creditUsd: 0.01,
  },
  sonilo: { name: "Sonilo (music)", billingUrl: null },
  vidu: { name: "Vidu", billingUrl: null },
  xai: { name: "xAI (Grok)", billingUrl: null },
};

/** Rows for the registry vendors that the hand-written list above does not already bill, in the registry's id order. */
function registryRows(): BilledProvider[] {
  const taken = new Set(["elevenlabs", "gemini", "minimax", "kling", "veo", "seedance", "wan", "higgsfield", "leonardo", "anthropic", "openai"]);
  const out: BilledProvider[] = [];
  for (const vendor of Object.keys(REGISTRY_BILLING).sort()) {
    const id = REGISTRY_BILLING[vendor];
    if (taken.has(id)) continue;
    taken.add(id);
    const meta = REGISTRY_VENDORS[vendor] ?? { name: vendor, billingUrl: null };
    const stage = meta.pipelineImage;
    out.push({
      id,
      name: meta.name,
      billingUrl: meta.billingUrl,
      unitLabel: stage ? "image" : meta.creditUsd ? "1K credits" : "unit",
      unitSize: !stage && meta.creditUsd ? 1000 : 1,
      usage: stage ? imagesOf(stage) : none,
      pipeline: Boolean(stage),
      ...(meta.creditUsd ? { creditUsd: meta.creditUsd } : {}),
    });
  }
  return out;
}

/**
 * Every provider that bills money. Pexels (free) and Edge TTS (free) are not
 * here. ElevenLabs usage is the TTS character count — multilingual_v2 bills one
 * credit per character.
 */
export const BILLED_PROVIDERS: BilledProvider[] = [
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    billingUrl: "https://elevenlabs.io/app/subscription",
    unitLabel: "1K credits",
    unitSize: 1000,
    usage: (r) => (r.unit === "tts_characters" ? r.quantity : 0),
  },
  {
    id: "gemini",
    name: "Google Gemini",
    billingUrl: "https://console.cloud.google.com/billing",
    unitLabel: "1M tokens",
    unitSize: 1_000_000,
    usage: (r) =>
      r.unit === "gemini_input_tokens" || r.unit === "gemini_output_tokens" ? r.quantity : 0,
  },
  { id: "minimax", name: "MiniMax", billingUrl: "https://www.minimax.io/platform", unitLabel: "clip", unitSize: 1, usage: clipsOf("minimax") },
  { id: "kling", name: "Kling", billingUrl: "https://kling.ai/dev", unitLabel: "clip", unitSize: 1, usage: clipsOf("kling") },
  { id: "veo", name: "Google Veo", billingUrl: "https://console.cloud.google.com/billing", unitLabel: "clip", unitSize: 1, usage: clipsOf("veo") },
  { id: "seedance", name: "Seedance", billingUrl: "https://console.volcengine.com/finance", unitLabel: "clip", unitSize: 1, usage: clipsOf("seedance") },
  { id: "wan", name: "Wan", billingUrl: "https://usercenter2-intl.aliyun.com/billing", unitLabel: "clip", unitSize: 1, usage: clipsOf("wan") },
  { id: "higgsfield", name: "Higgsfield", billingUrl: "https://higgsfield.ai/pricing", unitLabel: "clip", unitSize: 1, usage: clipsOf("higgsfield") },
  { id: "leonardo", name: "Leonardo.Ai", billingUrl: "https://app.leonardo.ai/api-access", unitLabel: "image", unitSize: 1, usage: imagesOf("leonardo") },
  { id: "anthropic", name: "Anthropic Claude", billingUrl: "https://console.anthropic.com/settings/billing", unitLabel: "1M tokens", unitSize: 1_000_000, usage: none, tracked: false },
  { id: "openai", name: "OpenAI", billingUrl: "https://platform.openai.com/settings/organization/billing/overview", unitLabel: "1M tokens", unitSize: 1_000_000, usage: none, tracked: false },
  ...registryRows(),
];

export const BILLED_PROVIDER_IDS: readonly string[] = BILLED_PROVIDERS.map((p) => p.id);

const DAY_MS = 86_400_000;

function finite(n: unknown): number | null {
  const v = typeof n === "string" ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Linear-interpolated percentile of `values` (0..1), or null for none. */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const idx = Math.min(1, Math.max(0, p)) * (xs.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
}

export interface Burn {
  /** Native units consumed in the window. */
  units: number;
  unitsPerDay: number;
  /** USD per day — null when there was usage but no price is set. */
  usdPerDay: number | null;
  /** The number of days the per-day figures are averaged over (the window, shortened to the history there is). */
  windowDays: number;
}

/** A stored stamp in ms. The bot writes UTC with no zone; a bare stamp is read as UTC, never as the server's local time. */
export function rowMs(recordedAt: string | null | undefined): number {
  const text = String(recordedAt ?? "");
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) || !text.includes("T") ? text : `${text}Z`);
}

/** The oldest `recorded_at` among the rows, in ms, or null. */
export function oldestRowMs(rows: { recorded_at: string }[]): number | null {
  let oldest: number | null = null;
  for (const r of rows) {
    const t = rowMs(r.recorded_at);
    if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
  }
  return oldest;
}

/** When THIS provider was first used: the oldest ledger row that consumed something on it, in ms, or null. */
export function firstUseMs(provider: BilledProvider, rows: CostRowLite[]): number | null {
  let first: number | null = null;
  for (const r of rows) {
    if (!(provider.usage(r) > 0)) continue;
    const t = rowMs(r.recorded_at);
    if (Number.isFinite(t) && (first === null || t < first)) first = t;
  }
  return first;
}

/**
 * Where this provider's own history starts, for the burn window: its first usage row, or its first top-up when that
 * came later (spend before the account was funded is not what the balance is spent at). Null with neither.
 */
export function providerHistoryStart(firstUse: number | null, firstTopup: number | null): number | null {
  if (firstUse !== null && firstTopup !== null) return Math.max(firstUse, firstTopup);
  return firstUse ?? firstTopup;
}

/**
 * How fast `provider` is being consumed over the last `days` days, or over ITS OWN history when that is shorter
 * (`startMs`, from providerHistoryStart): a provider first used two days ago is divided by two, not by thirty (and not by
 * the age of the whole ledger, which is older than the provider). One `now` for the whole computation: the window edge is
 * the start itself, so the row that started the history is never a few milliseconds outside it.
 */
export function providerBurn(
  provider: BilledProvider,
  rows: CostRowLite[],
  usdPerUnit: number | null,
  days = 30,
  now: number = Date.now(),
  startMs: number | null = null,
): Burn {
  const full = now - days * DAY_MS;
  const since = startMs !== null && Number.isFinite(startMs) && startMs > full ? startMs : full;
  const windowDays = Math.max(1, (now - since) / DAY_MS);
  let units = 0;
  for (const r of rows) {
    const t = rowMs(r.recorded_at);
    if (!Number.isFinite(t) || t < since || t > now) continue;
    const q = provider.usage(r);
    if (q > 0) units += q;
  }
  const unitsPerDay = units / windowDays;
  const rate = finite(usdPerUnit);
  const usdPerDay = units === 0 ? 0 : rate === null ? null : (unitsPerDay / provider.unitSize) * rate;
  return { units, unitsPerDay, usdPerDay, windowDays };
}

/** The newest balance snapshot for a provider, or null. */
export function latestBalance(rows: BalanceRow[], provider: string): BalanceRow | null {
  let best: BalanceRow | null = null;
  for (const r of rows) {
    if (r.provider !== provider) continue;
    if (!best || Date.parse(r.checked_at) > Date.parse(best.checked_at)) best = r;
  }
  return best;
}

/**
 * The operator's own running balance for a provider with no balance API:
 * everything topped up, minus priced spend since the first top-up. Null when
 * there is no top-up, when there was spend since then with no price set, when
 * the spend history does not reach back to the first top-up (`coveredFromMs`:
 * the oldest ledger row the page actually read; spend before it is missing and
 * the balance would be overstated), and when the result is NEGATIVE (the
 * top-ups logged do not cover the spend: a trial credit, an auto-recharge or a
 * top-up that was never logged, so the true balance is not known).
 */
export function ledgerBalanceUsd(
  provider: BilledProvider,
  topups: TopupRow[],
  rows: CostRowLite[],
  usdPerUnit: number | null,
  coveredFromMs: number | null = null,
): number | null {
  if (!isTracked(provider)) return null;
  const mine = topups.filter((t) => t.provider === provider.id && finite(t.amount_usd) !== null);
  if (mine.length === 0) return null;
  const first = Math.min(...mine.map((t) => Date.parse(t.paid_at)).filter(Number.isFinite));
  if (coveredFromMs !== null && Number.isFinite(first) && first < coveredFromMs) return null;
  const paid = mine.reduce((s, t) => s + Number(t.amount_usd), 0);
  let units = 0;
  for (const r of rows) {
    const t = rowMs(r.recorded_at);
    if (Number.isFinite(t) && t >= first) units += provider.usage(r);
  }
  if (units === 0) return paid;
  const rate = finite(usdPerUnit);
  if (rate === null) return null;
  const left = paid - (units / provider.unitSize) * rate;
  return left < 0 ? null : left;
}

/**
 * Days until a balance is spent at the current burn. `"never"` when nothing is
 * being consumed; null when either side is unknown.
 */
export function daysLeft(balance: number | null, perDay: number | null): number | "never" | null {
  if (balance === null || perDay === null) return null;
  // A negative balance is not "0 days left": the books do not add up (see ledgerBalanceUsd), so it is unknown.
  if (balance < 0) return null;
  if (perDay <= 0) return "never";
  return balance / perDay;
}

export interface ElevenLabsRunway {
  remainingCredits: number;
  /** Conservative minutes of narration the remaining credits cover. */
  minMinutes: number;
  /** Conservative number of videos, from this project's own per-video usage (p75). Null without history. */
  minVideos: number | null;
  /** Characters a typical (p75) video used, or null without history. */
  perVideoChars: number | null;
}

/**
 * How much narration ElevenLabs' remaining credits still buy.
 *
 * Minutes use a deliberately high speech density (1000 characters per minute;
 * natural narration is ~850-950) so the figure is a floor, not a promise.
 * Videos use the 75th percentile of what this project's own videos actually
 * consumed — so a long-form channel sees fewer, a Shorts channel more.
 */
export function elevenLabsRunway(
  remainingCredits: number,
  rows: CostRowLite[],
  opts: { charsPerMinute?: number; creditsPerChar?: number } = {},
): ElevenLabsRunway {
  const cpm = opts.charsPerMinute ?? 1000;
  const cpc = opts.creditsPerChar ?? 1;
  const remaining = Math.max(0, remainingCredits);
  const minMinutes = Math.floor(remaining / (cpm * cpc));

  // Per-video TTS characters — summed per video (a run can synthesize in parts).
  const perVideo = new Map<string, number>();
  for (const r of rows) {
    if (r.unit !== "tts_characters" || !(r.quantity > 0)) continue;
    const key = r.video_id || r.slug || r.recorded_at;
    perVideo.set(key, (perVideo.get(key) ?? 0) + r.quantity);
  }
  const p75 = percentile([...perVideo.values()], 0.75);
  const perVideoChars = p75 === null ? null : Math.round(p75);
  const minVideos = perVideoChars && perVideoChars > 0 ? Math.floor(remaining / (perVideoChars * cpc)) : null;
  return { remainingCredits: remaining, minMinutes, minVideos, perVideoChars };
}

export interface TopupPlanInput {
  id: string;
  /** USD burned per day, or null when used but unpriced. */
  usdPerDay: number | null;
  /** Current balance in USD, or null when unknown (treated as empty — the plan errs toward enough). */
  balanceUsd: number | null;
}

export interface TopupPlanLine {
  id: string;
  /** USD needed to cover `days` at the current burn, or null when unpriced. */
  need: number | null;
  /** USD to pay now, or null when unpriced (excluded from the total). */
  amount: number | null;
  /** The balance was unknown, so the need assumes an empty account. */
  balanceUnknown: boolean;
}

export interface TopupPlan {
  lines: TopupPlanLine[];
  /** Exactly the sum of the line amounts — what the operator will be charged in total. */
  total: number;
  /** The cap was lower than the need, so amounts were split proportionally. */
  scaled: boolean;
}

const cents = (v: number) => Math.round(v * 100);

/**
 * Split `totalCents` across `weights` proportionally, in whole cents, so the
 * parts add up to exactly the total (largest-remainder rounding).
 */
export function splitCents(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  const ws = sum > 0 ? weights.map((w) => Math.max(0, w)) : weights.map(() => 1);
  const wsum = ws.reduce((s, w) => s + w, 0);
  if (wsum === 0 || totalCents <= 0) return weights.map(() => 0);
  const raw = ws.map((w) => (totalCents * w) / wsum);
  const floors = raw.map(Math.floor);
  let rest = totalCents - floors.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) floors[order[k][1]] += 1;
  return floors;
}

/**
 * Plan a prepayment across the selected providers.
 *
 * need_i = max(0, burn_i × days − balance_i). With no cap every provider gets
 * its need (rounded up to the cent). With a cap below the total need, the cap
 * is split in proportion to each provider's need, to the cent, summing to the
 * cap exactly. Unpriced providers get no amount — the page asks for a price.
 */
export function planTopups(inputs: TopupPlanInput[], days: number, cap: number | null = null): TopupPlan {
  const lines: TopupPlanLine[] = inputs.map((p) => {
    if (p.usdPerDay === null) return { id: p.id, need: null, amount: null, balanceUnknown: p.balanceUsd === null };
    const need = Math.max(0, p.usdPerDay * Math.max(0, days) - (p.balanceUsd ?? 0));
    return { id: p.id, need, amount: Math.max(0, Math.ceil(need * 100 - 1e-9)) / 100, balanceUnknown: p.balanceUsd === null };
  });
  const priced = lines.filter((l) => l.need !== null);
  const needCents = priced.reduce((s, l) => s + (l.amount ?? 0) * 100, 0);
  let scaled = false;
  if (cap !== null && Number.isFinite(cap) && cap >= 0 && priced.length > 0 && cents(cap) < Math.round(needCents)) {
    scaled = true;
    const parts = splitCents(cents(cap), priced.map((l) => l.need ?? 0));
    priced.forEach((l, i) => (l.amount = parts[i] / 100));
  }
  const total = Math.round(priced.reduce((s, l) => s + (l.amount ?? 0) * 100, 0)) / 100;
  return { lines, total, scaled };
}

// ── The owner's ledger per provider: what was bought, what was used (pipeline / Studio / probes), what is left ──────────

/** One Studio provider charge (creative_job_costs, 0037). `usd_estimate` is NULL unless the worker had a price. */
export interface StudioCostRow {
  provider: string;
  vendor_model: string | null;
  unit: string | null;
  quantity: number | string | null;
  usd_estimate: number | string | null;
  recorded_at: string;
}

/** One probe call (model_probe_runs, 0035). `vendor_credits` exists from 0152 on; absent or NULL = the vendor said nothing. */
export interface ProbeRunRow {
  model_id: string;
  ok: boolean;
  error_code: string | null;
  created_at: string;
  vendor_credits?: number | string | null;
}

/** What the registry says one model costs, reduced to what the ledger needs (see registryPrices). */
export interface RegistryPrice {
  id: string;
  /** The Billing row this model's spend lands on, or null. */
  billingId: string | null;
  vendorModels: string[];
  /** The registry's priced unit ("second", "image", "character", "request"...), or null. */
  unit: string | null;
  /** USD per unit for ANY call of the model: null when the registry has no price or the price depends on an option a cost row does not carry. */
  usdPerUnit: number | null;
  /** USD of one probe call, from the registry's price for the probe's own options times its length, or null. */
  probeUsd: number | null;
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const positive = (v: unknown): number | null => {
  const n = typeof v === "boolean" ? null : finite(v);
  return n !== null && n >= 0 ? n : null;
};

/**
 * The registry rows (model_registry_admin(): id, provider, spec) as prices. A variant price (by resolution, quality...) is used
 * for a probe only, whose options the registry states; a Studio cost row does not say which variant ran, so a model whose
 * variants differ has no single Studio price (null), never the cheapest one.
 */
export function registryPrices(rows: readonly unknown[]): RegistryPrice[] {
  const out: RegistryPrice[] = [];
  for (const raw of rows) {
    const r = asObject(raw);
    if (!r || typeof r.id !== "string") continue;
    const spec = asObject(r.spec) ?? {};
    const pricing = asObject(spec.pricing) ?? {};
    const probe = asObject(spec.probe) ?? {};
    const vendorModel = typeof spec.vendor_model === "string" ? spec.vendor_model : null;
    const byCap = asObject(spec.vendor_model_by_capability) ?? {};
    const vendorModels = [vendorModel, ...Object.values(byCap)].filter((v): v is string => typeof v === "string" && v !== "");
    const unit = typeof pricing.unit === "string" ? pricing.unit : null;
    const base = positive(pricing.provider_usd_per_unit);
    const variants = asObject(pricing.variants);
    const prices = asObject(variants?.prices);
    const variantValues = prices ? Object.values(prices).map(positive) : [];
    const oneVariantPrice = variantValues.length > 0 && variantValues.every((v) => v !== null && v === variantValues[0]);
    const usdPerUnit = !prices ? base : oneVariantPrice ? variantValues[0] : null;
    let probeUnitUsd = usdPerUnit;
    if (prices && typeof variants?.by === "string") {
      const chosen = probe[variants.by];
      probeUnitUsd = typeof chosen === "string" && Object.prototype.hasOwnProperty.call(prices, chosen) ? positive(prices[chosen]) : null;
    }
    const qty =
      unit === "second"
        ? positive(probe.duration_s)
        : unit === "image" || unit === "request"
          ? 1
          : unit === "character" && typeof probe.prompt === "string"
            ? probe.prompt.length
            : null;
    out.push({
      id: r.id,
      billingId: billingIdFor(typeof r.provider === "string" ? r.provider : null, vendorModel),
      vendorModels,
      unit,
      usdPerUnit,
      probeUsd: probeUnitUsd !== null && qty !== null && qty > 0 ? probeUnitUsd * qty : null,
    });
  }
  return out;
}

/** Where one source's figure came from, or why there is none. */
export type SourceState =
  /** Read, and every row in the window counted. */
  | "ok"
  /** The read failed (or the table / function is not there): unknown, never 0. */
  | "unread"
  /** The read stopped before the start of the window: what was read is a floor. */
  | "partial"
  /** This spend is not written anywhere (the Anthropic / OpenAI tokens of the pipeline). */
  | "untracked"
  /** The pipeline never calls this vendor: a true zero. */
  | "not_used"
  /**
   * The pipeline ledger read worked and holds no row at all: the nightly mirror may not have written yet, so nothing was
   * measured. Unknown ("no rows yet"), never a measured zero (the page's headline says the same).
   */
  | "no_rows";

export interface UnpricedPart {
  unit: string;
  /** Null when some row did not say how much either. */
  quantity: number | null;
  rows: number;
}

export interface SourceUse {
  state: SourceState;
  /** Rows (cost lines, probe calls) counted in the window. */
  rows: number;
  /** USD of everything counted, when every part has a price; null otherwise. */
  usd: number | null;
  /** USD of the parts that have a price: the whole when `usd` is set, a floor when it is not. */
  pricedUsd: number;
  /** Some of the USD is a list price (the registry's, or the worker's estimate), not a bill the vendor reported. */
  estimate: boolean;
  /** What has no price, by unit: the page shows it as "USD unknown" next to the quantity. */
  unpriced: UnpricedPart[];
  /** Probes that failed in a way the vendor may still have billed (a timeout, an outage, a bad answer after the task ran). */
  billingUnknown: number;
}

export interface LedgerInputs {
  provider: BilledProvider;
  now: number;
  topups: TopupRow[];
  topupsUnread: boolean;
  /** Pipeline cost rows (video_costs), already read. */
  pipelineRows: CostRowLite[];
  pipelineUnread: boolean;
  /** The whole pipeline ledger read came back empty (see SourceState "no_rows"). */
  pipelineNoRows: boolean;
  /** The pipeline rows reach back to here; spend before it was not read. Null = as far back as needed. */
  pipelineFromMs: number | null;
  /** The operator's price per `unitLabel` (provider_billing_settings), or null. */
  usdPerUnit: number | null;
  studioRows: StudioCostRow[];
  studioUnread: boolean;
  studioFromMs: number | null;
  probeRows: ProbeRunRow[];
  probesUnread: boolean;
  probesFromMs: number | null;
  /** The registry as prices; null when it could not be read (probes cannot be attributed, Studio not estimated). */
  registry: RegistryPrice[] | null;
  balances: BalanceRow[];
  balancesUnread: boolean;
}

export type Remaining =
  | { kind: "reported"; amount: number; unit: string; checkedAt: string; usd: number | null }
  | { kind: "estimate"; usd: number; credits: number | null }
  | { kind: "unknown"; why: "unread" | "no_topup" | "negative" | UsedUnknownWhy };

/** Why "used" is unknown, so "left" can say it: the first cause found, in this order. */
export type UsedUnknownWhy =
  | "used_unread"
  | "used_partial"
  | "used_untracked"
  | "used_no_rows"
  | "used_unpriced"
  | "used_may_have_billed";

/** The cause that keeps the sum of these sources unknown, or null when it is known. */
export function usedUnknownWhy(sources: readonly SourceUse[]): UsedUnknownWhy | null {
  if (sources.every((s) => s.usd !== null)) return null;
  if (sources.some((s) => s.state === "unread")) return "used_unread";
  if (sources.some((s) => s.state === "partial")) return "used_partial";
  if (sources.some((s) => s.state === "untracked")) return "used_untracked";
  if (sources.some((s) => s.state === "no_rows")) return "used_no_rows";
  if (sources.some((s) => s.unpriced.length > 0)) return "used_unpriced";
  return "used_may_have_billed";
}

export type Bought =
  | { state: "ok"; usd: number; credits: number | null; count: number; firstMs: number }
  | { state: "none" }
  | { state: "unread" };

export interface UsedTotal {
  /** All three sources in USD, or null when any is unknown, partial or unpriced. */
  usd: number | null;
  /** The priced parts only: a floor when `usd` is null. */
  pricedUsd: number;
  estimate: boolean;
  /** The vendor's credits for `usd`, for a vendor that sells them at a fixed price. */
  credits: number | null;
}

export interface ProviderLedger {
  id: string;
  /** Where "used" starts: the UTC day of the first top-up recorded, or 30 days back when none is. */
  startMs: number;
  sinceTopup: boolean;
  bought: Bought;
  sources: { pipeline: SourceUse; studio: SourceUse; probes: SourceUse };
  used: UsedTotal;
  remaining: Remaining;
  /** USD per day over the last 30 days of the window (all three sources), or null when unknown. */
  usdPerDay: number | null;
  /** daysLeft() of the remaining USD at that pace: a number, "never" when nothing is being spent, null when unknown. */
  runsOut: number | "never" | null;
  /** `runsOut` rests on an estimate (a list price, or bought minus used rather than the provider's own balance). */
  runsOutEstimate: boolean;
}

/** Probe failures where the vendor refused the key or the account before any work: nothing was made, nothing billed. */
// plan_required (0190): the account's plan refused the request outright, like an empty balance; nothing was made.
export const REFUSED_BEFORE_WORK: ReadonlySet<string> = new Set(["auth", "quota", "rate_limited", "not_configured", "plan_required"]);

export const utcDayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

type Part = { usd: number | null; estimate: boolean; unit: string; quantity: number | null };

function emptySource(state: SourceState): SourceUse {
  return { state, rows: 0, usd: state === "not_used" ? 0 : null, pricedUsd: 0, estimate: false, unpriced: [], billingUnknown: 0 };
}

/** Sums priced and unpriced parts into one SourceUse. No part at all is a measured zero (the read worked and found none). */
function sumParts(parts: Part[], billingUnknown = 0): SourceUse {
  let priced = 0;
  let estimate = false;
  const unpriced = new Map<string, UnpricedPart>();
  for (const p of parts) {
    if (p.usd !== null) {
      priced += p.usd;
      estimate = estimate || p.estimate;
      continue;
    }
    const u = unpriced.get(p.unit) ?? { unit: p.unit, quantity: 0, rows: 0 };
    u.quantity = u.quantity === null || p.quantity === null ? null : u.quantity + p.quantity;
    u.rows += 1;
    unpriced.set(p.unit, u);
  }
  const whole = unpriced.size === 0 && billingUnknown === 0;
  return {
    state: "ok",
    rows: parts.length + billingUnknown,
    usd: whole ? priced : null,
    pricedUsd: priced,
    estimate,
    unpriced: [...unpriced.values()],
    billingUnknown,
  };
}

/** A read that does not reach back to the start of the window is a floor, never the whole. */
const cutAt = (use: SourceUse, fromMs: number | null, start: number): SourceUse =>
  fromMs !== null && fromMs > start ? { ...use, state: "partial", usd: null } : use;

const inWindow = (ms: number, start: number, now: number) => Number.isFinite(ms) && ms >= start && ms <= now;

function pipelineUse(x: LedgerInputs, start: number): SourceUse {
  const p = x.provider;
  if (p.pipeline === false) return emptySource("not_used");
  if (!isTracked(p)) return emptySource("untracked");
  if (x.pipelineUnread) return emptySource("unread");
  if (x.pipelineNoRows) return emptySource("no_rows");
  let units = 0;
  let rows = 0;
  let unit = "";
  for (const r of x.pipelineRows) {
    const q = p.usage(r);
    if (!(q > 0) || !inWindow(rowMs(r.recorded_at), start, x.now)) continue;
    units += q;
    rows += 1;
    unit = unit || r.unit;
  }
  const rate = finite(x.usdPerUnit);
  const use = rows === 0 ? sumParts([]) : { ...sumParts([{ usd: rate === null ? null : (units / p.unitSize) * rate, estimate: false, unit, quantity: units }]), rows };
  return cutAt(use, x.pipelineFromMs, start);
}

function studioUse(x: LedgerInputs, start: number): SourceUse {
  if (x.studioUnread) return emptySource("unread");
  const parts: Part[] = [];
  for (const r of x.studioRows) {
    if (billingIdFor(r.provider, r.vendor_model) !== x.provider.id || !inWindow(rowMs(r.recorded_at), start, x.now)) continue;
    const qty = positive(r.quantity);
    const unit = r.unit || "unit";
    const recorded = positive(r.usd_estimate);
    if (recorded !== null) {
      // The worker's own figure; 0037 calls the column an estimate and so does the page.
      parts.push({ usd: recorded, estimate: true, unit, quantity: qty });
      continue;
    }
    const model = x.registry?.find(
      (m) => m.billingId === x.provider.id && m.unit === r.unit && r.vendor_model !== null && m.vendorModels.includes(r.vendor_model),
    );
    const rate = model?.usdPerUnit ?? null;
    parts.push({ usd: rate !== null && qty !== null ? rate * qty : null, estimate: true, unit, quantity: qty });
  }
  return cutAt(sumParts(parts), x.studioFromMs, start);
}

function probeUse(x: LedgerInputs, start: number): SourceUse {
  if (x.probesUnread || x.registry === null) return emptySource("unread");
  const byId = new Map(x.registry.map((m) => [m.id, m]));
  const credit = x.provider.creditUsd ?? null;
  const parts: Part[] = [];
  let billingUnknown = 0;
  for (const r of x.probeRows) {
    const model = byId.get(r.model_id);
    if (!model || model.billingId !== x.provider.id || !inWindow(rowMs(r.created_at), start, x.now)) continue;
    const reported = positive(r.vendor_credits);
    if (reported !== null) {
      // The vendor's own bill for the task (0152): measured, not estimated. Without a fixed credit price it stays in credits.
      parts.push({ usd: credit !== null ? reported * credit : null, estimate: false, unit: "credits", quantity: reported });
      continue;
    }
    if (!r.ok) {
      // A refused key or account made nothing; any other failure may have run (and billed) at the vendor: unknown, not free.
      if (!REFUSED_BEFORE_WORK.has(String(r.error_code ?? ""))) billingUnknown += 1;
      continue;
    }
    parts.push({ usd: model.probeUsd, estimate: true, unit: "probe", quantity: 1 });
  }
  return cutAt(sumParts(parts, billingUnknown), x.probesFromMs, start);
}

function usedOf(sources: SourceUse[], creditUsd: number | undefined): UsedTotal {
  const usd = sources.every((s) => s.usd !== null) ? sources.reduce((a, s) => a + (s.usd ?? 0), 0) : null;
  return {
    usd,
    pricedUsd: sources.reduce((a, s) => a + s.pricedUsd, 0),
    estimate: sources.some((s) => s.estimate),
    credits: usd !== null && creditUsd ? usd / creditUsd : null,
  };
}

/**
 * Bought, used (by source) and left for one provider. Unknown stays unknown all the way through: a read that failed, a source
 * nobody records, a row with no price or a probe that may have billed makes "used" null (with the priced part as a floor),
 * and with it the estimate of what is left. What the provider's own API reported always wins over an estimate.
 */
export function providerLedger(x: LedgerInputs): ProviderLedger {
  const p = x.provider;
  const mine = x.topupsUnread ? [] : x.topups.filter((t) => t.provider === p.id && positive(t.amount_usd) !== null);
  const stamps = mine.map((t) => rowMs(t.paid_at)).filter(Number.isFinite);
  let bought: Bought;
  if (x.topupsUnread) bought = { state: "unread" };
  else if (mine.length === 0 || stamps.length === 0) bought = { state: "none" };
  else {
    const usd = mine.reduce((s, t) => s + Number(t.amount_usd), 0);
    bought = { state: "ok", usd, credits: p.creditUsd ? usd / p.creditUsd : null, count: mine.length, firstMs: Math.min(...stamps) };
  }
  // Counted from the start of the UTC day of the first top-up: a top-up logged after the fact (paid_at defaults to the moment
  // it was logged) must not leave that day's earlier use out of what it paid for.
  const sinceTopup = bought.state === "ok";
  const startMs = bought.state === "ok" ? utcDayStart(bought.firstMs) : x.now - 30 * DAY_MS;

  const sourcesAt = (from: number) => ({ pipeline: pipelineUse(x, from), studio: studioUse(x, from), probes: probeUse(x, from) });
  const sources = sourcesAt(startMs);
  const used = usedOf([sources.pipeline, sources.studio, sources.probes], p.creditUsd);

  const snap = x.balancesUnread ? null : latestBalance(x.balances, p.id);
  const snapLeft = snap ? finite(snap.remaining) : null;
  let remaining: Remaining;
  if (snap && snapLeft !== null && snapLeft >= 0) {
    remaining = {
      kind: "reported",
      amount: snapLeft,
      unit: snap.unit,
      checkedAt: snap.checked_at,
      usd: snap.unit === "credits" && p.creditUsd ? snapLeft * p.creditUsd : null,
    };
  } else if (bought.state === "ok" && used.usd !== null) {
    const left = bought.usd - used.usd;
    // More spent than the top-ups recorded: a trial credit, an auto-recharge or a top-up never logged. Not "0 left".
    remaining = left < 0 ? { kind: "unknown", why: "negative" } : { kind: "estimate", usd: left, credits: p.creditUsd ? left / p.creditUsd : null };
  } else {
    const why =
      x.topupsUnread || (x.balancesUnread && bought.state !== "ok")
        ? "unread"
        : bought.state === "none"
          ? "no_topup"
          : (usedUnknownWhy([sources.pipeline, sources.studio, sources.probes]) ?? "used_unread");
    remaining = { kind: "unknown", why };
  }

  // The pace is the last 30 days of the window (or the whole window when it is younger): a top-up of months ago must not
  // average today's spend over months.
  const paceFrom = Math.max(startMs, x.now - 30 * DAY_MS);
  const recent = paceFrom === startMs ? used : usedOf(Object.values(sourcesAt(paceFrom)), p.creditUsd);
  const usdPerDay = recent.usd === null ? null : recent.usd / Math.max(1, (x.now - paceFrom) / DAY_MS);
  const leftUsd = remaining.kind === "reported" || remaining.kind === "estimate" ? remaining.usd : null;
  const runsOut = daysLeft(leftUsd, usdPerDay);
  const runsOutEstimate = runsOut !== null && (recent.estimate || remaining.kind === "estimate");
  return { id: p.id, startMs, sinceTopup, bought, sources, used, remaining, usdPerDay, runsOut, runsOutEstimate };
}

/**
 * What one provider spent from `fromMs` to `x.now`, by the same three sources and the same rules as providerLedger() — so a
 * 24-hour or 7-day burn on another page cannot disagree with the ledger it sits beside. Null `usd` when any source is
 * unknown, cut or unpriced for that window (the priced part is a floor).
 */
export function providerSpendSince(x: LedgerInputs, fromMs: number): UsedTotal & { sources: { pipeline: SourceUse; studio: SourceUse; probes: SourceUse } } {
  const sources = { pipeline: pipelineUse(x, fromMs), studio: studioUse(x, fromMs), probes: probeUse(x, fromMs) };
  return { ...usedOf([sources.pipeline, sources.studio, sources.probes], x.provider.creditUsd), sources };
}
