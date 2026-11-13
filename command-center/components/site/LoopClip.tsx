"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useMotionPaused } from "@/lib/site/motion";
import { CLIPS, type ClipId } from "@/components/site/clip-assets";
import { clipRendition } from "@/lib/site/renditions";

type NetworkInformation = { saveData?: boolean; effectiveType?: string };

/** The four renditions of one loop: 1280 and 640 wide, each in WebM and MP4; and a larger one only where the source was larger (never an upscale). */
export type ClipSources = { mp4: string; webm: string; smMp4: string; smWebm: string; lg?: { mp4: string; webm: string } };

/** Whether a clip may be fetched and played at all: never under reduced motion, never on Save-Data or a slow link. */
function clipsAllowed(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const c = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (c?.saveData) return false;
  if (c?.effectiveType && /^(slow-2g|2g|3g)$/.test(c.effectiveType)) return false;
  return true;
}

/**
 * Which clip plays. Two clips playing at once cost a 4x-throttled phone half its frames (a showcase with the next one's edge
 * in view measured 30 fps against 60 with one playing), so only the clip that shows most of itself plays; the others hold
 * their still. Each LoopClip reports how much of itself is on screen; the one with the most (above a sliver) is the leader.
 */
const shown = new Map<symbol, number>();
const listeners = new Set<() => void>();
let leaderId: symbol | null = null;
function setShown(id: symbol, ratio: number) {
  if (ratio > 0.05) shown.set(id, ratio);
  else shown.delete(id);
  let best: symbol | null = null;
  let top = 0;
  for (const [k, r] of shown) if (r > top) [best, top] = [k, r];
  if (best !== leaderId) {
    leaderId = best;
    listeners.forEach((l) => l());
  }
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/**
 * A silent loop of stock footage over its own first frame (components/site/samples.tsx CLIPS; the footage is a Pexels
 * contributor's, credited on the picture). The still under it is the clip's frame 0 and is the poster, and stays in the
 * page exactly as it was, so with this component absent, not yet loaded, blocked or switched off the picture is the
 * still and nothing else changes.
 *
 * It follows these rules, each one tested:
 * - never rendered, so never fetched, under prefers-reduced-motion or on Save-Data or a slow connection;
 * - nothing is downloaded until it is wanted: the first screen's clip starts after the page has loaded and gone idle
 *   (so the still, not the clip, is what the page's LCP measures), every other clip when it is the one most on screen;
 *   `preload="none"` until then; only one clip plays at a time (see `shown` above);
 * - one rendition, chosen when it mounts: 640 x 360 below 860 px of screen or for a frame that is never wider than about 560 px
 *   (`compact`: a small frame on a wide screen does not need the 1280 file and its first-load cost), 1280 x 720 otherwise (a `media` attribute on a video's
 *   `source` is not honoured by browsers, so the choice is made here);
 * - muted, looping, inline, no controls, hidden from assistive technology (the still's description covers it); `poster` is the
 *   still itself at its phone width (the file a phone's picture already shows, so it is usually already in the cache), and the WebM is listed first, the MP4 after it
 *   (a browser takes the first it can play; Safari on a phone takes the MP4);
 * - paused while off screen and while the page's pause switch is pressed (lib/site/motion.ts), and in a hidden tab;
 * - the container's `data-live` says it is playing, which swaps the badge from "Example frame (stock footage)" to "Example clip
 *   (stock footage)" and fades the clip in over the still.
 */
export function LoopClip({
  clip,
  sources: own,
  poster,
  early = false,
  position,
  compact = false,
  together = false,
}: {
  poster: string;
  early?: boolean;
  position?: string;
  compact?: boolean;
  /**
   * A grid of small loops (the gallery): on a screen of 860 px or more, each one plays while at least a quarter of it is in
   * view, as an explore grid does, instead of only the one clip most on screen. Each is the 640 px file (`compact`). On a phone
   * it is one clip at a time as everywhere else, because two at once cost a throttled phone half its frames.
   */
  together?: boolean;
} & (
  | { clip: ClipId; sources?: undefined }
  /** A model sample's own files (components/site/showcase-assets.ts, read by ShowcaseClip): the same rules, other files. */
  | { clip?: undefined; sources: ClipSources }
)) {
  const sources: ClipSources = own ?? CLIPS[clip as ClipId];
  const ref = useRef<HTMLVideoElement>(null);
  const paused = useMotionPaused();
  const [allowed, setAllowed] = useState(false);
  // A phone gets the 640 x 360 rendition (about a quarter of the bytes); a screen of 860 px or more the 1280 x 720 one, and a
  // sample with a larger file (`sources.lg`) that one on a screen with the pixels for it (lib/site/renditions.ts).
  const [size, setSize] = useState<"sm" | "md" | "lg">("md");
  const [wanted, setWanted] = useState(false);
  // In a grid on a wide screen (`together`): whether this clip shows enough of itself to play, whichever clip leads.
  const [grid, setGrid] = useState(false);
  const [inView, setInView] = useState(false);
  const id = useRef<symbol>(null as unknown as symbol);
  if (!id.current) id.current = Symbol("clip");
  // Whether this clip is the one that shows most of itself right now.
  const lead = useSyncExternalStore(subscribe, () => leaderId === id.current, () => false);

  useEffect(() => {
    if (!clipsAllowed()) return;
    const wide = window.matchMedia("(min-width: 860px)").matches;
    const c = (navigator as Navigator & { connection?: NetworkInformation }).connection;
    setSize(
      clipRendition({
        small: compact || together || !wide,
        hasLarge: Boolean(sources.lg),
        devicePixels: window.innerWidth * (window.devicePixelRatio || 1),
        fast: !c?.effectiveType || c.effectiveType === "4g",
      }),
    );
    setGrid(together && wide);
    setAllowed(true);
  }, [compact, together, sources.lg]);

  // When the clip may start: the first screen's after load and idle, the rest when they come near the screen.
  useEffect(() => {
    const v = ref.current;
    if (!allowed || !v) return;
    const stops: Array<() => void> = [];
    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver(
        ([e]) => {
          const ratio = e.intersectionRatio ?? (e.isIntersecting ? 1 : 0);
          // A grid clip never takes the lead from the page's one big clip: it only plays while it is itself in view.
          if (grid) setInView(ratio >= 0.25);
          else setShown(id.current, ratio);
        },
        { threshold: [0, 0.05, 0.1, 0.25, 0.5, 0.75, 1] },
      );
      io.observe(v);
      stops.push(() => {
        io.disconnect();
        if (grid) setInView(false);
        else setShown(id.current, 0);
      });
    } else if (grid) {
      setInView(true);
    } else {
      setShown(id.current, 1);
    }
    if (early) {
      let timer = 0;
      const go = () => {
        const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
        if (idle) idle(() => setWanted(true), { timeout: 2000 });
        else timer = window.setTimeout(() => setWanted(true), 1200);
      };
      if (document.readyState === "complete") go();
      else window.addEventListener("load", go, { once: true });
      stops.push(() => {
        window.removeEventListener("load", go);
        window.clearTimeout(timer);
      });
    } else {
      setWanted(true);
    }
    const mark = () => v.parentElement?.setAttribute("data-live", "true");
    v.addEventListener("playing", mark);
    stops.push(() => v.removeEventListener("playing", mark));
    return () => stops.forEach((s) => s());
  }, [allowed, early, grid]);

  // Play only while wanted, on screen, not paused by the visitor and with the tab showing.
  useEffect(() => {
    const v = ref.current;
    if (!allowed || !v) return;
    const sync = () => {
      if (wanted && (grid ? inView : lead) && !paused && document.visibilityState === "visible") void Promise.resolve(v.play()).catch(() => undefined);
      else v.pause();
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [allowed, wanted, lead, paused, grid, inView]);

  if (!allowed) return null;
  return (
    <video ref={ref} className="nx-clip" muted loop playsInline preload="none" poster={poster} disablePictureInPicture aria-hidden tabIndex={-1} style={position ? { objectPosition: position } : undefined}>
      <source src={size === "sm" ? sources.smWebm : size === "lg" && sources.lg ? sources.lg.webm : sources.webm} type="video/webm" />
      <source src={size === "sm" ? sources.smMp4 : size === "lg" && sources.lg ? sources.lg.mp4 : sources.mp4} type="video/mp4" />
    </video>
  );
}
