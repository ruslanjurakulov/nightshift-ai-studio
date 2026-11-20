"use client";

/**
 * "What if the volume changes": the owner types the daily volume they expect, as a share of the last 7 days, and each
 * provider's runway is re-run at that pace. Arithmetic in the browser only — nothing is fetched, saved or spent. Every figure
 * here is a projection and says so.
 */

import { useId, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { num } from "@/lib/owner-analytics/format";
import { runsOutAt } from "@/lib/owner-analytics/runway";

export interface VolumeRow {
  id: string;
  name: string;
  /** Left and the 7-day pace in one unit (USD, or the provider's own unit). */
  left: number | null;
  perDay7d: number | null;
  empty: boolean;
}

export function RunwayVolume({ rows }: { rows: VolumeRow[] }) {
  const { t, locale } = useI18n();
  const d = t.ownerAnalytics;
  const [share, setShare] = useState(100);
  const id = useId();
  return (
    <div>
      <div className="oa-picker">
        <label className="oa-slider" htmlFor={id}>
          {d.runwayVolume}
          <input
            id={id}
            type="number"
            min={0}
            max={1000}
            step={10}
            value={share}
            onChange={(e) => setShare(Math.max(0, Math.min(1000, Number(e.target.value) || 0)))}
            inputMode="numeric"
          />
        </label>
      </div>
      <div className="oa-table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">{d.providerName}</th>
              <th scope="col" className="oa-num">
                {d.runwayAtVolume} <span className="oa-badge" data-tone="warn">{d.projection}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const v = r.empty ? null : runsOutAt(r.left, r.perDay7d, share / 100);
              return (
                <tr key={r.id}>
                  <th scope="row">{r.name}</th>
                  <td className="oa-num">{r.empty ? d.runwayEmpty : v === null ? <span className="oa-dim">{d.unknown}</span> : v === "never" ? d.runwayNeverAtPace : num(v, locale, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
