"use client";

/**
 * "What if the volume changes": the owner types the daily volume they expect, as a share of the last 7 days, and each
 * provider's runway is re-run at that pace. Arithmetic in the browser only — nothing is fetched, saved or spent. Every figure
 * here is a projection and says so.
 */

import { useId, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { num } from "@/lib/owner-analytics/format";
// From lib/stats, not lib/owner-analytics/runway: that module imports the server-only vendor table (lib/billing.ts).
import { runsOutAt } from "@/lib/stats";

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
  // Kept as typed: a cleared field is "no value yet", not 0 % (which would read "not at this pace" everywhere).
  const [text, setText] = useState("100");
  const parsed = text.trim() === "" ? null : Number(text);
  const valid = parsed !== null && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1000;
  const share = valid ? parsed : null;
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
            step={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            inputMode="numeric"
            aria-invalid={!valid || undefined}
          />
        </label>
      </div>
      {!valid && (
        <p className="oa-note" data-tone="warn" role="status">
          {d.runwayVolumeInvalid}
        </p>
      )}
      <p className="oa-note">{d.runwayVolumeNote}</p>
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
              const v = r.empty || share === null ? null : runsOutAt(r.left, r.perDay7d, share / 100);
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
