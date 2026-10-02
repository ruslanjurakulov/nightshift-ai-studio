"use client";

import { useState, useSyncExternalStore } from "react";
import { useMotionEngine } from "./engine";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener?.("change", onChange);
  return () => mq.removeEventListener?.("change", onChange);
}

function readReduced(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

/**
 * Has the person asked their system for less motion? Live (follows a change
 * of the setting) and hydration-safe: the server and the hydrating render both
 * read `false`, so the markup matches, and React re-renders with the real
 * answer straight after. During that one frame, motion.css's reduced-motion
 * rule already holds every kit element at its final state, so nothing moves.
 *
 * Use this instead of Motion's own `useReducedMotion`, whose first client
 * render can differ from the server's and so mismatch on hydration.
 */
export function useReducedMotionSafe(): boolean {
  return useSyncExternalStore(subscribeReduced, readReduced, () => false);
}

const noopSubscribe = () => () => {};

/**
 * True when this component mounted on the client after the page was already
 * running (a client navigation, a panel opened, a row added); false when it
 * was server-rendered and is being hydrated. Read once, at mount.
 *
 * This is what keeps entrances honest: the first paint of a page is the
 * browser's own arrival and must never wait on JavaScript (no hidden content,
 * no LCP delay); a screen reached by a click, which has no such arrival, is
 * the one that gets an entrance.
 */
export function useFreshMount(): boolean {
  const client = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [fresh] = useState(client);
  return fresh;
}

/**
 * Should this kit element be drawn at rest, with no animation at all? Yes when
 * the reader asked for less motion, when there is no <MotionProvider> above
 * it, when the engine failed to load, and when the element mounts on the
 * client before the engine has arrived (it would otherwise sit at its start
 * state, invisible, until the bundle lands). Server-rendered start states may
 * wait for a pending engine: if it then fails, motion.css shows them.
 */
export function useStill(): boolean {
  const reduced = useReducedMotionSafe();
  const engine = useMotionEngine();
  const fresh = useFreshMount();
  return reduced || engine === "absent" || engine === "failed" || (engine === "pending" && fresh);
}
