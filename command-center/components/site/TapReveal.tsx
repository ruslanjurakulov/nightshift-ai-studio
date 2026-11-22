"use client";

import { useEffect, useRef } from "react";

/** The attribute a media card carries (components/site/media-card.css) and the one this sets on the card a tap revealed. */
export const MF_CARD = "data-mf-card";
export const MF_REVEALED = "data-revealed";
/** The card's stretched link (an overlay over the whole card) and what a control laid over the card marks itself with. */
export const MF_LINK = ".mf-card-link";
export const TAP_IGNORE = "data-tap-ignore";

const INTERACTIVE = `a[href], button, input, select, textarea, summary, [role="button"], [${TAP_IGNORE}]`;

/** Whether `el` matches `selector`, false where the engine does not know the selector (an old browser, or jsdom). */
function matches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/**
 * Touch for the media-first cards: a phone has no hover, so its first tap on a card shows the caption (the title and line a
 * pointer sees on hover) and a second tap on the same card opens it. Without this a tap would leave for the Studio before the
 * person ever read what the card is (owner decision 22 Nov: the caption only appears on hover, and the click opens the Studio).
 *
 * One listener on the grid (the element this renders into), not one per card. Only a click that a finger or a pen made on the
 * card's own link is held back, and only while its caption is hidden:
 * - a mouse click and a keyboard Enter (a click with `detail` 0: no pointer pressed at all) open the card at once, as does a
 *   screen reader's activation (TalkBack, VoiceOver), which moves focus onto the link first, so its caption is already showing;
 * - a gesture the browser cancelled (a scroll that began on a card) leaves nothing behind for the next click;
 * - a control laid over the card (the sound key, marked `data-tap-ignore`) gets its tap and reveals nothing.
 * A tap outside every card, or coming back to the page from the Studio (bfcache `pageshow`), hides the caption again.
 * Renders an empty, hidden span; the grid's own markup is the server's.
 */
export function TapReveal() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const root = ref.current?.parentElement;
    if (!root) return;
    const clear = () => root.querySelectorAll(`[${MF_REVEALED}]`).forEach((el) => el.removeAttribute(MF_REVEALED));
    // The pointer that started the click, read from the pointerdown before it: Safari leaves a click's own pointerType empty.
    let lastPointer = "";
    // Whether the card under the finger already had focus before it went down: a screen reader's focus, not the tap's own (a tap
    // on a link may focus it on the way to its click, which must not count as "the caption is showing").
    let focusedBefore: Element | null = null;
    const onDown = (ev: PointerEvent) => {
      lastPointer = ev.pointerType;
      const card = (ev.target as Element | null)?.closest?.(`[${MF_CARD}]`) ?? null;
      focusedBefore = card && matches(card, ":focus-within") ? card : null;
    };
    const onCancel = () => {
      lastPointer = "";
      focusedBefore = null;
    };
    const onClick = (ev: MouseEvent) => {
      const own = (ev as MouseEvent & { pointerType?: string }).pointerType;
      const kind = own || lastPointer;
      const hadFocus = focusedBefore;
      lastPointer = "";
      focusedBefore = null;
      if (ev.detail === 0) return;
      if (kind !== "touch" && kind !== "pen") return;
      const target = ev.target as Element | null;
      const card = target?.closest?.(`[${MF_CARD}]`);
      if (!card || !root.contains(card)) return;
      const link = card.querySelector(MF_LINK);
      if (!link || target!.closest(INTERACTIVE) !== link) return;
      if (card.getAttribute(MF_REVEALED) === "true") return;
      // Its caption is already on screen: focus was on the card before this tap, or the keyboard ring is on its link.
      if (hadFocus === card || matches(link, ":focus-visible")) return;
      ev.preventDefault();
      clear();
      card.setAttribute(MF_REVEALED, "true");
    };
    const onOutside = (ev: PointerEvent) => {
      if (!(ev.target as Element | null)?.closest?.(`[${MF_CARD}]`)) clear();
    };
    root.addEventListener("pointerdown", onDown, true);
    root.addEventListener("pointercancel", onCancel, true);
    root.addEventListener("click", onClick, true);
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("pageshow", clear);
    return () => {
      root.removeEventListener("pointerdown", onDown, true);
      root.removeEventListener("pointercancel", onCancel, true);
      root.removeEventListener("click", onClick, true);
      document.removeEventListener("pointerdown", onOutside, true);
      window.removeEventListener("pageshow", clear);
    };
  }, []);
  return <span ref={ref} hidden aria-hidden data-tap-reveal="" />;
}
