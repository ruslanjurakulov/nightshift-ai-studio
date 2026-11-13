"use client";

import { useEffect } from "react";

/**
 * The keys whose glass highlight follows the pointer (app/(app)/app-glass.css
 * draws it from --glass-x/--glass-y). Kept beside the listener, and pinned
 * against the stylesheet by tests/app-glass.test.tsx, so a key added to one is
 * not forgotten in the other.
 */
export const GLASS_POINTER_SELECTOR = [
  ".btn-primary",
  ".btn-quiet",
  ".btn-danger",
  ".btn-sky",
  ".shell-pill",
  ".ns-chip:not([data-plain])",
  ".studio-chip",
  ".ns-price-button",
  ".studio-cta",
  ".ns-tab-create",
  ".ns-glass",
].join(", ");

const REDUCED = "(prefers-reduced-motion: reduce)";

function refused(el: Element): boolean {
  return el.matches(':disabled, [aria-disabled="true"]');
}

/**
 * ONE listener for the whole document, not one per key: a pointermove is
 * remembered, and at most once per animation frame the key under it (if any)
 * gets the pointer's position inside it as --glass-x/--glass-y. A finger is
 * ignored (a tap has no hover to follow), so is a key that cannot be pressed,
 * and nothing is attached at all while the reader asks for reduced motion —
 * re-checked if they change it. Returns the detach.
 *
 * The position is left on the key after the pointer leaves: the highlight
 * fades out where it was, instead of jumping to the middle as it goes.
 */
export function attachGlassPointer(win: Window = window): () => void {
  const doc = win.document;
  let frame = 0;
  let target: EventTarget | null = null;
  let x = 0;
  let y = 0;

  const flush = () => {
    frame = 0;
    const at = target as Partial<Element> | null;
    const el = typeof at?.closest === "function" ? (at as Element).closest<HTMLElement>(GLASS_POINTER_SELECTOR) : null;
    if (!el || refused(el)) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--glass-x", `${Math.round(x - r.left)}px`);
    el.style.setProperty("--glass-y", `${Math.round(y - r.top)}px`);
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    target = e.target;
    x = e.clientX;
    y = e.clientY;
    if (!frame) frame = win.requestAnimationFrame(flush);
  };

  let on = false;
  const start = () => {
    if (on) return;
    on = true;
    doc.addEventListener("pointermove", onMove, { passive: true });
  };
  const stop = () => {
    if (!on) return;
    on = false;
    doc.removeEventListener("pointermove", onMove);
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
  };

  const mq = typeof win.matchMedia === "function" ? win.matchMedia(REDUCED) : null;
  const sync = () => (mq?.matches ? stop() : start());
  sync();
  mq?.addEventListener?.("change", sync);
  return () => {
    mq?.removeEventListener?.("change", sync);
    stop();
  };
}

/** Mounted once by the signed-in app's layout; draws nothing. */
export function GlassPointer() {
  useEffect(() => attachGlassPointer(window), []);
  return null;
}
