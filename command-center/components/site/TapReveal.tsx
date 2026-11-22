"use client";

import { useEffect, useRef } from "react";

/** The attribute a media card carries (components/site/media-card.css) and the one this sets on the card a tap revealed. */
export const MF_CARD = "data-mf-card";
export const MF_REVEALED = "data-revealed";

/**
 * Touch for the media-first cards: a phone has no hover, so its first tap on a card shows the caption (the title and line a
 * pointer sees on hover) and a second tap on the same card opens it. Without this a tap would leave for the Studio before the
 * person ever read what the card is (owner decision 22 Nov: the caption only appears on hover, and the click opens the Studio).
 *
 * One listener on the grid (the element this renders into), not one per card. Only a click that a touch or a pen started is
 * held back; a mouse click and a keyboard Enter open the card at once, because a mouse already saw the caption on hover and a
 * keyboard on focus. Renders an empty, hidden span; the grid's own markup is the server's.
 */
export function TapReveal() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const root = ref.current?.parentElement;
    if (!root) return;
    // The pointer that started the click: a click event's own pointerType is not reliable across browsers (Safari leaves it
    // empty), so it is read from the pointerdown before it.
    let lastPointer = "";
    const onDown = (ev: PointerEvent) => {
      lastPointer = ev.pointerType;
    };
    const onClick = (ev: MouseEvent) => {
      const kind = lastPointer;
      lastPointer = "";
      if (kind !== "touch" && kind !== "pen") return;
      const card = (ev.target as Element | null)?.closest?.(`[${MF_CARD}]`);
      if (!card || !root.contains(card)) return;
      if (card.getAttribute(MF_REVEALED) === "true") return;
      ev.preventDefault();
      root.querySelectorAll(`[${MF_REVEALED}]`).forEach((el) => el.removeAttribute(MF_REVEALED));
      card.setAttribute(MF_REVEALED, "true");
    };
    root.addEventListener("pointerdown", onDown, true);
    root.addEventListener("click", onClick, true);
    return () => {
      root.removeEventListener("pointerdown", onDown, true);
      root.removeEventListener("click", onClick, true);
    };
  }, []);
  return <span ref={ref} hidden aria-hidden data-tap-reveal="" />;
}
