/**
 * The credit balance as a VU ladder (IDENTITY.md §Signature devices): lit
 * segments are credits free to spend, hatched ones are credits held for work
 * in progress (the meter's "peak hold"), unlit ones are the rest of the scale.
 *
 * Real data only. The scale is what the caller passes as `max`, or else the
 * balance itself (available + held). Nothing is invented: with no number, or
 * a scale that is not positive, the meter is not drawn at all (CLAUDE.md #5).
 */
export function Meter({
  value,
  held = 0,
  max,
  segments = 12,
  label,
  valueText,
  size = "sm",
  scale,
  className,
}: {
  /** Credits available now. */
  value: number | null | undefined;
  /** Credits on hold for running work. */
  held?: number | null;
  /** Full scale; defaults to value + held (the balance). */
  max?: number | null;
  segments?: number;
  /** What the meter measures, for assistive tech ("Credits"). */
  label: string;
  /** The reading in words ("120 available, 30 on hold"). */
  valueText?: string;
  size?: "sm" | "lg";
  /** The two end readings under a large meter (real numbers, formatted by the caller). */
  scale?: { from: string; to: string };
  className?: string;
}) {
  const reading = meterSegments({ value, held, max, segments });
  if (!reading) return null;
  const cells = [
    ...Array.from({ length: reading.lit }, () => "lit"),
    ...Array.from({ length: reading.held }, () => "held"),
    ...Array.from({ length: reading.off }, () => "off"),
  ];
  return (
    <span className={className} style={size === "lg" ? { display: "block" } : undefined}>
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={reading.max}
        aria-valuenow={reading.value}
        aria-valuetext={valueText}
        className="ns-meter"
        data-size={size}
        data-empty={reading.value <= 0 ? "true" : undefined}
      >
        {cells.map((state, i) => (
          <span key={i} aria-hidden className="ns-meter-seg" data-state={state} />
        ))}
      </span>
      {size === "lg" && scale && (
        <span aria-hidden className="ns-meter-scale">
          <span className="ns-tc">{scale.from}</span>
          <span className="ns-tc">{scale.to}</span>
        </span>
      )}
    </span>
  );
}

/**
 * How many segments are lit, held and off — or null when there is nothing
 * honest to draw. Pure; tested directly.
 *
 * A nonzero amount always lights at least one segment (a balance of 1 out of
 * 10,000 is not "empty"), and a balance short of full never fills the scale.
 */
export function meterSegments({
  value,
  held = 0,
  max,
  segments = 12,
}: {
  value: number | null | undefined;
  held?: number | null;
  max?: number | null;
  segments?: number;
}): { lit: number; held: number; off: number; value: number; max: number } | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const hold = typeof held === "number" && Number.isFinite(held) && held > 0 ? held : 0;
  const v = Math.max(0, value);
  const scaleMax = typeof max === "number" && Number.isFinite(max) ? max : v + hold;
  const n = Math.max(1, Math.floor(segments));
  if (!(scaleMax > 0)) {
    // A balance of exactly nothing is a real reading (an empty meter). A scale
    // the caller gave as zero or less is not: there is nothing to measure.
    if (max == null && v === 0 && hold === 0) return { lit: 0, held: 0, off: n, value: 0, max: 0 };
    return null;
  }
  const toCells = (x: number) => {
    const c = Math.round((Math.min(x, scaleMax) / scaleMax) * n);
    if (x > 0 && c === 0) return 1;
    if (x < scaleMax && c === n) return n - 1;
    return c;
  };
  const lit = toCells(v);
  const upTo = Math.max(lit, toCells(v + hold));
  const heldCells = Math.min(n - lit, upTo - lit);
  return { lit, held: heldCells, off: n - lit - heldCells, value: v, max: scaleMax };
}
