/**
 * "What does my plan make?" on /pricing — the pure half: what one plan's credits make, the plan finder's arithmetic,
 * and the per-item price rows. Unit-tested in tests/plan-finder.test.ts.
 *
 * Every figure here is worked out from a rate the backend computed, by the same function that prices the real thing:
 *
 *   - a YouTube video: estimateRunCredits() (lib/credits.ts), the function Run now holds credits with, fed the
 *     `video_minute` and `job_minimum` rates AS CHARGED (credit_rates(), 0084, signed in; public_video_rates(), 0089,
 *     signed out). Not creditRates(): that one rounds the per-minute rate up to the cent before multiplying, so with a
 *     margin like 0.3333 a five-minute video read 6.70 here and was held at 6.67 (tests/plan-finder.test.ts pins it).
 *   - a Studio image or clip: quoteLike() (lib/plans.ts), the rule creative_price() applies (0159): quantity × rate,
 *     rounded up to the cent, raised to the job_minimum.
 *
 * There is no price in this file. The numbers it holds are a calendar (weeks in a month) and two facts about the
 * pipeline, each pinned to config.py by a test so they cannot drift: the frame it renders at, and its default length.
 * Nothing the visitor types reaches the network: the finder is arithmetic over rates the page was rendered with.
 *
 * A missing rate is never a number: every function here answers null for it, and the page says "price unavailable".
 * The voice a person picks does not change the quote, because the price list has one per-minute rate for every voice
 * (estimateRunCredits reads no voice); the page says that rather than invent a premium.
 */

import { UNIT_JOB_MINIMUM, UNIT_VIDEO_MINUTE, estimateRunReservation as estimateRunCredits, roundUpCredits, type PriceMap } from "@/lib/credits";
import { quoteLike } from "@/lib/plans";
import { lowestRate, type DiscoveryModel, type DiscoveryState, type PriceUnit } from "@/lib/models-discovery";

/** The frame a channel video is rendered at: config.py VIDEO_WIDTH / VIDEO_HEIGHT (pinned by tests/plan-finder.test.ts). */
export const CHANNEL_RENDER = { width: 1920, height: 1080 } as const;

/** The pipeline's default length in seconds: config.py VIDEO_DURATION_TARGET's default (pinned by the same test). A channel
 *  sets its own; this is the length the plan cards are worked out for, and it is printed beside every figure. */
export const DEFAULT_LENGTH_S = 300;

/** A year's weeks over its months. A calendar, not a price. */
export const WEEKS_PER_MONTH = 52 / 12;

/** The finder's controls: a control's bounds, never a claim about what can be made. Lengths follow a run's own bounds
 *  (lib/credits.ts MIN_RUN_SECONDS / MAX_RUN_SECONDS, render_job_params_valid 0017), in whole minutes. */
export const FINDER_LIMITS = {
  channels: { min: 1, max: 20 },
  perWeek: { min: 1, max: 14 },
  lengthMin: { min: 1, max: 60 },
} as const;
/** Headroom for runs made again: a run made again is a new run at its own quote (no re-render is sold today). */
export const RERUN_STEPS = [0, 10, 25, 50] as const;
export type RerunPct = (typeof RERUN_STEPS)[number];
export type VoiceTier = "standard" | "premium";
export const VOICE_TIERS: readonly VoiceTier[] = ["standard", "premium"];

// ── the rates the page may use ───────────────────────────────────────────────

/** When the rates were known: the price list's own `updated_at` (signed in), else the day the page read them. */
export type RateStamp = { kind: "set"; at: string } | { kind: "read"; at: string };

/**
 * The two units a YouTube video is quoted from, as charged, or null when there is no positive per-minute rate (an unset
 * or zero rate is unpublished, never free — 0089). Nothing else of the price list travels to the browser.
 */
export function videoPrices(prices: PriceMap | null | undefined): PriceMap | null {
  const minute = prices?.[UNIT_VIDEO_MINUTE];
  if (!minute || !Number.isFinite(minute.creditsPerUnit) || !(minute.creditsPerUnit > 0)) return null;
  const out: PriceMap = { [UNIT_VIDEO_MINUTE]: { ...minute, note: null } };
  const floor = prices?.[UNIT_JOB_MINIMUM];
  if (floor && Number.isFinite(floor.creditsPerUnit) && floor.creditsPerUnit > 0) out[UNIT_JOB_MINIMUM] = { ...floor, note: null };
  return out;
}

/** The newest `updated_at` of the units a video is quoted from, or null when the list did not say (the public read). */
export function videoRateSetAt(prices: PriceMap | null): string | null {
  if (!prices) return null;
  const at = [prices[UNIT_VIDEO_MINUTE]?.updatedAt, prices[UNIT_JOB_MINIMUM]?.updatedAt].filter(
    (v): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)),
  );
  return at.length ? at.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}

/**
 * What one finished video of `lengthS` seconds is quoted — exactly Run now's hold for it (estimateRunCredits, the
 * per-minute basis) — or null when there is no per-minute rate. Never a history basis: a visitor has no channel.
 */
