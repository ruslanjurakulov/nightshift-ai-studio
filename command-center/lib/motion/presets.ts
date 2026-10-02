/**
 * The motion kit's behaviour as plain data: each function takes `reduced`
 * (the person asked their system for less motion) and returns the props a
 * Motion `m.*` element is given. Kept pure, out of the components, so the
 * contract is testable without a browser:
 *
 *   reduced → `{}` — no initial state, no target, no gesture, no exit, no
 *   layout. The element renders in its final state and every change is
 *   instant. Nothing moves, nothing fades.
 *
 * Every non-reduced value animates `opacity` and transforms (`x`, `y`,
 * `scale`) only, so it runs on the compositor and can never shift layout.
 */
import type { MotionProps, Transition } from "motion/react";
import {
  DISTANCE,
  DURATION,
  EASE,
  LAMP_STRIKE,
  LOADING_GRACE,
  PRESS_SCALE,
  SPRING,
  STAGGER,
  staggerDelay,
} from "./tokens";

/** The subset of Motion props the kit hands out. */
export type MotionBits = Pick<
  MotionProps,
  "initial" | "animate" | "exit" | "whileInView" | "whileTap" | "viewport" | "transition" | "variants" | "layoutId" | "custom"
>;

const NONE: MotionBits = Object.freeze({}) as MotionBits;

const enterTransition = (delay = 0): Transition => ({
  duration: DURATION.enter,
  ease: EASE.standard,
  ...(delay ? { delay } : {}),
});

export type RevealTrigger = "inView" | "mount";

/**
 * A block arriving. `inView` reveals once, when a fifth of it scrolls into
 * view (SSR renders it at its start state; motion.css shows it anyway to
 * reduced-motion and no-script readers). `mount` plays when the element mounts
 * on the client; `enter: false` (it was server-rendered and is being
 * hydrated) means it is already where it belongs and nothing plays.
 */
export function revealProps(
  reduced: boolean,
  {
    trigger = "inView",
    delay = 0,
    distance = DISTANCE.rise,
    enter = true,
  }: { trigger?: RevealTrigger; delay?: number; distance?: number; enter?: boolean } = {},
): MotionBits {
  if (reduced) return NONE;
  const hidden = { opacity: 0, y: Math.min(distance, DISTANCE.sheet) };
  const shown = { opacity: 1, y: 0 };
  if (trigger === "mount") {
    if (!enter) return NONE;
    return { initial: hidden, animate: shown, transition: enterTransition(delay) };
  }
  return {
    initial: hidden,
    whileInView: shown,
    viewport: { once: true, amount: 0.2 },
    transition: enterTransition(delay),
  };
}

/** The container of a staggered group: it only carries the variant labels down. */
export function staggerGroupProps(
  reduced: boolean,
  { trigger = "inView", enter = true }: { trigger?: RevealTrigger; enter?: boolean } = {},
): MotionBits {
  if (reduced) return NONE;
  if (trigger === "mount") {
    if (!enter) return NONE;
    return { initial: "hidden", animate: "shown" };
  }
  return { initial: "hidden", whileInView: "shown", viewport: { once: true, amount: 0.2 } };
}

/** One member of a staggered group: prints `index`th in reading order (capped). */
export function staggerItemProps(
  reduced: boolean,
  index: number,
  { distance = DISTANCE.rise, step }: { distance?: number; step?: number } = {},
): MotionBits {
  if (reduced) return NONE;
  // A custom step (word-by-word text) is finer, so it may run twice as many
  // members before they all start together.
  const delay =
    step === undefined
      ? staggerDelay(index)
      : Number((Math.max(0, Math.min(index, STAGGER.cap * 2)) * step).toFixed(3));
  return {
    custom: index,
    variants: {
      hidden: { opacity: 0, y: Math.min(distance, DISTANCE.sheet) },
      shown: { opacity: 1, y: 0, transition: enterTransition(delay) },
    },
  };
}

export type PresenceKind = "popover" | "sheet" | "toast" | "fade";

/**
 * Something that opens and closes. It comes from its own edge on the enter
 * duration and leaves faster than it came (exit on the tap duration, easing
 * away), so a closed thing is gone before the eye follows it.
 */
export function presenceProps(reduced: boolean, kind: PresenceKind = "fade"): MotionBits {
  if (reduced) return NONE;
  const from: Record<PresenceKind, Record<string, number>> = {
    popover: { opacity: 0, y: -DISTANCE.nudge },
    sheet: { opacity: 0, y: DISTANCE.sheet },
    toast: { opacity: 0, y: DISTANCE.rise },
    fade: { opacity: 0 },
  };
  const at = Object.fromEntries(Object.keys(from[kind]).map((k) => [k, k === "opacity" ? 1 : 0]));
  return {
    initial: from[kind],
    animate: at,
    exit: { ...from[kind], transition: { duration: DURATION.tap, ease: EASE.exit } },
    transition: kind === "sheet" ? SPRING.sheet : { duration: DURATION.state, ease: EASE.standard },
  };
}

/** A key that gives when pressed. Prefer the `.ns-press` CSS class on plain elements. */
export function pressProps(reduced: boolean): MotionBits {
  if (reduced) return NONE;
  return { whileTap: { scale: PRESS_SCALE }, transition: SPRING.key };
}

/**
 * The selection plate shared between rows (nav, segmented keys, tabs): one
 * plate per `id`, which slides along its rail to the row now current. Reduced:
 * no shared id, so the plate is simply drawn under the new row.
 */
export function plateProps(reduced: boolean, id: string): MotionBits {
  if (reduced) return NONE;
  return { layoutId: id, transition: SPRING.plate };
}

/**
 * A lamp whose state just changed strikes once and holds. `changed` is false on
 * the first render: a lamp that was already on when the page loaded does not
 * announce itself.
 */
export function lampStrikeProps(reduced: boolean, changed: boolean): MotionBits {
  if (reduced || !changed) return NONE;
  return {
    initial: { scale: 1, opacity: 0.4 },
    animate: { scale: [...LAMP_STRIKE], opacity: 1 },
    transition: { duration: DURATION.state, ease: EASE.standard, times: [0, 0.35, 1] },
  };
}

/** A screen arriving after a client navigation; never on the server-rendered first paint. */
export function pageEnterProps(reduced: boolean, enter: boolean): MotionBits {
  return revealProps(reduced, { trigger: "mount", enter, distance: DISTANCE.rise });
}

/**
 * A loading placeholder waits out a short grace period before it shows, so a
 * fast route swaps straight to its content instead of flashing grey blocks.
 */
export function loadingGraceProps(reduced: boolean): MotionBits {
  if (reduced) return NONE;
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { delay: LOADING_GRACE, duration: DURATION.tap, ease: EASE.standard },
  };
}

/** True when a props object would animate anything at all (used by tests and dev checks). */
export function hasMotion(bits: MotionBits): boolean {
  return Object.keys(bits).length > 0;
}
