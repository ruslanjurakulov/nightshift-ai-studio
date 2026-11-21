"use client";

import { useId, useState } from "react";

export type PlanRow = { minutes: number; length: string; need: string; cover: string; credits: string; price: string | null };

/**
 * The interactive half of the month planner: a native range input and the figures it selects. Every string is worked out
 * on the server from the published rate and the packs the pricing source lists (components/pricing/PackPlanner.tsx) and
 * arrives as a table; this file holds no price logic and pulls no pricing code into the browser. The figure is an
 * <output> tied to the slider.
 */
export function PlanSlider({ rows, start, label, needLabel, coversLabel }: { rows: PlanRow[]; start: number; label: string; needLabel: string; coversLabel: string }) {
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
          {label}
        </label>
        <div className="nx-calc-row">
          <input
            id={`${uid}-len`}
            className="nx-range"
            type="range"
            min={first}
            max={last}
            step={10}
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
      <div className="nx-plan-out">
        <div className="nx-calc-out">
          <p className="nx-calc-q">{needLabel}</p>
          <output htmlFor={`${uid}-len`} className="nx-calc-n" key={row.need}>
            {row.need}
          </output>
        </div>
        <div className="nx-calc-out nx-plan-pack">
          <p className="nx-calc-q">{coversLabel}</p>
          <p className="nx-plan-name" key={row.cover}>
            {row.cover}
          </p>
          <p className="nx-calc-sub">{row.credits}</p>
          {row.price && <p className="nx-plan-price">{row.price}</p>}
        </div>
      </div>
    </>
  );
}
