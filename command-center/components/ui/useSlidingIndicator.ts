"use client";

import { useLayoutEffect, type RefObject } from "react";

/** What "the chosen one" looks like on each kind of item this indicator serves. */
const CHOSEN = ['[aria-checked="true"]', '[aria-selected="true"]', '[aria-pressed="true"]', '[aria-current="page"]'];

export type IndicatorBox = { l: number; r: number; t: number; b: number };

/**
 * Where the chosen item sits inside its track, as insets from the track's
 * padding box (the box an absolutely placed ::before is laid out in). Layout
 * offsets, not getBoundingClientRect: a key that is mid-press is scaled, and
 * the plate must land where the key rests, not where it is squeezed to.
 */
export function measureIndicator(track: HTMLElement, items: string): IndicatorBox | null {
  const all = Array.from(track.querySelectorAll<HTMLElement>(items));
  const chosen = all.find((el) => CHOSEN.some((sel) => el.matches(sel)));
  if (!chosen) return null;
  const l = chosen.offsetLeft;
  const t = chosen.offsetTop;
  return {
    l,
    r: track.clientWidth - (l + chosen.offsetWidth),
    t,
    b: track.clientHeight - (t + chosen.offsetHeight),
  };
}

// The last place an indicator stood, per strip. The section tabs are remounted
// on every route change (the [channel] template), so without this the plate
// could only ever appear under the new tab; with it, it starts under the tab
// that was current and travels.
const lastBox = new Map<string, IndicatorBox>();

function apply(track: HTMLElement, box: IndicatorBox) {
  track.style.setProperty("--ns-ind-l", `${box.l}px`);
  track.style.setProperty("--ns-ind-r", `${box.r}px`);
  track.style.setProperty("--ns-ind-t", `${box.t}px`);
  track.style.setProperty("--ns-ind-b", `${box.b}px`);
}

function flushStyle(track: HTMLElement) {
  // A layout read makes the browser resolve the style it has now (the track's
  // pseudo-elements included), so the next write is a change it transitions from.
  void track.offsetWidth;
}

/**
 * One shared indicator for a row of mutually exclusive items (a segmented
 * switch, a tab strip): measures the chosen item and writes its box to the
 * track as --ns-ind-l/-r/-t/-b, marks the track `data-indicator`, and says
 * which way it travelled (`data-ind-dir="fwd"|"back"`) so the CSS can lead with
 * the edge on that side and let the other follow (the stretch). A resize or a
 * late font re-places it without travel (`data-ind-instant`).
 *
 * The CSS draws the plate (app/(app)/app-glass.css); until this runs, the
 * chosen item draws its own plate in the same place, so the server render and
 * a reader without script see the same thing, and nothing shifts.
 *
 * `selected` is whatever identifies the chosen item (its value, its href);
 * `itemsKey` names the set of items (their values and labels), so a switch
 * whose options change is measured again and its new items are observed;
 * `memoryKey`, when given, lets a remounted strip start from where it was.
 */
export function useSlidingIndicator(
  ref: RefObject<HTMLElement | null>,
  items: string,
  selected: unknown,
  itemsKey: string,
  memoryKey?: string,
) {
  useLayoutEffect(() => {
    const track = ref.current;
    if (!track) return;
    const box = measureIndicator(track, items);
    if (!box) {
      track.removeAttribute("data-indicator");
      track.removeAttribute("data-ind-dir");
      return;
    }
    const wasOn = track.hasAttribute("data-indicator");
    const prevL = Number.parseFloat(track.style.getPropertyValue("--ns-ind-l"));
    const remembered = memoryKey ? lastBox.get(memoryKey) : undefined;
    if (!wasOn && remembered && remembered.l !== box.l) {
      // A fresh mount of a strip that had a plate elsewhere: put it there
      // first, then let it travel to the chosen item.
      track.setAttribute("data-ind-instant", "");
      apply(track, remembered);
      track.setAttribute("data-indicator", "");
      flushStyle(track);
      track.removeAttribute("data-ind-instant");
      flushStyle(track);
      track.setAttribute("data-ind-dir", box.l > remembered.l ? "fwd" : "back");
    } else if (wasOn && Number.isFinite(prevL) && prevL !== box.l) {
      track.setAttribute("data-ind-dir", box.l > prevL ? "fwd" : "back");
    }
    apply(track, box);
    track.setAttribute("data-indicator", "");
    if (memoryKey) lastBox.set(memoryKey, box);
  }, [ref, items, selected, itemsKey, memoryKey]);

  // Re-place, without travel, whenever the track or its items change size.
  useLayoutEffect(() => {
    const track = ref.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const box = measureIndicator(track, items);
        if (!box || !track.hasAttribute("data-indicator")) return;
        track.setAttribute("data-ind-instant", "");
        apply(track, box);
        flushStyle(track);
        track.removeAttribute("data-ind-instant");
        if (memoryKey) lastBox.set(memoryKey, box);
      });
    });
    observer.observe(track);
    for (const el of Array.from(track.querySelectorAll<HTMLElement>(items))) observer.observe(el);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref, items, itemsKey, memoryKey]);
}

/** Test seam: forget every remembered strip. */
export function resetIndicatorMemory() {
  lastBox.clear();
}
