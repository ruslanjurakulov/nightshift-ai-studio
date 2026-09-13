/**
 * Dashboard quota gauges (roadmap #77).
 *
 * The upload-quota allocator (`modules/quota_allocator.py`) emits a
 * `quota.allocated` event splitting the day's upload budget across channels by
 * measured views/day. The Advisory panel already lists it as text; this turns
 * the same event into the gauge rows the dashboard draws.
 *
 * `null != 0` throughout: a channel whose performance was never measured has
 * `share === null`, and its gauge is rendered *unmeasured* (an empty track and
 * an "N/A" reading), never a full-looking or a misleading 0% bar. Only a real
 * measured fraction fills a gauge.
 */

import type { QuotaAllocation } from "@/lib/advisory";

export interface QuotaGaugeRow {
  channelId: string;
  name: string;
  /** Allocated upload slots for the day, or null when unreadable. */
  slots: number | null;
  /** Measured share as a whole-number percent (0–100), or null when unmeasured. */
  sharePct: number | null;
  /** Bar fill width in percent (0–100) — always 0 for an unmeasured channel. */
  fillPct: number;
  /** True only when the channel has a real measured share to draw. */
  measured: boolean;
}

export interface QuotaGaugeView {
  ts: string | null;
  totalSlots: number | null;
  rows: QuotaGaugeRow[];
  /** True when there is a quota event but no channels to allocate across. */
  emptyAllocation: boolean;
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * Turn a parsed QuotaAllocation into gauge rows. Returns an empty view (no
 * rows, null totals) when there is no quota event yet, so the widget can show
 * its "poller hasn't run" state rather than inventing zeros.
 */
export function quotaGaugeView(quota: QuotaAllocation | null): QuotaGaugeView {
  if (!quota) {
    return { ts: null, totalSlots: null, rows: [], emptyAllocation: false };
  }

  const rows: QuotaGaugeRow[] = quota.channels.map((c) => {
    const measured = c.share !== null;
    const sharePct = measured ? Math.round((c.share as number) * 100) : null;
    return {
      channelId: c.channelId,
      name: c.name,
      slots: c.slots,
      sharePct,
      fillPct: sharePct === null ? 0 : clampPct(sharePct),
      measured,
    };
  });

  return {
    ts: quota.ts,
    totalSlots: quota.totalSlots,
    rows,
    emptyAllocation: rows.length === 0,
  };
}
