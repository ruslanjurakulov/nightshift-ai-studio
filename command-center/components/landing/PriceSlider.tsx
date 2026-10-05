"use client";

import { useId, useState } from "react";

export type PriceRow = { minutes: number; length: string; quote: string; usd: string | null };

/**
 * The interactive half of the price check: a native range input and the
 * figure it selects. Every string is computed on the server from the published
 * rate (components/landing/PriceCheck.tsx) and handed over as a table, so this
 * file holds no price logic and pulls no pricing or dictionary code into the
 * browser bundle. The figure is an <output> tied to the slider.
 */
export function PriceSlider({ rows, start, lengthLabel, quoteLabel, children }: { rows: PriceRow[]; start: number; lengthLabel: string; quoteLabel: string; children?: React.ReactNode }) {
  const uid = useId();
  const first = rows[0].minutes;
  const last = rows[rows.length - 1].minutes;
  const [minutes, setMinutes] = useState(start);
  const row = rows.find((r) => r.minutes === minutes) ?? rows[0];
  const pct = ((minutes - first) / (last - first)) * 100;
  return (
    <>
      <div className="nx-calc-in">
        <label htmlFor={`${uid}-len`} className="nx-calc-label">
          {lengthLabel}
        </label>
        <div className="nx-calc-row">
          <input
            id={`${uid}-len`}
            className="nx-range"
            type="range"
            min={first}
            max={last}
            step={1}
            value={minutes}
            style={{ "--p": `${pct}%` } as React.CSSProperties}
            aria-valuetext={row.length}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
          <span className="nx-calc-len" aria-hidden>
            {row.length}
          </span>
        </div>
      </div>
      <div className="nx-calc-out">
        <p className="nx-calc-q">{quoteLabel}</p>
        {/* Re-keyed on change so the stylesheet can give the figure one quick pop (motion allowed only). */}
        <output htmlFor={`${uid}-len`} className="nx-calc-n" key={row.quote}>
          {row.quote}
        </output>
        {row.usd && <p className="nx-calc-sub">{row.usd}</p>}
        {children}
      </div>
    </>
  );
}
