"use client";

import { useEffect, useRef } from "react";
import { useMotionPaused } from "@/lib/site/motion";
import { usePageVisible } from "@/components/site/clip-turns";

/** About 14 frames a second: an 80 x 50 picture needs no more, and the hero's clip is the page's real cost, not this. */
export const THUMB_FRAME_MS = 72;

/** One axis of a CSS object-position ("70%", "center", "left"...) as a 0..1 share; anything else (a length) is the centre. */
function share(v: string | undefined): number {
  if (!v) return 0.5;
  if (v.endsWith("%")) {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 0.5;
  }
  if (v === "left" || v === "top") return 0;
  if (v === "right" || v === "bottom") return 1;
  return 0.5;
}

/**
 * The source rectangle that covers a `cw` x `ch` canvas from a `vw` x `vh` frame, anchored where the hero anchors its own crop
 * (its object-position), so the thumbnail is cut the way the background is and never stretched.
 */
export function coverRect(vw: number, vh: number, cw: number, ch: number, position = "50% 50%"): [number, number, number, number] {
  const scale = Math.max(cw / vw, ch / vh);
  const sw = cw / scale;
  const sh = ch / scale;
  const [px, py] = position.trim().split(/\s+/);
  return [(vw - sw) * share(px), (vh - sh) * share(py ?? px), sw, sh];
}

/**
 * The idea bar's thumbnail (components/landing/home/IdeaBox.tsx): the hero's own picture, the moment the hero shows it. The owner
 * saw the bar hold the orbit still while the clip behind it had reached the night street (2026-11-22); kling.ai's bar shows the
 * same frame as its background, and so does this one now.
 *
 * - Before the clip plays, and whenever it never does (reduced motion, Save-Data, a slow link, no script), it is the hero's still:
 *   the same small rendition, as a background, so the bar adds no image element and the page's picture and sample counts are unchanged.
 * - While the hero's clip is live (LoopClip's `data-live` on `#{mirror}`), a canvas over that still copies the hero's own video
 *   element: no second download, and the two cannot drift apart. When the hero goes back to its still (a stall, off screen), so
 *   does the thumbnail; under the page's holds (the pause switch, a hidden tab) both keep the frame they stopped on.
 * - It draws only while there is something new to show: the clip playing, this bar on screen, the tab visible, motion not paused,
 *   reduced motion not asked for. Nothing is ever read back from the canvas (no getImageData, toDataURL or toBlob): drawing a
 *   video only paints, and a read-back is what a cross-origin file would refuse and what nothing here needs.
 * - The box has its size from home.css whatever is inside it, so the bar is the same with and without script (CLS 0).
 */
export function HeroThumb({ still, mirror }: { still: string; mirror?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paused = useMotionPaused();
  const visible = usePageVisible();
  // The page's holds, read by the drawing loop without tearing its observers down and back up.
  const holds = useRef({ paused, visible });
  const update = useRef<() => void>(() => undefined);

  useEffect(() => {
    holds.current = { paused, visible };
    update.current();
  }, [paused, visible]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const thumb = canvas?.parentElement;
    const box = mirror ? document.getElementById(mirror) : null;
    if (!canvas || !thumb || !box) return;
    // Reduced motion: LoopClip never mounts a clip, and this never starts a loop; the still is the whole picture.
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Asked for only when there is a frame to draw: a page whose clip never comes never makes a drawing context at all.
    let ctx: CanvasRenderingContext2D | null = null;

    let onScreen = typeof IntersectionObserver === "undefined";
    let timer = 0;
    // Whether the canvas holds a frame of the clip that is in the box now: a new video element (or a new file in it) starts blank.
    let drawn = false;
    let video: HTMLVideoElement | null = null;
    let position = "50% 50%";

    const draw = () => {
      const v = video;
      // HAVE_CURRENT_DATA: before it, drawImage paints nothing and the thumbnail would cover the still with an empty box.
      if (!v || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return;
      ctx ??= canvas.getContext("2d");
      if (!ctx) return;
      const r = thumb.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(r.width * dpr);
        const h = Math.round(r.height * dpr);
        // Resizing clears the canvas, so only when the bar's media query really changed its size.
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
      }
      const [sx, sy, sw, sh] = coverRect(v.videoWidth, v.videoHeight, canvas.width, canvas.height, position);
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      drawn = true;
      show();
    };

    const show = () => {
      if (drawn && box.getAttribute("data-live") === "true") thumb.setAttribute("data-live", "true");
      else thumb.removeAttribute("data-live");
    };

    const stop = () => {
      window.clearInterval(timer);
      timer = 0;
    };

    const sync = () => {
      const found = box.querySelector("video");
      if (found !== video) {
        video = found;
        drawn = false;
        position = found ? getComputedStyle(found).objectPosition || "50% 50%" : "50% 50%";
      }
      const live = box.getAttribute("data-live") === "true";
      const { paused: held, visible: shown } = holds.current;
      const run = !!video && live && !video.paused && !video.ended && onScreen && shown && !held;
      if (run && !timer) {
        // The first frame at once: a clip held right after it began still leaves its frame here, as it does behind the bar.
        draw();
        timer = window.setInterval(draw, THUMB_FRAME_MS);
      } else if (!run && timer) stop();
      show();
    };
    update.current = sync;

    // Media events do not bubble, but they are seen on the way down: one capturing listener on the box hears whichever video element
    // LoopClip puts there, including one that mounts after this.
    const events = ["playing", "pause", "ended", "emptied", "loadeddata"] as const;
    const onMedia = (e: Event) => {
      if (e.type === "emptied") drawn = false;
      sync();
    };
    events.forEach((t) => box.addEventListener(t, onMedia, true));
    const mo = new MutationObserver(sync);
    mo.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-live"] });
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        sync();
      });
      io.observe(thumb);
    }
    sync();

    return () => {
      stop();
      update.current = () => undefined;
      events.forEach((t) => box.removeEventListener(t, onMedia, true));
      mo.disconnect();
      io?.disconnect();
      thumb.removeAttribute("data-live");
    };
  }, [mirror]);

  return (
    // The hero's own still (its small rendition, the one a phone's first screen already loads), as a background: an echo of the
    // picture behind the bar, not a sample in its own box, so it is not one of the page's labelled image elements.
    <span className="hm-idea-thumb" aria-hidden="true" style={{ backgroundImage: `url("${still}")` }}>
      {mirror ? <canvas ref={canvasRef} className="hm-idea-thumb-live" width={160} height={100} /> : null}
    </span>
  );
}
