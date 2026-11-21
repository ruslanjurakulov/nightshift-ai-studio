/**
 * Unit-economics portfolio derivations.
 *
 * One question: which channels make money. The answer is assembled from two
 * facts the pipeline already records — cost, from the cost ledger
 * (`video_costs`, migration 0002 / modules/cost_ledger.py), and revenue, from
 * revenue tracking (`revenue.tracked` system events / modules/revenue_tracker.py).
 * Everything else here is derived from those two: profit, margin, and cost per
 * video. RPM is passed through from revenue tracking, not recomputed.
 *
 * The rule that shapes all of it, the same one measurement.ts enforces: **null
 * is not zero.** A cost is unknown when a unit was recorded with no configured
 * rate; a revenue is unknown until the channel actually reported earnings.
 * A derived figure is computed ONLY when every input it needs is known, and is
 * `null` (blank in the UI) otherwise — never a fabricated or inferred number.
 * Profit needs BOTH sides; margin needs a positive revenue; cost per video
 * needs at least one video and a known cost. Aggregates sum only the channels
 * that actually have the value, and never pair one channel's revenue with
 * another channel's cost.
 *
 * Pure functions over plain inputs, unit-tested like every other derivation in
 * lib/ — the page prepares the per-channel {cost, revenue, videoCount, rpm}
 * from Supabase rows and passes them here.
 */

/** What the page hands in per channel — plain, already-reconciled values. */
export interface ChannelEconomicsInput {
  channelId: string;
  name: string;
  /** Videos attributed to the channel — the cost-per-video denominator. */
  videoCount: number;
  /** Total priced spend in USD, or null when unknown (unpriced / no ledger). */
  cost: number | null;
  /** Real tracked revenue in USD, or null when unknown (never a fabricated 0). */
  revenue: number | null;
  /** Channel RPM (USD per 1000 views) from revenue tracking, or null. Passed through. */
  rpm?: number | null;
}

/** One channel's economics, with every derived figure explicit-or-null. */
export interface ChannelEconomics {
  channelId: string;
  name: string;
  videoCount: number;
  cost: number | null;
  revenue: number | null;
  /** revenue − cost, only when BOTH are known; else null (unknown). */
  profit: number | null;
  /** profit / revenue, only when revenue > 0 (and profit known); else null. */
  margin: number | null;
  /** cost / videoCount, only when videoCount > 0 and cost known; else null. */
  costPerVideo: number | null;
  rpm: number | null;
}

/** Portfolio roll-up across every channel. */
export interface PortfolioTotals {
  channels: ChannelEconomics[];
  totalVideos: number;
  /** Sum of KNOWN costs; a floor when `costPartial`. Null when none are known. */
  totalCost: number | null;
  /** Sum of KNOWN revenue; a floor when `revenuePartial`. Null when none are known. */
  totalRevenue: number | null;
  /**
   * Aggregate profit — the sum of per-channel profit over channels where BOTH
   * cost and revenue are known. Null when no channel has both. Deliberately NOT
   * `totalRevenue − totalCost`: those floors can cover different channels, and
   * subtracting one channel's cost from another's revenue would invent a number.
   */
  totalProfit: number | null;
  /** totalProfit / (revenue of the same both-known channels), when that is > 0; else null. */
  avgMargin: number | null;
  /** Some channel's cost was unknown and excluded — `totalCost` is a floor. */
  costPartial: boolean;
  /** Some channel's revenue was unknown and excluded — `totalRevenue` is a floor. */
  revenuePartial: boolean;
  /** True when at least one channel has any economics worth showing. */
  hasAny: boolean;
}

function isNum(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Derive one channel's economics from its plain inputs. */
export function channelEconomics(input: ChannelEconomicsInput): ChannelEconomics {
  const cost = isNum(input.cost) ? input.cost : null;
  const revenue = isNum(input.revenue) ? input.revenue : null;
  const videoCount = input.videoCount;

  // Profit needs both sides. A known cost with unknown revenue is NOT a loss of
  // that cost — it is unknown profit, so it stays blank.
  const profit = cost !== null && revenue !== null ? revenue - cost : null;

  // Margin is a share of revenue, so it is meaningless without a positive
  // revenue. Zero (or unknown) revenue leaves it blank rather than 0% or ∞.
  const margin = profit !== null && revenue !== null && revenue > 0 ? profit / revenue : null;

  // Cost per video divides a known cost by a real count. No videos, or no known
  // cost, leaves it blank.
  const costPerVideo = cost !== null && videoCount > 0 ? cost / videoCount : null;

  return {
    channelId: input.channelId,
    name: input.name,
    videoCount,
    cost,
    revenue,
    profit,
    margin,
    costPerVideo,
    rpm: isNum(input.rpm) ? input.rpm : null,
  };
}

/** Roll a list of channel inputs up into per-channel rows and portfolio totals. */
export function portfolioTotals(inputs: ChannelEconomicsInput[]): PortfolioTotals {
  const channels = (inputs ?? []).map(channelEconomics);

  let totalCost: number | null = null;
  let totalRevenue: number | null = null;
  let totalProfit: number | null = null;
  // Revenue base for avgMargin: only the channels whose profit is known, so the
  // ratio's numerator and denominator describe the same set of channels.
  let bothKnownRevenue: number | null = null;
  let totalVideos = 0;
  let costPartial = false;
  let revenuePartial = false;
  let hasAny = false;

  for (const c of channels) {
    totalVideos += c.videoCount;
    if (c.cost !== null || c.revenue !== null || c.videoCount > 0) hasAny = true;

    if (c.cost !== null) totalCost = (totalCost ?? 0) + c.cost;
    else costPartial = true;

    if (c.revenue !== null) totalRevenue = (totalRevenue ?? 0) + c.revenue;
    else revenuePartial = true;

    if (c.profit !== null && c.revenue !== null) {
      totalProfit = (totalProfit ?? 0) + c.profit;
      bothKnownRevenue = (bothKnownRevenue ?? 0) + c.revenue;
    }
  }

  const avgMargin =
    totalProfit !== null && bothKnownRevenue !== null && bothKnownRevenue > 0
      ? totalProfit / bothKnownRevenue
      : null;

  return {
    channels,
    totalVideos,
    totalCost,
    totalRevenue,
    totalProfit,
    avgMargin,
    costPartial,
    revenuePartial,
    hasAny,
  };
}
