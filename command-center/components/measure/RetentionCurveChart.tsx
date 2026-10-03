/**
 * The channel's averaged retention curve, drawn from real measured points.
 *
 * Deliberately plain: an area under the line, a marked hook window, and a
 * marker where the largest drop begins. The y-axis is pinned to 0-100% rather
 * than to the data's own range, because a curve auto-scaled to its own minimum
 * makes a channel that loses 90% of its audience look identical to one that
 * loses 10%. No client JS.
 */
interface Point {
  elapsed: number;
  watch: number;
}

const W = 640;
const H = 180;
const PAD_X = 34;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;

function x(elapsed: number): number {
  return PAD_X + (W - PAD_X * 2) * Math.min(1, Math.max(0, elapsed));
}

function y(watch: number): number {
  return PAD_TOP + (H - PAD_TOP - PAD_BOTTOM) * (1 - Math.min(1, Math.max(0, watch)));
}

export function RetentionCurveChart({
  points,
  cliffAt,
  hookRatio,
  label = "Audience retention curve",
}: {
  points: Point[];
  cliffAt: number | null;
  hookRatio: number;
  label?: string;
}) {
  if (points.length < 2) return null;

  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.elapsed).toFixed(1)},${y(p.watch).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(points[points.length - 1].elapsed).toFixed(1)},${y(0).toFixed(1)} L${x(points[0].elapsed).toFixed(1)},${y(0).toFixed(1)} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={label}>
      {/* Horizontal grid at 0 / 25 / 50 / 75 / 100%, each labelled. */}
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
        <g key={tick}>
          <line
            x1={PAD_X}
            x2={W - PAD_X}
            y1={y(tick)}
            y2={y(tick)}
            stroke="var(--color-border)"
            strokeWidth={1}
          />
          <text
            x={PAD_X - 6}
            y={y(tick) + 3}
            textAnchor="end"
            className="tnum"
            fontSize={9}
            fill="var(--color-muted)"
          >
            {`${tick * 100}%`}
          </text>
        </g>
      ))}

      {/* The hook window — the span whose retention is the hook's own score. */}
      <rect
        x={x(0)}
        y={PAD_TOP}
        width={x(hookRatio) - x(0)}
        height={H - PAD_TOP - PAD_BOTTOM}
        fill="var(--color-primary)"
        opacity={0.08}
      />

      <path d={area} fill="var(--color-primary)" opacity={0.14} />
      <path d={line} fill="none" stroke="var(--color-primary)" strokeWidth={2} />

      {cliffAt !== null && (
        <g>
          <line
            x1={x(cliffAt)}
            x2={x(cliffAt)}
            y1={PAD_TOP}
            y2={y(0)}
            stroke="var(--color-warn)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
          <text
            x={x(cliffAt)}
            y={PAD_TOP + 9}
            textAnchor={cliffAt > 0.85 ? "end" : "start"}
            dx={cliffAt > 0.85 ? -4 : 4}
            className="tnum"
            fontSize={9}
            fill="var(--color-warn)"
          >
            {`${Math.round(cliffAt * 100)}%`}
          </text>
        </g>
      )}

      {/* x-axis: where you are in the video. */}
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
        <text
          key={tick}
          x={x(tick)}
          y={H - 6}
          textAnchor={tick === 0 ? "start" : tick === 1 ? "end" : "middle"}
          className="tnum"
          fontSize={9}
          fill="var(--color-muted)"
        >
          {`${tick * 100}%`}
        </text>
      ))}
    </svg>
  );
}
