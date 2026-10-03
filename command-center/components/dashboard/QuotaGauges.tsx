import { Meter } from "@/components/ui/Meter";
import { Timecode } from "@/components/ui/Timecode";
import { EmptyState } from "@/components/ui";
import type { QuotaGaugeView } from "@/lib/quota-gauge";

export interface QuotaGaugeLabels {
  total: string;
  none: string;
  noData: string;
  slotsSuffix: string;
  unmeasured: string;
  hint: string;
}

/**
 * Per-channel upload-quota gauges (roadmap #77), drawn from the
 * `quota.allocated` event. Each channel gets a bar filled to its measured
 * share of the day's upload budget; a channel with no measured performance
 * shows an empty track and "N/A" rather than a misleading 0% — `null != 0`.
 *
 * A pure server component: it renders the view the poller produced and nothing
 * it didn't. No quota event yet → the "poller hasn't run" state, never zeros.
 */
export function QuotaGauges({
  view,
  labels,
}: {
  view: QuotaGaugeView;
  labels: QuotaGaugeLabels;
}) {
  if (view.rows.length === 0) {
    return <EmptyState>{view.emptyAllocation ? labels.none : labels.noData}</EmptyState>;
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="t-label">{labels.total}</span>
        <span className="tnum text-lg font-semibold tabular-nums text-[var(--color-fg)]">
          <Timecode value={view.totalSlots} format="count" unknown="N/A" />
        </span>
      </div>

      <ul className="mt-4 flex flex-col gap-4">
        {view.rows.map((r) => (
          <li key={r.channelId}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-sm text-[var(--color-fg)]">{r.name}</span>
              <span className="tnum shrink-0 text-sm tabular-nums text-[var(--color-muted)]">
                {r.slots === null ? "—" : (
                  <>
                    <Timecode value={r.slots} format="count" /> {labels.slotsSuffix}
                  </>
                )}
                {" · "}
                {r.measured ? `${r.sharePct}%` : labels.unmeasured}
              </span>
            </div>
            {r.measured && r.sharePct !== null && (
              <Meter value={r.sharePct} max={100} size="lg" segments={20} label={r.name} valueText={`${r.sharePct}%`} className="mt-2" />
            )}
          </li>
        ))}
      </ul>

      <p className="mt-4 text-sm font-light text-[var(--color-muted)]">{labels.hint}</p>
    </div>
  );
}
