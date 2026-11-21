"use client";

import { useId, useState } from "react";

export type PriceRow = { minutes: number; length: string; quote: string; usd: string | null; basis?: string; charge?: string };

/** The slip's fixed words (ledger order) and the one value that does not depend on the length. */
export type PriceSlip = { rest: string; lines: { id: string; word: string; note: string | null }[] };

/**
 * The interactive half of the price check: a native range input and the
 * figure it selects. Every string is computed on the server from the published
 * rate (components/landing/PriceCheck.tsx) and handed over as a table, so this
 * file holds no price logic and pulls no pricing or dictionary code into the
 * browser bundle. The figure is an <output> tied to the slider.
 *
 * With a `slip` the figure sits on an itemised slip (quote, hold, charge,
 * return) whose lines all come from the same row: the hold is the quote, the
 * charge is "at most" the quote, the return is the rest. No line is a number
 * this file worked out.
 */
export function PriceSlider({
  rows,
  start,
  lengthLabel,
  quoteLabel,
  slip,
  children,
}: {
  rows: PriceRow[];
  start: number;
  lengthLabel: string;
  quoteLabel: string;
  slip?: PriceSlip;
  children?: React.ReactNode;
}) {
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
      {slip ? (
        <>
          <div className="nx-slip" role="group" aria-labelledby={`${uid}-slip`}>
            <p className="nx-slip-title" id={`${uid}-slip`}>
              {quoteLabel}
            </p>
            <dl>
              {slip.lines.map((l) => {
                const note = l.id === "quote" ? row.basis : l.note;
                return (
                  <div key={l.id}>
                    <dt>
                      {l.word}
                      {note && <span>{note}</span>}
                    </dt>
                    <dd>
                      {l.id === "quote" ? (
                        // Re-keyed on change so the stylesheet can give the figure one quick pop (motion allowed only).
                        <output htmlFor={`${uid}-len`} key={row.quote}>
                          {row.quote}
                        </output>
                      ) : l.id === "hold" ? (
                        row.quote
                      ) : l.id === "charge" ? (
                        row.charge
                      ) : (
                        slip.rest
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
          {(row.usd || children) && (
            <div className="nx-calc-notes">
              {row.usd && <p className="nx-calc-sub">{row.usd}</p>}
              {children}
            </div>
          )}
        </>
      ) : (
        <div className="nx-calc-out">
          <p className="nx-calc-q">{quoteLabel}</p>
          {/* Re-keyed on change so the stylesheet can give the figure one quick pop (motion allowed only). */}
          <output htmlFor={`${uid}-len`} className="nx-calc-n" key={row.quote}>
            {row.quote}
          </output>
          {row.usd && <p className="nx-calc-sub">{row.usd}</p>}
          {children}
        </div>
      )}
    </>
  );
}