export function youtubeVideoCredits(prices: PriceMap | null, lengthS: number): number | null {
  return youtubeQuote(prices, lengthS)?.credits ?? null;
}

/** The same quote with whether the smallest hold (job_minimum) raised it, which the finder says in words. */
export function youtubeQuote(prices: PriceMap | null, lengthS: number): { credits: number; floored: boolean } | null {
  if (!prices || !(lengthS > 0)) return null;
  const e = estimateRunCredits({ prices, durationS: lengthS, videos: [] });
  return e.basis === "per_minute" && e.credits !== null && e.credits > 0 ? { credits: e.credits, floored: e.floorApplied } : null;
}

/** How many of something costing `per` fit in `credits`, rounded DOWN ("≈ 6" must never be a 7th that does not fit). */
export function fits(credits: number, per: number | null): number | null {
  if (per === null || !(per > 0) || !Number.isFinite(credits) || credits < 0) return null;
  return Math.floor(credits / per + 1e-9);
}

// ── Studio: the per-item rows ────────────────────────────────────────────────

export type StudioKind = "image" | "video" | "other";

/** One priced setting of one Studio model, as /pricing lists it. */
export interface StudioRow {
  model: string;
  kind: StudioKind;
  unit: PriceUnit | null;
  /** The variant this rate is for (a quality, a resolution, with or without sound); [] = the model's one rate. */
  parts: string[];
  /** Credits per unit as charged; null = this setting has no price in the list. */
  rate: number | null;
  /** One output — an image, or a clip of the model's shortest length — priced as creative_price() would; null when unpriced. */
  perOutput: number | null;
  /** The clip length `perOutput` is for (video only). */
  seconds: number | null;
  state: DiscoveryState;
}

function kindOf(m: DiscoveryModel): StudioKind {
  if (m.spec.output === "image" && m.capabilities.includes("t2i") && m.spec.unit === "image") return "image";
  if (m.spec.output === "video" && (m.capabilities.includes("t2v") || m.capabilities.includes("i2v")) && m.spec.unit === "second") return "video";
  return "other";
}

/**
 * Every setting of every model the database would sell this visitor (sellable_models through readCustomerModels),
 * one row each. A model that is listed but not on sale (no price, or not open to any workspace) keeps one row with no
 * rate, so the table can say so. `minimum` is the job_minimum as charged (0 when none is set).
 */
export function studioRows(models: readonly DiscoveryModel[], minimum: number): StudioRow[] {
  const floor = Number.isFinite(minimum) && minimum > 0 ? roundUpCredits(minimum) : 0;
  const rows: StudioRow[] = [];
  for (const m of models) {
    const kind = kindOf(m);
    const seconds = kind === "video" ? Math.min(...m.spec.durationsS.filter((d) => Number.isInteger(d) && d > 0)) : null;
    const clip = seconds !== null && Number.isFinite(seconds) ? seconds : null;
    const price = (rate: number | null): number | null => {
      if (rate === null) return null;
      if (kind === "image") return quoteLike(1, { creditsPerUnit: rate }, floor);
      if (kind === "video") return clip === null ? null : quoteLike(clip, { creditsPerUnit: rate }, floor);
      return null;
    };
    const base = { model: m.displayName, kind, unit: m.spec.unit, seconds: kind === "video" ? clip : null, state: m.state };
    const onSale = m.state === "available" || m.state === "plan_gated";
    if (!onSale || lowestRate(m.price) === null) {
      rows.push({ ...base, parts: [], rate: null, perOutput: null });
      continue;
    }
    if (m.price.kind === "flat") rows.push({ ...base, parts: [], rate: m.price.rate, perOutput: price(m.price.rate) });
    else if (m.price.kind === "variants") for (const v of m.price.rows) rows.push({ ...base, parts: v.parts, rate: v.rate, perOutput: price(v.rate) });
  }
  return rows;
}

/** "≈ A–B" for one kind of output: the fewest (the dearest setting) and the most (the cheapest), each with its row named. */
export interface OutputRange {
  low: { count: number; row: StudioRow };
  high: { count: number; row: StudioRow };
}

/**
 * How many images (or clips) `credits` make across every setting open to everyone. Both ends are printed with the model
 * and setting they come from: never "up to N" off the cheapest model alone. Null when nothing of that kind is priced
 * and open — the page then says the price is unavailable. A plan-gated model (first purchase) is left out: the card
 * would otherwise promise what the plan alone does not open.
 */
export function outputRange(credits: number, rows: readonly StudioRow[], kind: "image" | "video"): OutputRange | null {
  let low: OutputRange["low"] | null = null;
  let high: OutputRange["high"] | null = null;
  for (const row of rows) {
    if (row.kind !== kind || row.state !== "available") continue;
    const n = fits(credits, row.perOutput);
    if (n === null) continue;
    if (!low || n < low.count) low = { count: n, row };
    if (!high || n > high.count) high = { count: n, row };
  }
  return low && high ? { low, high } : null;
}

// ── the plan finder ──────────────────────────────────────────────────────────

