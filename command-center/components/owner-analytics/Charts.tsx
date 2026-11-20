"use client";

/**
 * The owner analytics hub's charts, drawn as SVG on the brand tokens. No chart library: the repo has none, and the
 * three forms the hub needs (a time series with a crosshair, ranked bars, a cohort heatmap) are smaller than any
 * library's configuration surface. One y-axis per chart, always — two measures of different scale get two charts.
 *
 * Honesty rules the drawing obeys:
 * - A null point is a GAP in the line, never a dip to zero (CLAUDE.md #5). The tooltip says "unknown".
 * - A series marked `projected` is dashed and its legend says "projection"; a band is drawn only around projected
 *   points, so measured history never wears a confidence interval it does not have.
 */

import type React from "react";
import { useI18n } from "@/lib/i18n/context";
import { pct } from "@/lib/owner-analytics/format";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export interface SeriesPoint {
  x: string;
  y: number | null;
  lo?: number | null;
  hi?: number | null;
}
export interface Series {
  key: string;
  label: string;
  points: SeriesPoint[];
  /** A projection, not a measurement: dashed, and labelled so. */
  projected?: boolean;
}

/** Categorical hues on the navy canvas, in fixed order. Identity follows the series key's position, never its rank. */
export const SERIES_COLORS = ["#2f8bff", "#ff4fa3", "#c8ff2e", "#33d6ff", "#ffd23f", "#3dff8a"];

export interface ChartLabels {
  unknown: string;
  projection: string;
  noData: string;
  /** "Show {label}" / "Hide {label}" for the legend toggles' accessible names. */
  show: string;
  hide: string;
}

