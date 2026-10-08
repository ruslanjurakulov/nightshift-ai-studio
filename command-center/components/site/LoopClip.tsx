"use client";

import { useEffect, useRef, useState } from "react";
import { useMotionPaused } from "@/lib/site/motion";
import { CLIPS, type ClipId } from "@/components/site/clip-assets";

type NetworkInformation = { saveData?: boolean; effectiveType?: string };

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
 * A slow, silent, looping camera move over an example still (components/site/samples.tsx CLIPS). The still under it is
 * the poster and stays in the page exactly as it was, so with this component absent, not yet loaded, blocked or
 * switched off the picture is the still and nothing else changes.
 *
 * It follows these rules, each one tested:
 * - never rendered, so never fetched, under prefers-reduced-motion or on Save-Data or a slow connection;
 * - nothing is downloaded until it is wanted: the first screen's clip starts after the page has loaded and gone idle
 *   (so the still, not the clip, is what the page's LCP measures), every other clip when it is within 150 px of the
 *   screen; `preload="none"` until then;
 * - one rendition, chosen when it mounts: 640 x 360 below 860 px of screen, 1280 x 720 above (a `media` attribute on a video's
 *   `source` is not honoured by browsers, so the choice is made here);
 * - muted, looping, inline, no controls, hidden from assistive technology (the still's description covers it); `poster` is the
 *   still itself (the same file the picture under it shows, already in the cache), and the WebM is listed first, the MP4 after it
 *   (a browser takes the first it can play; Safari on a phone takes the MP4);
 * - paused while off screen and while the page's pause switch is pressed (lib/site/motion.ts), and in a hidden tab;
 * - the container's `data-live` says it is playing, which swaps the badge from "Example frame" to "Example clip
 *   (animated still)" and fades the clip in over the still.
 */
export function LoopClip({ clip, poster, early = false }: { clip: ClipId; poster: string; early?: boolean }) {
  const sources = CLIPS[clip];
  const ref = useRef<HTMLVideoElement>(null);
  const paused = useMotionPaused();
  const [allowed, setAllowed] = useState(false);
  // A phone gets the 640 x 360 rendition (about a quarter of the bytes); a screen of 860 px or more the 1280 x 720 one.
  const [small, setSmall] = useState(false);
  const [wanted, setWanted] = useState(false);
  const [onScreen, setOnScreen] = useState(false);

  useEffect(() => {
    if (!clipsAllowed()) return;
    setSmall(!window.matchMedia("(min-width: 860px)").matches);
    setAllowed(true);
  }, []);

  // When the clip may start: the first screen's after load and idle, the rest when they come near the screen.
  useEffect(() => {
    const v = ref.current;
    if (!allowed || !v) return;
    const stops: Array<() => void> = [];
    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), { rootMargin: "150px 0px" });
      io.observe(v);
      stops.push(() => io.disconnect());
    } else {
      setOnScreen(true);
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
  }, [allowed, early]);

  // Play only while wanted, on screen, not paused by the visitor and with the tab showing.
  useEffect(() => {
    const v = ref.current;
    if (!allowed || !v) return;
    const sync = () => {
      if (wanted && onScreen && !paused && document.visibilityState === "visible") void Promise.resolve(v.play()).catch(() => undefined);
      else v.pause();
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [allowed, wanted, onScreen, paused]);

  if (!allowed) return null;
  return (
    <video ref={ref} className="nx-clip" muted loop playsInline preload="none" poster={poster} disablePictureInPicture aria-hidden tabIndex={-1}>
      <source src={small ? sources.smWebm : sources.webm} type="video/webm" />
      <source src={small ? sources.smMp4 : sources.mp4} type="video/mp4" />
    </video>
  );
}
