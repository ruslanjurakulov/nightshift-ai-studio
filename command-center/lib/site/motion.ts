import { useSyncExternalStore } from "react";

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
