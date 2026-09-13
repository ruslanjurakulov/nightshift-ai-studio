/**
 * Measurement derivations: cost, the thumbnail/title experiment, and retention.
 *
 * These are read-only views over rows the bot writes. The bot's own modules are
 * the authority for every threshold here — `modules/cost_ledger.py`,
 * `modules/ab_testing.py` and `modules/retention_analyzer.py` — and the
 * constants below are deliberate duplicates of theirs so the dashboard cannot
 * declare a winner the pipeline would not act on. Change one, change both.
 *
 * The rule that shapes all of it: **null is not zero**. An unpriced unit is not
 * free, an unpolled video has unknown click-through, and a video with no curve
 * has unknown retention. Each of those is excluded from an aggregate and named
 * in the UI, never averaged in as a zero.
 */

import type {
  MetricsSnapshotRow,
  RetentionPointRow,
  VideoCostRow,
  VideoRow,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Cost                                                                        */
/* -------------------------------------------------------------------------- */

export interface VideoCost {
  video_id: string | null;
  slug: string | null;
  channel_id: string;
  /** Total USD, or null when ANY of this video's entries had no configured rate. */
  usd: number | null;
  /** Units recorded with a quantity but no price — what the operator must configure. */
  unpricedUnits: string[];
  entries: number;
  recordedAt: string | null;
}

export interface CostSummary {
  videos: VideoCost[];
  /** Sum across videos that are FULLY priced. Null when none are. */
  totalUsd: number | null;
  /** How many videos have a complete price, and how many have costs at all. */
  pricedVideos: number;
  measuredVideos: number;
  /** Mean USD over the fully priced videos only. */
  meanUsd: number | null;
  /** Every unit seen without a rate, deduped — the CHRONOS_PRICE_* to set. */
  unpricedUnits: string[];
  /** Total quantity per unit, across everything. Always known. */
  quantityByUnit: Record<string, number>;
}

/** Group raw cost rows into per-video costs and a channel-level roll-up. */
export function summariseCosts(rows: VideoCostRow[]): CostSummary {
  const byVideo = new Map<string, VideoCostRow[]>();
  const quantityByUnit: Record<string, number> = {};

  for (const row of rows ?? []) {
    // Rows written before the upload succeeded have no video_id; the slug is
    // what ties them to a run, so it keys the group instead of collapsing them
    // all into one "unknown video".
    const key = row.video_id ?? (row.slug ? `slug:${row.slug}` : "unattributed");
    const bucket = byVideo.get(key);
    if (bucket) bucket.push(row);
    else byVideo.set(key, [row]);
    quantityByUnit[row.unit] = (quantityByUnit[row.unit] ?? 0) + (row.quantity ?? 0);
  }

  const videos: VideoCost[] = [];
  for (const entries of byVideo.values()) {
    const unpriced = new Set<string>();
    let usd = 0;
    for (const e of entries) {
      if (e.estimated_usd === null || e.estimated_usd === undefined) unpriced.add(e.unit);
      else usd += e.estimated_usd;
    }
    const first = entries[0];
    videos.push({
      video_id: first.video_id ?? null,
      slug: first.slug ?? null,
      channel_id: first.channel_id,
      // A partial total would understate the real cost, so an incomplete price
      // is reported as no price at all — same rule as CostLedger.total_usd.
      usd: unpriced.size ? null : usd,
      unpricedUnits: [...unpriced].sort(),
      entries: entries.length,
      recordedAt: entries.reduce<string | null>(
        (latest, e) => (latest === null || e.recorded_at > latest ? e.recorded_at : latest),
        null,
      ),
    });
  }
  videos.sort((a, b) => (b.recordedAt ?? "").localeCompare(a.recordedAt ?? ""));

  const priced = videos.filter((v) => v.usd !== null);
  const totalUsd = priced.length ? priced.reduce((sum, v) => sum + (v.usd ?? 0), 0) : null;
  const allUnpriced = new Set<string>();
  for (const v of videos) for (const u of v.unpricedUnits) allUnpriced.add(u);

  return {
    videos,
    totalUsd,
    pricedVideos: priced.length,
    measuredVideos: videos.length,
    meanUsd: totalUsd === null ? null : totalUsd / priced.length,
    unpricedUnits: [...allUnpriced].sort(),
    quantityByUnit,
  };
}

/* -------------------------------------------------------------------------- */
/* Thumbnail / title A/B                                                       */
/* -------------------------------------------------------------------------- */

/** Mirrors modules/ab_testing.py. */
export const MIN_PER_VARIANT = 5;
/** Mirrors modules/ab_testing.py — below this relative gap the arms are a tie. */
export const MIN_LIFT = 0.1;

export interface VariantStats {
  variant: "A" | "B";
  videos: number;
  /** Mean impression CTR over MEASURED videos, or null when none were. */
  meanCtr: number | null;
  impressions: number;
}

export interface ABResult {
  a: VariantStats;
  b: VariantStats;
  /** "A", "B", or null. Null means "not enough evidence", never "they are equal". */
  winner: "A" | "B" | null;
  /** Machine-readable reason, so the UI can translate rather than print English. */
  reason:
    | "needs_more_videos"
    | "no_ctr_measured"
    | "zero_ctr"
    | "under_lift_floor"
    | "decided";
  /** Relative lift of the leader over the trailer, when both are measured. */
  lift: number | null;
}

/**
 * Compare the two arms on real click-through.
 *
 * Only the newest snapshot per video counts, and a video whose CTR was never
 * measured is dropped rather than counted as 0 — an unpolled video has unknown
 * click-through, and averaging it in as zero would punish whichever arm
 * happened to ship most recently.
 */
export function variantPerformance(
  videos: VideoRow[],
  snapshots: MetricsSnapshotRow[],
): ABResult {
  const latest = new Map<string, MetricsSnapshotRow>();
  for (const s of snapshots ?? []) {
    if (!s.video_id) continue;
    const prev = latest.get(s.video_id);
    if (!prev || (s.snapshot_date ?? "") >= (prev.snapshot_date ?? "")) latest.set(s.video_id, s);
  }

  const buckets: Record<"A" | "B", { ctr: number; impressions: number }[]> = { A: [], B: [] };
  for (const v of videos ?? []) {
    const variant = (v.thumbnail_variant ?? "").toUpperCase();
    if (variant !== "A" && variant !== "B") continue;
    const snap = latest.get(v.video_id);
    if (!snap) continue;
    const ctr = snap.impression_ctr;
    if (ctr === null || ctr === undefined) continue;
    buckets[variant].push({ ctr, impressions: snap.impressions ?? 0 });
  }

  const stat = (variant: "A" | "B"): VariantStats => {
    const rows = buckets[variant];
    if (!rows.length) return { variant, videos: 0, meanCtr: null, impressions: 0 };
    return {
      variant,
      videos: rows.length,
      meanCtr: rows.reduce((sum, r) => sum + r.ctr, 0) / rows.length,
      impressions: rows.reduce((sum, r) => sum + r.impressions, 0),
    };
  };
  const a = stat("A");
  const b = stat("B");

  if (a.videos < MIN_PER_VARIANT || b.videos < MIN_PER_VARIANT) {
    return { a, b, winner: null, reason: "needs_more_videos", lift: null };
  }
  if (a.meanCtr === null || b.meanCtr === null) {
    return { a, b, winner: null, reason: "no_ctr_measured", lift: null };
  }
  const high = Math.max(a.meanCtr, b.meanCtr);
  const low = Math.min(a.meanCtr, b.meanCtr);
  if (low <= 0) return { a, b, winner: null, reason: "zero_ctr", lift: null };
  const lift = (high - low) / low;
  if (lift < MIN_LIFT) return { a, b, winner: null, reason: "under_lift_floor", lift };
  return { a, b, winner: a.meanCtr >= b.meanCtr ? "A" : "B", reason: "decided", lift };
}

/* -------------------------------------------------------------------------- */
/* First-30-seconds hook A/B (roadmap #60)                                      */
/* -------------------------------------------------------------------------- */

export interface HookStats {
  variant: "A" | "B";
  videos: number;
  /** Mean retention seconds over MEASURED videos, or null when none were. */
  meanRetention: number | null;
}

export interface HookResult {
  a: HookStats;
  b: HookStats;
  winner: "A" | "B" | null;
  reason: "needs_more_videos" | "no_retention_measured" | "zero_retention" | "under_lift_floor" | "decided";
  lift: number | null;
}

/**
 * Compare the two openings on real retention (average view duration), mirroring
 * modules/hook_ab.py. The hook is judged on whether a viewer STAYS, not whether
 * they click — a different lever from the thumbnail A/B. Only the newest
 * snapshot per video counts, and a video with no measured retention is dropped
 * (unknown), never counted as zero.
 */
export function hookPerformance(
  videos: VideoRow[],
  snapshots: MetricsSnapshotRow[],
): HookResult {
  const latest = new Map<string, MetricsSnapshotRow>();
  for (const s of snapshots ?? []) {
    if (!s.video_id) continue;
    const prev = latest.get(s.video_id);
    if (!prev || (s.snapshot_date ?? "") >= (prev.snapshot_date ?? "")) latest.set(s.video_id, s);
  }

  const buckets: Record<"A" | "B", number[]> = { A: [], B: [] };
  for (const v of videos ?? []) {
    const variant = (v.hook_variant ?? "").toUpperCase();
    if (variant !== "A" && variant !== "B") continue;
    const snap = latest.get(v.video_id);
    if (!snap) continue;
    const retention = snap.average_view_duration_seconds;
    if (retention === null || retention === undefined) continue;
    buckets[variant].push(retention);
  }

  const stat = (variant: "A" | "B"): HookStats => {
    const rows = buckets[variant];
    if (!rows.length) return { variant, videos: 0, meanRetention: null };
    return { variant, videos: rows.length, meanRetention: rows.reduce((a, b) => a + b, 0) / rows.length };
  };
  const a = stat("A");
  const b = stat("B");

  if (a.videos < MIN_PER_VARIANT || b.videos < MIN_PER_VARIANT) {
    return { a, b, winner: null, reason: "needs_more_videos", lift: null };
  }
  if (a.meanRetention === null || b.meanRetention === null) {
    return { a, b, winner: null, reason: "no_retention_measured", lift: null };
  }
  const high = Math.max(a.meanRetention, b.meanRetention);
  const low = Math.min(a.meanRetention, b.meanRetention);
  if (low <= 0) return { a, b, winner: null, reason: "zero_retention", lift: null };
  const lift = (high - low) / low;
  if (lift < MIN_LIFT) return { a, b, winner: null, reason: "under_lift_floor", lift };
  return { a, b, winner: a.meanRetention >= b.meanRetention ? "A" : "B", reason: "decided", lift };
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                   */
/* -------------------------------------------------------------------------- */

/** Mirrors modules/retention_analyzer.py. */
export const MIN_CURVES = 3;
export const MIN_POINTS = 5;
export const HOOK_RATIO = 0.1;
export const MIN_CLIFF_DROP = 0.08;

export interface RetentionCurve {
  /** Mean watch ratio at each measured point, across every usable video. */
  points: { elapsed: number; watch: number }[];
  /** Share still watching at the end of the hook window, or null. */
  hookRetention: number | null;
  /** Where the largest single drop begins, or null when no drop clears the floor. */
  cliffAt: number | null;
  cliffDrop: number | null;
  /** How many videos contributed a usable curve. */
  videos: number;
  /** True once there are enough curves to read the shape as a pattern. */
  enough: boolean;
}

/**
 * Average the stored curves into one channel-level curve.
 *
 * A single video's curve is that video's story; `MIN_CURVES` is what turns it
 * into a pattern, and below that floor `enough` is false so the UI says so
 * instead of drawing a confident line through two videos.
 */
export function aggregateRetention(points: RetentionPointRow[]): RetentionCurve {
  const perVideo = new Map<string, Map<number, number>>();
  for (const p of points ?? []) {
    if (p.watch_ratio === null || p.watch_ratio === undefined) continue;
    if (p.elapsed_ratio === null || p.elapsed_ratio === undefined) continue;
    let curve = perVideo.get(p.video_id);
    if (!curve) {
      curve = new Map();
      perVideo.set(p.video_id, curve);
    }
    // Several measured_dates can carry the same point; the newest wins, which
    // is what the map assignment does given rows arrive date-ordered.
    curve.set(p.elapsed_ratio, p.watch_ratio);
  }

  const usable = [...perVideo.values()].filter((c) => c.size >= MIN_POINTS);
  const sums = new Map<number, { total: number; n: number }>();
  for (const curve of usable) {
    for (const [elapsed, watch] of curve) {
      const cell = sums.get(elapsed) ?? { total: 0, n: 0 };
      cell.total += watch;
      cell.n += 1;
      sums.set(elapsed, cell);
    }
  }

  const merged = [...sums.entries()]
    .map(([elapsed, cell]) => ({ elapsed, watch: cell.total / cell.n }))
    .sort((x, y) => x.elapsed - y.elapsed);

  let hook: number | null = null;
  for (const point of merged) {
    if (point.elapsed <= HOOK_RATIO) hook = point.watch;
    else break;
  }

  let cliffAt: number | null = null;
  let cliffDrop = 0;
  for (let i = 0; i + 1 < merged.length; i += 1) {
    const drop = merged[i].watch - merged[i + 1].watch;
    if (drop > cliffDrop) {
      cliffDrop = drop;
      cliffAt = merged[i].elapsed;
    }
  }
  const cliffed = cliffDrop >= MIN_CLIFF_DROP;

  return {
    points: merged,
    hookRetention: hook,
    cliffAt: cliffed ? cliffAt : null,
    cliffDrop: cliffed ? cliffDrop : null,
    videos: usable.length,
    enough: usable.length >= MIN_CURVES,
  };
}
