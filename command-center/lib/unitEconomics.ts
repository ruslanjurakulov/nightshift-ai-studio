/**
 * Unit economics — what one finished video actually costs ("1 video = $X").
 *
 * The number future credit pricing is built on, so it is held to the ledger's
 * rule with no exceptions: **a dollar figure exists only when every entry
 * behind it was priced.** The cost ledger (modules/cost_ledger.py) records
 * quantities always and stamps `estimated_usd` only when the operator had set
 * that unit's rate (CHRONOS_PRICE_<UNIT>) at the time. So:
 *
 *   - A video with ANY unpriced entry is "partially priced". Its priced part is
 *     a floor, not its cost, and it is excluded from every USD median, p90 and
 *     driver share — mixing floors in would drag "1 video = $X" below the real
 *     figure, which is exactly the number a price list must not understate.
 *   - How many videos were excluded, and which units lack a price (with the
 *     exact env var that fixes it), is part of the result, not a footnote.
 *   - Unknown is null. Never 0.
 *
 * Cost per finished minute additionally needs the video's real length. That
 * comes from the Video IR (videos.manifest.audio.duration_s, migration 0013 —
 * narration is the master clock), and a video without one is left out of the
 * per-minute figures rather than given a guessed length.
 *
 * Pure functions over plain rows; tested in tests/unitEconomics.test.ts. The
 * Python twin for pricing work from a terminal is tools/unit_economics.py.
 */

import { percentile, type CostRowLite } from "@/lib/billing";

/** One `video_costs` row as this module needs it. */
export interface LedgerRow extends CostRowLite {
  channel_id?: string | null;
  /** USD stamped at record time; null when the unit had no configured rate. */
  estimated_usd?: number | null;
}

/** A finished video's real length, keyed the same way the ledger keys a run. */
export interface DurationRow {
  video_id?: string | null;
  slug?: string | null;
  channel_id?: string | null;
  /** Seconds of finished video, or null when not known. */
  duration_s: number | null;
}

/** One unit (optionally split by provider) inside a video or across the sample. */
export interface CostDriver {
  /** `unit` or `unit:provider` — stable, for React keys and lookups. */
  key: string;
  unit: string;
  /** The billing provider when the stage names one ("broll:minimax"), else null. */
  provider: string | null;
  quantity: number;
  /** USD, or null when any entry of this driver was unpriced. */
  usd: number | null;
  /** How many videos this driver appears in. */
  videos: number;
}

export interface VideoEconomics {
  key: string;
  videoId: string | null;
  slug: string | null;
  channelId: string | null;
  /** Newest recorded_at among the video's entries. */
  recordedAt: string;
  /** Sum of the priced entries only — a FLOOR when `unpricedUnits` is non-empty. */
  pricedUsd: number;
  /** The video's cost; null when any entry was unpriced. */
  usd: number | null;
  unpricedUnits: string[];
  durationS: number | null;
  /** usd per minute of finished video; null when either side is unknown. */
  usdPerMinute: number | null;
  drivers: CostDriver[];
}

/** A unit with no price in at least one sampled video. */
export interface UnpricedUnit {
  unit: string;
  /** The exact env var the bot reads to price it (cost_ledger.price_env_var). */
  envVar: string;
  /** Sampled videos in which this unit was recorded without a price. */
  videos: number;
  /** Quantity of this unit recorded, across the sampled videos where it went unpriced. */
  quantity: number;
}

export interface ShareDriver extends CostDriver {
  usd: number;
  /** Average USD per fully priced video. */
  usdPerVideo: number;
  /** Share of the fully priced videos' total cost (0..1), or null when that total is 0. */
  share: number | null;
}

export interface UnitEconomics {
  /** The sample, newest first. */
  videos: VideoEconomics[];
  sampleSize: number;
  /** Videos whose every entry was priced — the only ones in USD figures. */
  pricedVideos: number;
  /** Videos excluded from USD figures because something in them was unpriced. */
  partialVideos: number;
  medianPerVideo: number | null;
  p90PerVideo: number | null;
  /** Fully priced videos that also have a known length (the per-minute sample). */
  minuteSample: number;
  medianPerMinute: number | null;
  p90PerMinute: number | null;
  /** Every unit/provider across the whole sample; usd null when any entry is unpriced. */
  breakdown: CostDriver[];
  /** Cost drivers over the fully priced videos, most expensive first. */
  drivers: ShareDriver[];
  unpriced: UnpricedUnit[];
  /** Ledger rows with neither a video id nor a slug — cannot be tied to a video. */
  unattributedRows: number;
  windowDays: number;
  maxVideos: number;
}

