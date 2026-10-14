"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  anchoredScrollLeft,
  clampZoom,
  contentWidth,
  maxZoom,
  scrollToReveal,
  stepZoom,
  wheelZoom,
  ZOOM_FIT,
} from "@/lib/editor-timeline-view";

/**
 * The timeline's view state: zoom, the snap switch, and the scroll window the
 * strip lives in. TimelineStrip puts `setScroller` on its scroll box and
 * sizes itself with `zoom`; the toolbar and the keyboard shortcuts call
 * zoomIn / zoomOut / fit. Zooming keeps the playhead (or the pointer, for the
 * wheel) where it is on screen.
 */
export interface TimelineView {
  zoom: number;
  maxZoom: number;
  snap: boolean;
  setSnap: (on: boolean) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  setScroller: (el: HTMLDivElement | null) => void;
}

export function useTimelineView({
  total,
  playhead,
}: {
  total: number;
  playhead: number;
}): TimelineView {
  const [zoom, setZoomState] = useState(ZOOM_FIT);
  const [snap, setSnap] = useState(true);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState(0);
  // The zoom the strip was last laid out at, and where to hold it while it changes.
  const laidOut = useRef({ zoom: ZOOM_FIT, width: 0 });
  const anchor = useRef<number | null>(null);
  const live = useRef({ zoom, total, playhead, viewport });
  live.current = { zoom, total, playhead, viewport };
  /** The strip's real width: its own measure (it is at least 44px a clip, so it can be wider than zoom x window), else the formula. */
  const stripWidth = useCallback(
    (el: HTMLElement) => el.scrollWidth || contentWidth(el.clientWidth, live.current.zoom),
    [],
  );

  useEffect(() => {
    if (!scroller) return;
    const read = () => setViewport(scroller.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [scroller]);

  const max = maxZoom(total, viewport);

  /** Where on screen (px from the window's left) the zoom should hold still. */
  const defaultAnchor = useCallback((): number => {
    const el = scroller;
    const { total: tot, playhead: ph } = live.current;
    if (!el || !(tot > 0)) return 0;
    const x = (ph / tot) * stripWidth(el) - el.scrollLeft;
    return x >= 0 && x <= el.clientWidth ? x : el.clientWidth / 2;
  }, [scroller, stripWidth]);

  const setZoom = useCallback(
    (next: number, anchorX?: number) => {
      const { zoom: z, total: tot, viewport: vp } = live.current;
      const c = clampZoom(next, maxZoom(tot, vp));
      if (c === z) return;
      anchor.current = anchorX ?? defaultAnchor();
      // Several wheel events can arrive before React renders: the next one must start from this zoom, not the stale one.
      live.current.zoom = c;
      setZoomState(c);
    },
    [defaultAnchor],
  );

  // After the strip is laid out at the new zoom, put the anchored point back.
  useLayoutEffect(() => {
    const el = scroller;
    if (!el) return;
    const width = stripWidth(el);
    const prev = laidOut.current;
    if (prev.zoom !== zoom && anchor.current !== null && prev.width > 0) {
      el.scrollLeft = anchoredScrollLeft({
        scrollLeft: el.scrollLeft,
        anchorX: anchor.current,
        prevWidth: prev.width,
        nextWidth: width,
      });
    }
    anchor.current = null;
    laidOut.current = { zoom, width };
  }, [zoom, scroller, stripWidth]);

  // A shorter project or a narrower window can lower the ceiling.
  useEffect(() => {
    if (zoom > max) setZoom(max);
  }, [zoom, max, setZoom]);

  // Ctrl / Cmd + wheel (and a trackpad pinch) zooms at the pointer; a plain wheel scrolls as before.
  useEffect(() => {
    const el = scroller;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const { zoom: z, total: tot, viewport: vp } = live.current;
      const rect = el.getBoundingClientRect();
      setZoom(wheelZoom(z, e.deltaY, e.deltaMode, maxZoom(tot, vp)), e.clientX - rect.left);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scroller, setZoom]);

  // A playhead that MOVES out of the window (playing, a step, a drag) is brought back into it.
  // Deliberately not keyed on zoom: a zoom keeps its anchor (the pointer) even when the playhead is off-screen.
  useEffect(() => {
    const el = scroller;
    if (!el || live.current.zoom <= ZOOM_FIT || !(total > 0)) return;
    const contentPx = stripWidth(el);
    const x = (Math.min(playhead, total) / total) * contentPx;
    const left = scrollToReveal({ scrollLeft: el.scrollLeft, viewportPx: el.clientWidth, contentPx, x });
    if (Math.abs(left - el.scrollLeft) > 0.5) el.scrollLeft = left;
  }, [playhead, total, scroller, stripWidth]);

  return {
    zoom,
    maxZoom: max,
    snap,
    setSnap,
    zoomIn: () => setZoom(stepZoom(live.current.zoom, 1, maxZoom(live.current.total, live.current.viewport))),
    zoomOut: () => setZoom(stepZoom(live.current.zoom, -1)),
    fit: () => {
      anchor.current = 0;
      setZoom(ZOOM_FIT, 0);
    },
    setScroller,
  };
}
