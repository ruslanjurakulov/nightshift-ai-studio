"use client";

import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";

/**
 * Which of the landing's sample players (the carousel, the picture-to-video slider, the prompt ticker) may play right now.
 *
 * A throttled phone loses half its frames to a second decoding video (LoopClip measured it), and the page's own LoopClip already
 * plays one clip there (its leader). So on a phone these players share ONE turn between them, and the page never decodes more than
 * two videos at once; from a tablet up they share three. The turn goes to the players that want to play and show most of
 * themselves (at least a fifth); the rest hold their still. Pure arithmetic in `pickTurns`, the store around it below.
 */
export const PHONE_TURNS = 1;
export const WIDE_TURNS = 3;

export type Bid = { ratio: number; want: boolean };

/** The players that get a turn: those that want one and are at least a fifth on screen, most on screen first, `cap` of them. */
export function pickTurns<K>(bids: ReadonlyMap<K, Bid>, cap: number): Set<K> {
  const ranked = [...bids].filter(([, b]) => b.want && b.ratio >= 0.2).sort((a, b) => b[1].ratio - a[1].ratio);
  return new Set(ranked.slice(0, Math.max(0, cap)).map(([k]) => k));
}

const bids = new Map<symbol, Bid>();
let granted: ReadonlySet<symbol> = new Set();
const listeners = new Set<() => void>();

function settle() {
  const phone = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches;
  const next = pickTurns(bids, phone ? PHONE_TURNS : WIDE_TURNS);
  if (next.size === granted.size && [...next].every((k) => granted.has(k))) return;
  granted = next;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/**
 * Whether the player whose box is `box` may play. It bids while `want` is true (the caller decides: not under reduced motion, not
 * paused), with how much of the box is on screen. False on the server and until the observer has measured the box.
 */
export function useClipTurn(box: RefObject<Element | null>, want: boolean): boolean {
  const id = useRef<symbol | null>(null);
  if (!id.current) id.current = Symbol("player");
  const me = id.current;
  const has = useSyncExternalStore(subscribe, () => granted.has(me), () => false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    bids.set(me, { ratio: 0, want: bids.get(me)?.want ?? false });
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        ([e]) => {
          const b = bids.get(me);
          if (!b) return;
          b.ratio = e.intersectionRatio ?? (e.isIntersecting ? 1 : 0);
          settle();
        },
        { threshold: [0, 0.2, 0.4, 0.6, 0.8, 1] },
      );
      io.observe(el);
    } else {
      bids.get(me)!.ratio = 1;
      settle();
    }
    const onResize = () => settle();
    window.addEventListener("resize", onResize);
    return () => {
      io?.disconnect();
      window.removeEventListener("resize", onResize);
      bids.delete(me);
      settle();
    };
  }, [box, me]);

  useEffect(() => {
    const b = bids.get(me);
    if (b) b.want = want;
    else bids.set(me, { ratio: 0, want });
    settle();
  }, [want, me]);

  return has;
}

/** Whether the visitor asked for reduced motion, following the setting live. False on the server. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (l) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
      const q = window.matchMedia("(prefers-reduced-motion: reduce)");
      q.addEventListener?.("change", l);
      return () => q.removeEventListener?.("change", l);
    },
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

/** Whether the tab is showing (a hidden tab plays nothing and advances nothing). True on the server. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    (l) => {
      document.addEventListener("visibilitychange", l);
      return () => document.removeEventListener("visibilitychange", l);
    },
    () => document.visibilityState === "visible",
    () => true,
  );
}
