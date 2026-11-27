"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useClipsHeld } from "@/lib/site/clip-hold";

/**
 * Which of the page's videos may play right now: every loop (components/site/LoopClip.tsx) and the landing's sample players (the
 * carousel, the picture-to-video slider, the prompt ticker) bid here, in one store.
 *
 * Every clip that is meaningfully on screen plays. The page used to let one LoopClip and one player play on a phone, so every
 * other clip on screen held a still and read as frozen (the owner's report of 2026-11-14; a scroll through the landing at
 * 390 x 844 found 13 clips on screen and stopped). "On screen" is SHOW_RATIO of the clip, or that much of the screen for a clip
 * taller than it.
 *
 * The cap is a safety net sized from measurement, not a budget that is expected to bind: the densest landing screen shows 3 clips
 * at once at 390 x 844 and 6 at 1440 x 900 (each at least 35% visible), and the caps are above both. When it does bind (a denser
 * page, a zoomed-out window), the clips past it show their poster, never a stopped frame (LoopClip drops `data-live`), and the
 * ones most on screen are the ones that play.
 *
 * It answers to the page's other holds: the visitor's pause switch (lib/site/motion.ts) and a hidden tab come in through each
 * caller's `want`, and the Shorts feed's hold (lib/site/clip-hold.ts) is applied here, so while the feed is open over the page
 * nothing under it has a turn and only the feed's clip decodes.
 */
export const SHOW_RATIO = 0.35;
/**
 * The caps, from measurement (2026-11-14, headless Chrome with software compositing on a shared 4-core box, so a pessimistic floor,
 * the heaviest clip-sm files looping, 5 s windows, median of 3):
 * - 390 x 844 at 4x CPU throttling: one clip keeps the page at 60 fps; two, four, six and eight all hold about 30 fps (the
 *   second video costs the frame rate, the later ones do not), with the clips presenting 100%, 96%, 92% and 88% of their 24 fps
 *   frames. The densest phone screen shows 3, so 6 covers it twice over.
 * - 1440 x 900 unthrottled: six and eight clips present 95% and 88% of their frames; at ten it falls to 54%. The densest wide
 *   screen shows 6.
 * At most 6 on any screen (2026-11-22, measured against competitors' galleries by the lead): 6 is the densest wide screen and the
 * best-presenting count measured above, so nothing that is on screen today stops, and a denser screen (a zoomed-out window) never
 * decodes more. A 7th clip that comes into view takes a turn only from one less in view than itself.
 */
export const PHONE_TURNS = 6;
export const WIDE_TURNS = 6;
/** How far ahead of the screen a clip starts to load, so it is already moving when it is seen (half a screen down, a quarter across). */
export const NEAR_MARGIN = "50% 25%";

export type Bid = { ratio: number; want: boolean };

/**
 * The players that get a turn: those that want one and show at least SHOW_RATIO, most on screen first, `cap` of them. On a tie the
 * ones already playing (`holding`) keep their turn, so a newcomer as much in view as they are waits instead of stopping one
 * mid-loop (and two equal clips never swap turns back and forth on every observer callback).
 */
export function pickTurns<K>(bids: ReadonlyMap<K, Bid>, cap: number, holding: ReadonlySet<K> = new Set()): Set<K> {
  const ranked = [...bids]
    .filter(([, b]) => b.want && b.ratio >= SHOW_RATIO)
    .sort((a, b) => b[1].ratio - a[1].ratio || Number(holding.has(b[0])) - Number(holding.has(a[0])));
  return new Set(ranked.slice(0, Math.max(0, cap)).map(([k]) => k));
}

/**
 * How much of an element is on screen, for the turn: its own share, or the share of the screen it covers when it is too tall to
 * show SHOW_RATIO of itself at all (a bleed behind a first screen would otherwise never play).
 */
export function shownRatio(e: Pick<IntersectionObserverEntry, "intersectionRatio" | "isIntersecting"> & Partial<Pick<IntersectionObserverEntry, "intersectionRect" | "rootBounds">>): number {
  const own = typeof e.intersectionRatio === "number" ? e.intersectionRatio : e.isIntersecting ? 1 : 0;
  const r = e.rootBounds;
  const i = e.intersectionRect;
  const cover = r && i && r.width > 0 && r.height > 0 ? (i.width * i.height) / (r.width * r.height) : 0;
  return Math.max(own, cover);
}

const bids = new Map<symbol, Bid>();
let granted: ReadonlySet<symbol> = new Set();
const listeners = new Set<() => void>();

function settle() {
  const phone = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches;
  const next = pickTurns(bids, phone ? PHONE_TURNS : WIDE_TURNS, granted);
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
 * paused, the tab showing), with how much of the box is on screen. False on the server and until the observer has measured the box.
 * `ready` is false while the box is not in the page yet (a LoopClip renders its video only once it knows clips are allowed).
 */
export function useClipTurn(box: RefObject<Element | null>, want: boolean, ready = true): boolean {
  const id = useRef<symbol | null>(null);
  if (!id.current) id.current = Symbol("player");
  const me = id.current;
  const has = useSyncExternalStore(subscribe, () => granted.has(me), () => false);
  const held = useClipsHeld();

  useEffect(() => {
    const el = box.current;
    if (!ready || !el) return;
    bids.set(me, { ratio: 0, want: bids.get(me)?.want ?? false });
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        ([e]) => {
          const b = bids.get(me);
          if (!b) return;
          b.ratio = shownRatio(e);
          settle();
        },
        { threshold: [0, 0.05, 0.1, 0.2, SHOW_RATIO, 0.5, 0.75, 1] },
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
  }, [box, me, ready]);

  useEffect(() => {
    const b = bids.get(me);
    if (b) b.want = want;
    else bids.set(me, { ratio: 0, want });
    settle();
  }, [want, me]);

  return has && !held;
}

/**
 * Whether the box is within NEAR_MARGIN of the screen: the moment to start loading its clip, so the first frames are buffered
 * before it shows enough of itself to play. Always false without an IntersectionObserver: nothing can tell what is near, so
 * nothing is fetched ahead, and a clip loads when it plays (useClipTurn then counts every box as on screen).
 */
export function useClipNear(box: RefObject<Element | null>, ready = true): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!ready || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: NEAR_MARGIN, threshold: 0 });
    io.observe(el);
    return () => {
      io.disconnect();
      setNear(false);
    };
  }, [box, ready]);
  return near;
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
