/**
 * Speed ramps, the arithmetic (the twin of modules/speed_ramp.py): a clip's
 * speed moves linearly between a few points over its source range, so the
 * source time `t` is shown at output time `T(t) = integral(du / speed(u))`, in
 * closed form per linear piece. Pure and import-free so the document
 * validator, the model and the tests read the same numbers as the render.
 */

/** (source seconds from the range's start, speed). */
export type RampPoint = [number, number];

/** Below this a piece counts as constant speed (the log form divides by k). */
const FLAT = 1e-6;

/** `(at, speed)` with `at` a fraction of the range -> source seconds. */
export function rampAbsolute(
  points: readonly { at: number; speed: number }[],
  rangeS: number,
): RampPoint[] {
  return points.map((p) => [p.at * rangeS, p.speed]);
}

function pieceLength(t0: number, s0: number, t1: number, s1: number): number {
  if (Math.abs(s1 - s0) < FLAT) return (t1 - t0) / s0;
  return ((t1 - t0) / (s1 - s0)) * Math.log(s1 / s0);
}

/** How long the whole range lasts at the ramp's speeds, in seconds. */
export function rampOutLength(pts: readonly RampPoint[]): number {
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i += 1)
    total += pieceLength(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
  return total;
}

/** The output time at which source time `t` is shown. */
export function rampOutTime(pts: readonly RampPoint[], t: number): number {
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const [t0, s0] = pts[i];
    const [t1, s1] = pts[i + 1];
    if (t <= t1) {
      const s = s0 + ((s1 - s0) * (t - t0)) / (t1 - t0);
      return acc + pieceLength(t0, s0, t, s);
    }
    acc += pieceLength(t0, s0, t1, s1);
  }
  return acc;
}

/** The source time shown at output time `u` (the inverse of rampOutTime). */
export function rampSourceAt(pts: readonly RampPoint[], u: number): number {
  const end = pts[pts.length - 1][0];
  if (u <= 0) return pts[0][0];
  if (u >= rampOutLength(pts)) return end;
  let lo = pts[0][0];
  let hi = end;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (rampOutTime(pts, mid) < u) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
