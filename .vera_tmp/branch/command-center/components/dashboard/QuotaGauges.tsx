import { Meter } from "@/components/ui/Meter";
import "@/app/(app)/app-pages-g5.css";
import { Timecode } from "@/components/ui/Timecode";
import { StateBlock } from "@/components/states/StateBlock";
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
    return (
      <StateBlock tone="idle" compact>
        {view.emptyAllocation ? labels.none : labels.noData}
      </StateBlock>
    );
  }

  return (
    <div className="g5-quota">
      <div className="flex items-baseline justify-between gap-3">
        <span className="g5-k">{labels.total}</span>
        <span className="g5-v tabular-nums" style={{ fontSize: "1.25rem", fontWeight: 600 }}>
          <Timecode value={view.totalSlots} format="count" unknown="N/A" />
        </span>
      </div>

      <ul className="flex flex-col gap-5">
        {view.rows.map((r) => (
          <li key={r.channelId} className="g5-quota-row">
            <div className="flex items-baseline justify-between gap-3">
              <span className="g5-row-title min-w-0 truncate">{r.name}</span>
              <span className="g5-note tabular-nums shrink-0">
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
              <Meter value={r.sharePct} max={100} size="lg" segments={20} label={r.name} valueText={`${r.sharePct}%`} />
            )}
          </li>
        ))}
      </ul>

      <p className="g5-note">{labels.hint}</p>
    </div>
  );
}
