/**
 * Billing derivations — what each paid provider has left, how fast it is being
 * spent, and when it runs out.
 *
 * Inputs are plain rows the Billing page reads from Supabase:
 *   - `video_costs`               (what the pipeline consumed, migration 0002)
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
  /** The provider's own billing / top-up page — the card is entered there. */
  billingUrl: string;
  /** Human label for one priced unit, e.g. "1M tokens", "1K credits", "clip". */
  unitLabel: string;
  /** How many native units one priced unit is (1e6 tokens, 1000 credits, 1 clip). */
  unitSize: number;
  /** Native units this ledger row consumed on this provider (0 when unrelated). */
  usage: (row: CostRowLite) => number;
}

const clipsOf = (id: string) => (r: CostRowLite) =>
  r.unit === "video_gen_clips" && r.stage === `broll:${id}` ? r.quantity : 0;
const imagesOf = (id: string) => (r: CostRowLite) =>
  r.unit === "image_generations" && r.stage === `image:${id}` ? r.quantity : 0;
const none = () => 0;

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
  { id: "kling", name: "Kling", billingUrl: "https://klingai.com", unitLabel: "clip", unitSize: 1, usage: clipsOf("kling") },
  { id: "veo", name: "Google Veo", billingUrl: "https://console.cloud.google.com/billing", unitLabel: "clip", unitSize: 1, usage: clipsOf("veo") },
  { id: "seedance", name: "Seedance", billingUrl: "https://console.volcengine.com/finance", unitLabel: "clip", unitSize: 1, usage: clipsOf("seedance") },
  { id: "wan", name: "Wan", billingUrl: "https://usercenter2-intl.aliyun.com/billing", unitLabel: "clip", unitSize: 1, usage: clipsOf("wan") },
  { id: "higgsfield", name: "Higgsfield", billingUrl: "https://higgsfield.ai/pricing", unitLabel: "clip", unitSize: 1, usage: clipsOf("higgsfield") },
  { id: "leonardo", name: "Leonardo.Ai", billingUrl: "https://app.leonardo.ai/api-access", unitLabel: "image", unitSize: 1, usage: imagesOf("leonardo") },
  { id: "anthropic", name: "Anthropic Claude", billingUrl: "https://console.anthropic.com/settings/billing", unitLabel: "1M tokens", unitSize: 1_000_000, usage: none },
  { id: "openai", name: "OpenAI", billingUrl: "https://platform.openai.com/settings/organization/billing/overview", unitLabel: "1M tokens", unitSize: 1_000_000, usage: none },
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
}

/** How fast `provider` is being consumed over the last `days` days. */
export function providerBurn(
  provider: BilledProvider,
  rows: CostRowLite[],
  usdPerUnit: number | null,
  days = 30,
  now: number = Date.now(),
): Burn {
  const since = now - days * DAY_MS;
  let units = 0;
  for (const r of rows) {
    const t = Date.parse(r.recorded_at);
    if (!Number.isFinite(t) || t < since || t > now) continue;
    const q = provider.usage(r);
    if (q > 0) units += q;
  }
  const unitsPerDay = units / days;
  const rate = finite(usdPerUnit);
  const usdPerDay = units === 0 ? 0 : rate === null ? null : (unitsPerDay / provider.unitSize) * rate;
  return { units, unitsPerDay, usdPerDay };
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
 * there is no top-up, or there was spend since then with no price set.
 */
export function ledgerBalanceUsd(
  provider: BilledProvider,
  topups: TopupRow[],
  rows: CostRowLite[],
  usdPerUnit: number | null,
): number | null {
  const mine = topups.filter((t) => t.provider === provider.id && finite(t.amount_usd) !== null);
  if (mine.length === 0) return null;
  const first = Math.min(...mine.map((t) => Date.parse(t.paid_at)).filter(Number.isFinite));
  const paid = mine.reduce((s, t) => s + Number(t.amount_usd), 0);
  let units = 0;
  for (const r of rows) {
    const t = Date.parse(r.recorded_at);
    if (Number.isFinite(t) && t >= first) units += provider.usage(r);
  }
  if (units === 0) return paid;
  const rate = finite(usdPerUnit);
  if (rate === null) return null;
  return paid - (units / provider.unitSize) * rate;
}

/**
 * Days until a balance is spent at the current burn. `"never"` when nothing is
 * being consumed; null when either side is unknown.
 */
export function daysLeft(balance: number | null, perDay: number | null): number | "never" | null {
  if (balance === null || perDay === null) return null;
  if (perDay <= 0) return "never";
  return Math.max(0, balance / perDay);
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
