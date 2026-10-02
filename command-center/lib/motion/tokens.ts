/**
 * Nightshift motion tokens: the "Master control, 03:00" identity in time.
 *
 * The room is a broadcast console, so things move the way a console's parts
 * do: a relay switches, a selector plate slides along its rail, a lamp strikes
 * and then holds, a sheet of proofs comes up from the tray. Nothing floats,
 * nothing bounces, nothing moves for mood (docs/design/IDENTITY.md §Motion,
 * docs/design/MOTION.md for the language and the recipes).
 *
 * Every value here mirrors a CSS token in app/globals.css where one exists
 * (`--ns-ease`, `--ns-dur-1..3`), and tests/motion-kit.test.tsx holds the two
 * in step. Pure data: safe to import from a Server Component, a test or a
 * script — no React, no DOM.
 */

/** Seconds, because that is what Motion takes. `instant` is the reduced-motion answer. */
export const DURATION = {
  instant: 0,
  /** A key pressed, a hover lit, an exit: the relay's click (`--ns-dur-1`). */
  tap: 0.12,
  /** A state that changed in place: a lamp, a label, a plate (`--ns-dur-2`). */
  state: 0.2,
  /** Something arriving: a sheet, a page, a revealed block (`--ns-dur-3`). */
  enter: 0.32,
  /** The one orchestrated entrance a page may have (the public hero), per item. */
  scene: 0.56,
} as const;

/** Cubic-bezier control points. */
export const EASE = {
  /** `--ns-ease`: fast away from rest, settles hard. The console's default. */
  standard: [0.2, 0, 0, 1],
  /** Leaving: accelerate out of view, nothing lingers. */
  exit: [0.4, 0, 1, 1],
  /** A meter or progress fill that tracks a real quantity. */
  linear: [0, 0, 1, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/**
 * Springs, all critically damped (`bounce: 0`). A spring is used where the
 * motion may be interrupted mid-flight (a plate re-targeted by a second click)
 * and must carry its velocity instead of restarting; a console part never
 * overshoots its detent.
 */
export const SPRING = {
  /** A key or a lamp: quick and dead-beat. */
  key: { type: "spring", visualDuration: DURATION.tap, bounce: 0 },
  /** The selection plate travelling between rows. */
  plate: { type: "spring", visualDuration: 0.24, bounce: 0 },
  /** A sheet or popover settling into place. */
  sheet: { type: "spring", visualDuration: DURATION.enter, bounce: 0 },
} as const;

/** Pixels. Nothing in the app travels further than a sheet's rise. */
export const DISTANCE = {
  /** A popover dropping from the bar that opened it. */
  nudge: 4,
  /** A block or a page arriving. */
  rise: 8,
  /** A sheet or a toast coming up from its edge. */
  sheet: 16,
} as const;

export const STAGGER = {
  /** Seconds between siblings printing in reading order. */
  step: 0.04,
  /** Siblings after this many start together, so a long list never drags. */
  cap: 6,
} as const;

/** A pressed key gives this much; scale only (a transform), never size. */
export const PRESS_SCALE = 0.97;

/** The lamp's strike when its state changes: one beat, then it holds. */
export const LAMP_STRIKE = [1, 1.35, 1] as const;

/** How long a route may take before its loading skeleton is shown at all. */
export const LOADING_GRACE = 0.15;

/** The stagger delay for the `index`th sibling, capped. */
export function staggerDelay(index: number, base = 0): number {
  const i = Math.max(0, Math.min(Math.floor(index), STAGGER.cap));
  return Number((base + i * STAGGER.step).toFixed(3));
}