export interface FinderInput {
  channels: number;
  /** Videos a week on each channel. */
  perWeek: number;
  lengthMin: number;
  voice: VoiceTier;
  rerunPct: number;
}

export interface FinderNeed {
  /** Videos in a month, rounded UP: a month with a fifth Monday still gets its video. */
  videos: number;
  /** One video's quote. */
  perVideo: number;
  /** The quote rose to the smallest hold (job_minimum). */
  floored: boolean;
  /** videos × perVideo. */
  base: number;
  /** The re-run headroom, in credits. */
  headroom: number;
  /** What the month is expected to use at most: base + headroom, rounded up to the cent. */
  total: number;
}

const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));

/** The input as the finder may use it: whole numbers within the controls' bounds, a known headroom step. */
export function cleanInput(input: FinderInput): FinderInput {
  return {
    channels: clampInt(input.channels, FINDER_LIMITS.channels.min, FINDER_LIMITS.channels.max),
    perWeek: clampInt(input.perWeek, FINDER_LIMITS.perWeek.min, FINDER_LIMITS.perWeek.max),
    lengthMin: clampInt(input.lengthMin, FINDER_LIMITS.lengthMin.min, FINDER_LIMITS.lengthMin.max),
    voice: input.voice === "premium" ? "premium" : "standard",
    rerunPct: (RERUN_STEPS as readonly number[]).includes(input.rerunPct) ? input.rerunPct : 0,
  };
}

/**
 * A month of videos in credits, from the same quote Run now holds — or null when there is no per-minute rate. The
 * voice is read and deliberately unused: the price list has no per-voice rate (see the file comment).
 */
export function finderNeed(raw: FinderInput, prices: PriceMap | null): FinderNeed | null {
  const input = cleanInput(raw);
  const quote = youtubeQuote(prices, input.lengthMin * 60);
  if (quote === null) return null;
  const { credits: perVideo, floored } = quote;
  const videos = Math.ceil(input.channels * input.perWeek * WEEKS_PER_MONTH - 1e-9);
  const base = roundUpCredits(videos * perVideo);
  const total = roundUpCredits(base * (1 + input.rerunPct / 100));
  return { videos, perVideo, floored, base, headroom: roundUpCredits(total - base), total };
}

/** A plan the finder may recommend: on sale here (a price or a checkout), with its monthly credits. */
export interface FinderPlan {
  id: string;
  name: string;
  credits: number;
}

export type Recommendation =
  /** The smallest plan whose monthly credits cover the month; `spare` is what is left. */
  | { kind: "plan"; plan: FinderPlan; spare: number }
  /** More than any plan: the largest one, and what is short of it (top-up packs cover the rest). */
  | { kind: "over"; plan: FinderPlan; short: number }
  /** No plan is on sale here. */
  | { kind: "none" };

/** The cheapest-by-credits plan that covers `total` (equal is enough), else the largest with what is short. */
export function recommendPlan(total: number, plans: readonly FinderPlan[]): Recommendation {
  const sorted = plans.filter((p) => p.credits > 0).sort((a, b) => a.credits - b.credits || a.id.localeCompare(b.id));
  if (sorted.length === 0) return { kind: "none" };
  const fit = sorted.find((p) => p.credits + 1e-9 >= total);
  // What is left is rounded DOWN and what is short UP: neither may flatter the plan.
  if (fit) return { kind: "plan", plan: fit, spare: Math.max(0, Math.floor(Math.round((fit.credits - total) * 100 * 1e6) / 1e6) / 100) };
  const largest = sorted[sorted.length - 1];
  return { kind: "over", plan: largest, short: roundUpCredits(total - largest.credits) };
}

/**
 * The plans the finder may name: paid plans on sale here (a published price or a checkout — plansOnSale's rule), with
 * their monthly credits. The free plan's credits are a one-time welcome grant, not a month, so it is never a match.
 */
export function finderPlans(columns: readonly { id: string; name: string; monthlyCredits: number; isDefault: boolean; priceId: string | null; displayPrice: string | null }[]): FinderPlan[] {
  return columns
    .filter((c) => !c.isDefault && (c.priceId !== null || c.displayPrice !== null) && c.monthlyCredits > 0)
    .map((c) => ({ id: c.id, name: c.name, credits: c.monthlyCredits }));
}

// ── what the page is handed ──────────────────────────────────────────────────

/** Everything /pricing reads for this feature, already shaped for the browser (no margin, no note, no provider). */
export interface PlanFinderData {
  /** The two units a video is quoted from, as charged (videoPrices); null = no per-minute rate is published or readable. */
  video: PriceMap | null;
  videoStamp: RateStamp | null;
  studio:
    | { status: "ok"; rows: StudioRow[]; stamp: RateStamp }
    /** Signed out: sellable_models() and credit_rates() are members' reads (0035, 0084). */
    | { status: "signed_out" }
    /** The read failed: unknown, never "none on sale". */
    | { status: "failed" }
    /** 0035 is not applied here. */
    | { status: "not_enabled" };
}
