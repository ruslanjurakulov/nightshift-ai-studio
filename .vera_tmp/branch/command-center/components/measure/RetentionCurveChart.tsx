/**
 * The channel's averaged retention curve, drawn from real measured points.
 *
 * Deliberately plain: an area under the line, a marked hook window, and a
 * marker where the largest drop begins. The y-axis is pinned to 0-100% rather
 * than to the data's own range, because a curve auto-scaled to its own minimum
 * makes a channel that loses 90% of its audience look identical to one that
 * loses 10%. The line is stretched to the width it has; its axis labels are
 * real text at a readable size (not SVG text that shrinks with the screen).
 * No client JS.
 */
interface Point {
  elapsed: number;
  watch: number;
}

const TICKS = [0, 0.25, 0.5, 0.75, 1];

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// The drawing is 0-100 on both axes, stretched to the box; y runs downward.
const X = (elapsed: number) => clamp01(elapsed) * 100;
const Y = (watch: number) => (1 - clamp01(watch)) * 100;

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

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${X(p.elapsed).toFixed(2)},${Y(p.watch).toFixed(2)}`).join(" ");
  const area = `${line} L${X(points[points.length - 1].elapsed).toFixed(2)},100 L${X(points[0].elapsed).toFixed(2)},100 Z`;

  return (
    <div className="g4-curve">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={label}>
        {TICKS.map((tick) => (
          <line key={tick} x1={0} x2={100} y1={Y(tick)} y2={Y(tick)} stroke="var(--ns-rule)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        {/* The hook window: the span whose retention is the hook's own score. */}
        <rect x={0} y={0} width={X(hookRatio)} height={100} fill="var(--ns-act)" opacity={0.1} />
        <path d={area} fill="var(--ns-act)" opacity={0.14} />
        <path d={line} fill="none" stroke="var(--ns-act)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {cliffAt !== null && (
          <line
            x1={X(cliffAt)}
            x2={X(cliffAt)}
            y1={0}
            y2={100}
            stroke="var(--color-warn)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {TICKS.map((tick) => (
        <span key={`y${tick}`} aria-hidden className="g4-curve-y" style={{ bottom: `${tick * 100}%` }}>
          {`${tick * 100}%`}
        </span>
      ))}
      {TICKS.map((tick) => (
        <span
          key={`x${tick}`}
          aria-hidden
          className="g4-curve-x"
          data-edge={tick === 0 ? "start" : tick === 1 ? "end" : undefined}
          style={{ left: `${tick * 100}%` }}
        >
          {`${tick * 100}%`}
        </span>
      ))}
      {cliffAt !== null && (
        <span aria-hidden className="g4-curve-cliff" style={cliffAt > 0.85 ? { right: `${(1 - cliffAt) * 100}%`, transform: "translate(-6px, 0)" } : { left: `${cliffAt * 100}%` }}>
          {`${Math.round(cliffAt * 100)}%`}
        </span>
      )}
    </div>
  );
}