/** Drawn at the container's own width (no stretched viewBox): an 11px label must stay 11px on a phone. */
const DEFAULT_W = 720;
const H = 240;
const PAD = { l: 52, r: 12, t: 12, b: 28 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

export function LineChart({
  series,
  format,
  labels,
  title,
  onSelectX,
}: {
  series: Series[];
  format: (n: number) => string;
  labels: ChartLabels;
  title: string;
  /** Drill-down: the x the owner clicked, so the page can scroll its table to that row. */
  onSelectX?: (x: string) => void;
}) {
  const id = useId();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(DEFAULT_W);
  useEffect(() => {
    const el = plotRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const xs = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of series) {
      for (const p of s.points) {
        if (seen.has(p.x)) continue;
        seen.add(p.x);
        out.push(p.x);
      }
    }
    return out.sort();
  }, [series]);

  const visible = series.filter((s) => !hidden.has(s.key));
  const yMax = niceMax(
    Math.max(0, ...visible.flatMap((s) => s.points.flatMap((p) => [p.y ?? 0, p.hi ?? 0]))),
  );
  const yMin = Math.min(0, ...visible.flatMap((s) => s.points.map((p) => p.lo ?? p.y ?? 0)));
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const xAt = (i: number) => PAD.l + (xs.length <= 1 ? innerW / 2 : (i / (xs.length - 1)) * innerW);
  const yAt = (v: number) => PAD.t + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;
  const index = new Map(xs.map((x, i) => [x, i]));

  const hasData = series.some((s) => s.points.some((p) => p.y !== null));
  if (!hasData) {
    return <p className="oa-empty">{labels.noData}</p>;
  }

  function pathFor(s: Series): string {
    let d = "";
    let pen = false;
    for (const p of s.points) {
      const i = index.get(p.x);
      if (i === undefined || p.y === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`;
      pen = true;
    }
    return d;
  }
  function bandFor(s: Series): string | null {
    const pts = s.points.filter((p) => p.lo != null && p.hi != null && index.has(p.x));
    if (pts.length < 2) return null;
    const top = pts.map((p) => `${xAt(index.get(p.x)!).toFixed(1)},${yAt(p.hi!).toFixed(1)}`);
    const bot = pts.reverse().map((p) => `${xAt(index.get(p.x)!).toFixed(1)},${yAt(p.lo!).toFixed(1)}`);
    return `M${top.join("L")}L${bot.join("L")}Z`;
  }

  function pick(e: PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xAt(i) - px) < Math.abs(xAt(best) - px)) best = i;
    setHover(best);
  }
  function key(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === "ArrowRight") setHover((h) => Math.min(xs.length - 1, (h ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? xs.length) - 1));
    else if (e.key === "Enter" && hover !== null) onSelectX?.(xs[hover]);
    else if (e.key === "Escape") setHover(null);
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin));
  const hx = hover === null ? null : xs[hover];

  return (
    <figure className="oa-chart" aria-labelledby={`${id}-t`}>
      <figcaption id={`${id}-t`} className="sr-only">
        {title}
      </figcaption>
      {series.length > 1 && (
        <div className="oa-legend" role="group">
          {series.map((s, i) => {
            const off = hidden.has(s.key);
            return (
              <button
                key={s.key}
                type="button"
                className="oa-legend-item"
                aria-pressed={!off}
                aria-label={(off ? labels.show : labels.hide).replace("{label}", s.label)}
                onClick={() =>
                  setHidden((h) => {
                    const n = new Set(h);
                    if (n.has(s.key)) n.delete(s.key);
                    else n.add(s.key);
                    return n;
                  })
                }
                data-off={off || undefined}
              >
                <span
                  className="oa-swatch"
                  data-dashed={s.projected || undefined}
                  style={{ borderColor: SERIES_COLORS[i % SERIES_COLORS.length] }}
                />
                {s.label}
                {s.projected ? ` · ${labels.projection}` : ""}
              </button>
            );
          })}
        </div>
      )}
      <div className="oa-plot" ref={plotRef}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={title}
          tabIndex={0}
          onPointerMove={pick}
          onPointerLeave={() => setHover(null)}
          onClick={() => hx && onSelectX?.(hx)}
          onKeyDown={key}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={yAt(t)} y2={yAt(t)} className="oa-grid" />
              <text x={PAD.l - 6} y={yAt(t) + 4} textAnchor="end" className="oa-axis">
                {format(t)}
              </text>
            </g>
          ))}
          {xs.length > 0 && (
            <>
              <text x={xAt(0)} y={H - 8} className="oa-axis" textAnchor="start">
                {xs[0]}
              </text>
              <text x={xAt(xs.length - 1)} y={H - 8} className="oa-axis" textAnchor="end">
                {xs[xs.length - 1]}
              </text>
            </>
          )}
          {series.map((s, i) => {
            if (hidden.has(s.key)) return null;
            const color = SERIES_COLORS[i % SERIES_COLORS.length];
            const band = s.projected ? bandFor(s) : null;
            return (
              <g key={s.key}>
                {band && <path d={band} fill={color} opacity={0.12} />}
                <path
                  d={pathFor(s)}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeDasharray={s.projected ? "6 5" : undefined}
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
              </g>
            );
          })}
          {hover !== null && (
            <line x1={xAt(hover)} x2={xAt(hover)} y1={PAD.t} y2={H - PAD.b} className="oa-crosshair" />
          )}
          {hover !== null &&
            series.map((s, i) => {
              if (hidden.has(s.key)) return null;
              const p = s.points.find((q) => q.x === hx);
              if (!p || p.y === null) return null;
              return (
                <circle
                  key={s.key}
                  cx={xAt(hover)}
                  cy={yAt(p.y)}
                  r={4}
                  fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                  stroke="var(--oa-surface)"
                  strokeWidth={2}
                />
              );
            })}
        </svg>
        {hover !== null && hx && (
          <div
            className="oa-tooltip"
            role="status"
            style={{ left: `${(xAt(hover) / W) * 100}%` }}
            data-flip={xAt(hover) > W * 0.5 || undefined}
          >
            <div className="oa-tooltip-x">{hx}</div>
            {series.map((s, i) => {
              if (hidden.has(s.key)) return null;
              const p = s.points.find((q) => q.x === hx);
              if (!p) return null;
              return (
                <div key={s.key} className="oa-tooltip-row">
                  <span className="oa-dot" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
                  <span>
                    {s.label}
                    {s.projected ? ` · ${labels.projection}` : ""}
                  </span>
                  <span className="oa-num">{p.y === null ? labels.unknown : format(p.y)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </figure>
  );
}

export interface BarDatum {
  key: string;
  label: string;
  value: number | null;
  /** Secondary text beside the value (a count, a share). */
  note?: string;
}

/** Ranked horizontal bars. An unknown value draws no bar and says "unknown" — it is not the shortest bar. */
export function BarList({
  data,
  format,
  labels,
  onSelect,
}: {
  data: BarDatum[];
  format: (n: number) => string;
  labels: Pick<ChartLabels, "unknown" | "noData">;
  onSelect?: (key: string) => void;
}) {
  if (data.length === 0) return <p className="oa-empty">{labels.noData}</p>;
  const max = Math.max(0, ...data.map((d) => d.value ?? 0)) || 1;
  return (
    <ul className="oa-bars">
      {data.map((d) => (
        <li key={d.key}>
          <BarRow onSelect={onSelect ? () => onSelect(d.key) : undefined}>
            <span className="oa-bar-label">{d.label}</span>
            <span className="oa-bar-track" aria-hidden>
              {d.value !== null && <span className="oa-bar-fill" style={{ width: `${Math.max(0, (d.value / max) * 100)}%` }} />}
            </span>
            <span className="oa-num">{d.value === null ? labels.unknown : format(d.value)}</span>
            {d.note && <span className="oa-bar-note">{d.note}</span>}
          </BarRow>
        </li>
      ))}
    </ul>
  );
}

/** A row is a button only when it leads somewhere; otherwise it is plain content, not a disabled control. */
function BarRow({ onSelect, children }: { onSelect?: () => void; children: React.ReactNode }) {
  return onSelect ? (
    <button type="button" className="oa-bar-row" onClick={onSelect}>
      {children}
    </button>
  ) : (
    <div className="oa-bar-row">{children}</div>
  );
}

export interface HeatRow {
  key: string;
  label: string;
  size: number;
  /** Share retained per month offset (0 = the signup month); null = that month has not happened yet. */
  cells: Array<number | null>;
}

/** A cohort heatmap: one hue, light to dark by share. A month that has not happened yet is blank, not 0%. */
export function CohortHeatmap({
  rows,
  monthTemplate,
  sizeLabel,
  labels,
}: {
  rows: HeatRow[];
  /** "M{n}": a string, not a function, because a server page renders this client component. */
  monthTemplate: string;
  sizeLabel: string;
  labels: Pick<ChartLabels, "noData">;
}) {
  const { locale } = useI18n();
  const percent = (v: number) => pct(v, locale);
  const monthLabel = (i: number) => monthTemplate.replace("{n}", String(i));
  if (rows.length === 0) return <p className="oa-empty">{labels.noData}</p>;
  const width = Math.max(...rows.map((r) => r.cells.length));
  return (
    <div className="oa-table-wrap">
      <table className="oa-heat">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">{sizeLabel}</th>
            {Array.from({ length: width }, (_, i) => (
              <th scope="col" key={i}>
                {monthLabel(i)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td className="oa-num">{r.size}</td>
              {Array.from({ length: width }, (_, i) => {
                const v = r.cells[i];
                if (v === null || v === undefined) return <td key={i} className="oa-heat-na" />;
                return (
                  <td
                    key={i}
                    className="oa-num oa-heat-cell"
                    // Capped at 62% blue so the ink on the fullest cell keeps at least 4.5:1.
                    style={{ background: `color-mix(in srgb, #2f8bff ${Math.round(10 + v * 52)}%, transparent)` }}
                    title={`${r.label} · ${monthLabel(i)}: ${percent(v)}`}
                  >
                    {percent(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