export interface UnitEconomicsOptions {
  /** Only videos whose newest entry is within this many days. Default 30. */
  windowDays?: number;
  /** At most this many of the most recent videos. Default 30. */
  maxVideos?: number;
  durations?: DurationRow[];
  now?: number;
}

const DAY_MS = 86_400_000;
const PRICE_ENV_PREFIX = "CHRONOS_PRICE_";

/** The env var modules/cost_ledger.py reads for `unit` — keep in step with price_env_var(). */
export function priceEnvVar(unit: string): string {
  return PRICE_ENV_PREFIX + unit.toUpperCase();
}

function text(v: string | null | undefined): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

function finite(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Provider named by a stage like "broll:minimax" / "image:leonardo", else null. */
export function providerOf(stage: string | null | undefined): string | null {
  const m = /^(?:broll|image):(.+)$/.exec(stage ?? "");
  return m ? m[1].trim() || null : null;
}

/**
 * Which video a row belongs to. The slug first: the pipeline stamps it on every
 * entry, while `video_id` is written as "" for a run that was held or blocked
 * (the default when auto-publish is off) and a later scene repair records under
 * the slug alone — keying on video_id would split one video into two.
 */
function videoKey(row: LedgerRow): string | null {
  const id = text(row.slug) ?? text(row.video_id);
  if (!id) return null;
  return `${text(row.channel_id) ?? ""}|${id}`;
}

function durationLookup(rows: DurationRow[]): (v: { channelId: string | null; slug: string | null; videoId: string | null }) => number | null {
  const bySlug = new Map<string, number>();
  const byId = new Map<string, number>();
  for (const d of rows) {
    const s = finite(d.duration_s);
    if (s === null || s <= 0) continue;
    const ch = text(d.channel_id) ?? "";
    const slug = text(d.slug);
    const id = text(d.video_id);
    if (slug) bySlug.set(`${ch}|${slug}`, s);
    if (id) byId.set(`${ch}|${id}`, s);
  }
  return ({ channelId, slug, videoId }) => {
    const ch = channelId ?? "";
    return (slug && bySlug.get(`${ch}|${slug}`)) || (videoId && byId.get(`${ch}|${videoId}`)) || null;
  };
}

function addDriver(acc: Map<string, CostDriver>, unit: string, provider: string | null, quantity: number, usd: number | null) {
  const key = provider ? `${unit}:${provider}` : unit;
  const d = acc.get(key) ?? { key, unit, provider, quantity: 0, usd: 0, videos: 0 };
  d.quantity += quantity;
  // Once any entry is unpriced the driver's dollar sum is a floor — say unknown.
  d.usd = d.usd === null || usd === null ? null : d.usd + usd;
  acc.set(key, d);
}

/** Per-video costs and channel-level unit economics from recent ledger rows. */
export function unitEconomics(rows: LedgerRow[], opts: UnitEconomicsOptions = {}): UnitEconomics {
  const windowDays = opts.windowDays ?? 30;
  const maxVideos = opts.maxVideos ?? 30;
  const now = opts.now ?? Date.now();
  const since = now - windowDays * DAY_MS;
  const lengthOf = durationLookup(opts.durations ?? []);

  const groups = new Map<string, LedgerRow[]>();
  let unattributedRows = 0;
  for (const r of rows ?? []) {
    if (!r || finite(r.quantity) === null) continue;
    const key = videoKey(r);
    if (!key) {
      unattributedRows += 1;
      continue;
    }
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const all: VideoEconomics[] = [];
  for (const [key, entries] of groups) {
    const newest = entries.reduce((m, e) => (e.recorded_at > m ? e.recorded_at : m), entries[0].recorded_at);
    const t = Date.parse(newest);
    if (!Number.isFinite(t) || t < since || t > now) continue;

    const drivers = new Map<string, CostDriver>();
    const unpriced = new Set<string>();
    let pricedUsd = 0;
    for (const e of entries) {
      const usd = finite(e.estimated_usd);
      if (usd === null) unpriced.add(e.unit);
      else pricedUsd += usd;
      addDriver(drivers, e.unit, providerOf(e.stage), Number(e.quantity), usd);
    }
    for (const d of drivers.values()) d.videos = 1;

    const first = entries[0];
    const videoId = entries.map((e) => text(e.video_id)).find(Boolean) ?? null;
    const slug = text(first.slug);
    const channelId = text(first.channel_id);
    const usd = unpriced.size ? null : pricedUsd;
    const durationS = lengthOf({ channelId, slug, videoId });
    all.push({
      key,
      videoId,
      slug,
      channelId,
      recordedAt: newest,
      pricedUsd,
      usd,
      unpricedUnits: [...unpriced].sort(),
      durationS,
      usdPerMinute: usd !== null && durationS ? usd / (durationS / 60) : null,
      drivers: [...drivers.values()].sort(byUsdThenQty),
    });
  }

  all.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const videos = all.slice(0, Math.max(0, maxVideos));
  const priced = videos.filter((v) => v.usd !== null);

  const perVideo = priced.map((v) => v.usd as number);
  const perMinute = priced.flatMap((v) => (v.usdPerMinute === null ? [] : [v.usdPerMinute]));

  // Whole-sample breakdown: quantities are facts for every video.
  const breakdown = new Map<string, CostDriver>();
  const unpricedAcc = new Map<string, UnpricedUnit>();
  for (const v of videos) {
    for (const d of v.drivers) {
      const cur = breakdown.get(d.key) ?? { ...d, quantity: 0, usd: 0, videos: 0 };
      cur.quantity += d.quantity;
      cur.usd = cur.usd === null || d.usd === null ? null : cur.usd + d.usd;
      cur.videos += 1;
      breakdown.set(d.key, cur);
    }
    for (const e of v.unpricedUnits) {
      const u = unpricedAcc.get(e) ?? { unit: e, envVar: priceEnvVar(e), videos: 0, quantity: 0 };
      u.videos += 1;
      u.quantity += v.drivers.filter((d) => d.unit === e && d.usd === null).reduce((s, d) => s + d.quantity, 0);
      unpricedAcc.set(e, u);
    }
  }

  // Drivers over the fully priced videos only, so shares add up to the same
  // cost the medians describe.
  const pricedTotal = perVideo.reduce((s, v) => s + v, 0);
  const driverAcc = new Map<string, CostDriver>();
  for (const v of priced) {
    for (const d of v.drivers) {
      const cur = driverAcc.get(d.key) ?? { ...d, quantity: 0, usd: 0, videos: 0 };
      cur.quantity += d.quantity;
      cur.usd = (cur.usd ?? 0) + (d.usd ?? 0);
      cur.videos += 1;
      driverAcc.set(d.key, cur);
    }
  }
  const drivers: ShareDriver[] = [...driverAcc.values()]
    .map((d) => ({
      ...d,
      usd: d.usd ?? 0,
      usdPerVideo: (d.usd ?? 0) / priced.length,
      share: pricedTotal > 0 ? (d.usd ?? 0) / pricedTotal : null,
    }))
    .sort(byUsdThenQty);

  return {
    videos,
    sampleSize: videos.length,
    pricedVideos: priced.length,
    partialVideos: videos.length - priced.length,
    medianPerVideo: percentile(perVideo, 0.5),
    p90PerVideo: percentile(perVideo, 0.9),
    minuteSample: perMinute.length,
    medianPerMinute: percentile(perMinute, 0.5),
    p90PerMinute: percentile(perMinute, 0.9),
    breakdown: [...breakdown.values()].sort(byUsdThenQty),
    drivers,
    unpriced: [...unpricedAcc.values()].sort((a, b) => b.videos - a.videos || a.unit.localeCompare(b.unit)),
    unattributedRows,
    windowDays,
    maxVideos,
  };
}

function byUsdThenQty(a: CostDriver, b: CostDriver): number {
  const au = a.usd ?? -1;
  const bu = b.usd ?? -1;
  return bu - au || b.quantity - a.quantity || a.key.localeCompare(b.key);
}
