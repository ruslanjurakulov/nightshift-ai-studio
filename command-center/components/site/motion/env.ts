/**
 * The three questions every effect in components/site/motion asks before it moves anything. They are read at the moment of
 * use, never cached at import: the visitor can press "Pause motion" (lib/site/motion.ts, html[data-motion="paused"]) or change
 * the system setting while the page is open, and an effect that read them once would keep moving after being told to stop.
 */

function query(q: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(q).matches;
}

/** The system asks for less motion: nothing in this folder moves at all. */
export function prefersReduced(): boolean {
  return query("(prefers-reduced-motion: reduce)");
}

/** The page's own pause switch is pressed (MotionToggle, ClipPause). */
export function motionPaused(): boolean {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-motion") === "paused";
}

/**
 * A mouse or trackpad on a wide screen. The pointer-follow effects (magnetic keys, the hero's parallax, the explore grid's
 * spotlight) are for this case only: a phone gets the light version, and a touch tap must never leave a key pulled aside.
 */
export function richPointer(): boolean {
  return query("(hover: hover) and (pointer: fine) and (min-width: 1024px)");
}

/** The system's forced colours (Windows High Contrast): nothing may draw its own colours over the page's text. */
export function forcedColors(): boolean {
  return query("(forced-colors: active)");
}

/** Motion may run now: allowed by the system and not paused by the visitor. */
export function motionAllowed(): boolean {
  return !prefersReduced() && !motionPaused();
}
