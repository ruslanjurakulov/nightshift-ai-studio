import { useEffect, useSyncExternalStore } from "react";

/**
 * One switch for everything on the public pages that moves by itself (the
 * hero's drifting light and the four-state picture's autoplay): WCAG 2.2.2
 * asks for a way to pause anything that moves for more than five seconds.
 *
 * The state lives on <html data-motion="paused"> so the stylesheet can stop
 * the animations without any component re-rendering, and in a tiny store so
 * the components that run timers can follow it. It is remembered for the tab
 * (sessionStorage) so a visitor who paused does not have it start again on the
 * next page; storage can be blocked, so every access is guarded and the switch
 * works without it.
 */
const KEY = "ns-motion";
let paused = false;
let started = false;
const listeners = new Set<() => void>();

function apply() {
  if (typeof document === "undefined") return;
  if (paused) document.documentElement.setAttribute("data-motion", "paused");
  else document.documentElement.removeAttribute("data-motion");
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  try {
    paused = window.sessionStorage.getItem(KEY) === "paused";
  } catch {
    paused = false;
  }
  apply();
}

/** Applies the remembered choice to <html> right away (without any component), so a page that starts drifting
 *  after load (components/site/SiteEffects.tsx) never starts when the visitor paused on an earlier page. */
export function restoreMotion() {
  start();
}

export function setMotionPaused(next: boolean) {
  start();
  paused = next;
  try {
    if (next) window.sessionStorage.setItem(KEY, "paused");
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // Blocked storage: the switch still works for this page.
  }
  apply();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => paused;
/** The server and the first client render agree on "playing"; the saved choice applies right after. */
const serverSnapshot = () => false;

export function useMotionPaused(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/**
 * Where a tap is a pointer's pause (WCAG 2.2.2): anything that moves by itself. A clip's box, a drifting poster, the landing's
 * first screen (its words column covers the clip under it), the drifting light behind a page's first words (.nx-lit) and the
 * sign-in stages. The owner wants no visible pause button (2026-11-13); keyboards keep the focus-revealed one (MotionToggle,
 * ClipPause). Taps toggle the page's one switch whether or not a clip is playing at that moment: under Save-Data or a slow link
 * no clip plays, but the posters drift and the light moves, and a pointer must still be able to stop them. The landing's models
 * ribbon (.hm-ribbon) moves on a touch screen too, where no hover can stop it: a tap there is its pointer's pause.
 */
const TAP_AREAS = "[data-clip], .nx-drift-pic, .nx-sh, .nx-lit, .st-auth-aside, .nx-auth-band, .hm-ribbon";
/**
 * What a tap in such an area belongs to rather than to the switch: a control, the composer's form, or anything focusable. Except a
 * row that is focusable only so a keyboard can scroll it (`data-scroll-region`, the landing's reel): it is not a control, and
 * counting it as one took the pointer's pause away from every clip in it. The links and buttons inside it still count.
 */
const CONTROLS =
  "a, button, input, select, textarea, label, summary, form, [role='button'], [contenteditable='true'], [tabindex]:not([tabindex='-1']):not([data-scroll-region])";

/** When the last tap flipped the switch (ms), so the second click of a double-click can take it back. */
let lastFlip = 0;
/** A double-click arrives as two clicks, the second with detail 2, well inside this. */
const DOUBLE_MS = 800;

/** One click on the page decides: in a motion area, not on a control, not the end of a text selection, and motion not reduced. */
export function motionTap(ev: MouseEvent): void {
  if (ev.defaultPrevented || ev.button !== 0) return;
  const target = ev.target;
  if (!(target instanceof Element) || !target.closest(TAP_AREAS) || target.closest(CONTROLS)) return;
  // A double-click selects a word (the hero headline is in a tap area): its first click flipped the switch, so the second takes the
  // flip back; a triple-click (a paragraph) changes nothing more. Checked before the selection, which the double-click just made.
  if (ev.detail > 1) {
    if (ev.detail === 2 && lastFlip && Date.now() - lastFlip < DOUBLE_MS) {
      lastFlip = 0;
      setMotionPaused(!paused);
    }
    return;
  }
  if (window.getSelection?.()?.isCollapsed === false) return;
  // Under reduced motion nothing moves: a tap would only flip a remembered state nobody can see.
  if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  start();
  setMotionPaused(!paused);
  lastFlip = Date.now();
}

let tapUsers = 0;
/**
 * Listens for motionTap on the document while any public part that moves is mounted (the effects script, the switches, the clips,
 * the sign-in stage). One delegated listener however many call it, so a page never toggles twice for one tap.
 */
export function useMotionTap(): void {
  useEffect(() => {
    if (tapUsers++ === 0) document.addEventListener("click", motionTap);
    return () => {
      if (--tapUsers === 0) document.removeEventListener("click", motionTap);
    };
  }, []);
}
