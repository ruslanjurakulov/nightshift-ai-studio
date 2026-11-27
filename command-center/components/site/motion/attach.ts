import { forcedColors, motionAllowed, prefersReduced, richPointer } from "@/components/site/motion/env";
import { magnetOffset, parallaxOffset } from "@/components/site/motion/geometry";
import { willNavigate } from "@/components/site/motion/nav-intent";

/**
 * The public site's interaction layer (components/site/site-motion.css draws it). Each function wires one effect onto the
 * page by event delegation and returns its own cleanup, so a page without the element costs one listener and nothing renders.
 *
 * What every one of them keeps, and tests/site-motion.test.tsx pins:
 * - it writes CSS variables and data attributes only, never the DOM's text or structure, so React's tree, the keyboard order
 *   and what a screen reader reads are exactly what the server sent;
 * - transforms only (the `translate` property, composed with the keys' own hover and press `transform`), so nothing moves the
 *   layout and the page's CLS stays 0;
 * - it asks env.ts on every event, so "Pause motion" or the system setting stops it at once, mid-page.
 */

type Cleanup = () => void;

/** The keys that lean toward the pointer: the page's primary button and the prompt bar's Create. */
const MAGNETIC = ".nx-btn, .nx-pbar-go";

/** 1. Magnetic keys, on a mouse or trackpad only. */
export function attachMagnetic(doc: Document = document): Cleanup {
  let held: HTMLElement | null = null;
  let frame = 0;
  const release = () => {
    // A frame queued by the last move must not pull the key again after it was let go.
    cancelAnimationFrame(frame);
    if (!held) return;
    held.style.removeProperty("--mg-x");
    held.style.removeProperty("--mg-y");
    held = null;
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    const key = (e.target as Element | null)?.closest?.<HTMLElement>(MAGNETIC) ?? null;
    if (key !== held) release();
    if (!key || !richPointer() || !motionAllowed() || key.matches(":disabled, [aria-disabled='true'], [data-busy]")) {
      release();
      return;
    }
    held = key;
    const { clientX, clientY } = e;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const o = magnetOffset(key.getBoundingClientRect(), clientX, clientY);
      key.style.setProperty("--mg-x", `${o.x}px`);
      key.style.setProperty("--mg-y", `${o.y}px`);
    });
  };
  // The pointer left the window (no element under it next): let go, or the key would stay pulled until it came back.
  const onOut = (e: PointerEvent) => {
    if (!e.relatedTarget) release();
  };
  doc.addEventListener("pointermove", onMove, { passive: true });
  doc.addEventListener("pointerout", onOut);
  return () => {
    doc.removeEventListener("pointermove", onMove);
    doc.removeEventListener("pointerout", onOut);
    cancelAnimationFrame(frame);
    release();
  };
}

/**
 * 2. The landing hero's picture moves at most 8 px against the pointer (geometry.ts PARALLAX_MAX). The picture's box is larger
 * than the hero by a hair (site-motion.css scales it a little where this runs) so its edge never shows.
 */
export function attachParallax(doc: Document = document): Cleanup {
  let frame = 0;
  let media: HTMLElement | null = null;
  const reset = () => {
    cancelAnimationFrame(frame);
    media?.style.removeProperty("--px");
    media?.style.removeProperty("--py");
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    const hero = (e.target as Element | null)?.closest?.<HTMLElement>(".nx-sh") ?? null;
    const pic = hero?.querySelector<HTMLElement>(":scope > .nx-sh-media") ?? null;
    if (!hero || !pic) {
      reset();
      return;
    }
    media = pic;
    if (!richPointer() || !motionAllowed()) {
      reset();
      return;
    }
    const { clientX, clientY } = e;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const o = parallaxOffset(hero.getBoundingClientRect(), clientX, clientY);
      pic.style.setProperty("--px", `${o.x}px`);
      pic.style.setProperty("--py", `${o.y}px`);
    });
  };
  const onOut = (e: PointerEvent) => {
    if (!e.relatedTarget) reset();
  };
  doc.addEventListener("pointermove", onMove, { passive: true });
  doc.addEventListener("pointerout", onOut);
  return () => {
    doc.removeEventListener("pointermove", onMove);
    doc.removeEventListener("pointerout", onOut);
    cancelAnimationFrame(frame);
    reset();
  };
}

/** 3. A soft light that follows the pointer across the explore grid (the dark #samples section), wide screens with a mouse only. */
export function attachSpotlight(doc: Document = document): Cleanup {
  let frame = 0;
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    const wrap = (e.target as Element | null)?.closest?.<HTMLElement>("#samples > .nx-wrap") ?? null;
    if (!wrap || !richPointer() || !motionAllowed()) return;
    const { clientX, clientY } = e;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const r = wrap.getBoundingClientRect();
      wrap.style.setProperty("--gx", `${Math.round(clientX - r.left)}px`);
      wrap.style.setProperty("--gy", `${Math.round(clientY - r.top)}px`);
    });
  };
  doc.addEventListener("pointermove", onMove, { passive: true });
  return () => {
    doc.removeEventListener("pointermove", onMove);
    cancelAnimationFrame(frame);
  };
}

/** How this document was reached ("navigate", "reload", "back_forward"); "navigate" where the browser does not say. */
export function navigationType(win: Window = window): string {
  const entry = win.performance?.getEntriesByType?.("navigation")?.[0] as PerformanceNavigationTiming | undefined;
  return entry?.type ?? "navigate";
}

/**
 * 4. The facts row counts up to its numbers, once, as it is scrolled to.
 *
 * The number in the page never changes: it is the server's text, so without JavaScript, with reduced motion, paused, or for a
 * screen reader it is the true count from the first moment. While counting, that text is drawn transparent (its box, so the
 * row's layout, stays exactly as it is) and a CSS counter in a pseudo-element, whose content is marked as having no
 * alternative text, shows the climbing figure over it. Only a number that starts below the fold counts (one already on screen
 * is never taken back to 0 in front of the visitor), and only a plain integer whose printed form is its own digits (a grouped
 * "1 000" would show a different shape while counting).
 *
 * Never on a reload or a back/forward visit: the browser restores the scroll position after this runs, so the facts can be on
 * screen already and would drop to 0 in front of a visitor who has seen them. Never in forced colours either, where the
 * transparent text and the drawn counter would not follow the system's palette.
 */
export function attachCountUp(doc: Document = document, win: Window = window): Cleanup {
  if (prefersReduced() || forcedColors() || typeof IntersectionObserver === "undefined") return () => undefined;
  if (["reload", "back_forward"].includes(navigationType(win))) return () => undefined;
  const timers: number[] = [];
  const els = [...doc.querySelectorAll<HTMLElement>("[data-count]")].filter((el) => {
    const n = Number(el.dataset.count);
    return Number.isInteger(n) && n > 0 && n <= 100_000 && el.textContent?.trim() === String(n) && el.getBoundingClientRect().top >= win.innerHeight;
  });
  if (els.length === 0) return () => undefined;
  const finish = (el: HTMLElement) => {
    el.removeAttribute("data-counting");
    el.style.removeProperty("--nx-n");
  };
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        io.unobserve(el);
        if (!motionAllowed()) continue;
        el.style.setProperty("--nx-n", "0");
        el.setAttribute("data-counting", "true");
        // Two frames: the 0 has to be painted before the transition to the real number can run from it.
        requestAnimationFrame(() => requestAnimationFrame(() => el.style.setProperty("--nx-n", el.dataset.count ?? "0")));
        timers.push(win.setTimeout(() => finish(el), 1600));
      }
    },
    { threshold: 0.6 },
  );
  els.forEach((el) => io.observe(el));
  return () => {
    io.disconnect();
    timers.forEach((t) => win.clearTimeout(t));
    els.forEach(finish);
  };
}

/** Below this many pixels from the top the header never hides: the first screen always has its bar. */
export const HEADER_HIDE_AFTER = 80;
/** Back above this the header shows whatever the direction. The 16 px band under HEADER_HIDE_AFTER is the hysteresis: a page
 *  resting on the threshold (a trackpad's last few pixels of momentum) does not make the bar flicker. */
export const HEADER_SHOW_ABOVE = 64;
/** A downward run this long hides it, so a pixel of jitter does not. */
export const HEADER_DOWN = 8;
/** An upward run this long brings it back: a reader reaching for the menu, not the page settling after a scroll. */
export const HEADER_UP = 24;

/** Keyboard focus is inside this header. A mouse click on a link leaves focus on it without :focus-visible; that must not pin
 *  the bar, or every "How it works" click would keep it over the section it scrolled to. */
function keyboardInside(h: HTMLElement, doc: Document): boolean {
  const active = doc.activeElement;
  if (!(active instanceof HTMLElement) || !h.contains(active)) return false;
  try {
    return active.matches(":focus-visible");
  } catch {
    // An engine that cannot answer: keep the bar for anyone focused in it rather than hide it from a keyboard user.
    return true;
  }
}

/**
 * 5. The sticky header (site-motion.css, 1024 px and up): frosted glass and a slimmer bar once the page has scrolled, and out of
 * the way while the reader goes down the page. The owner's report (2026-11-14): the bar sat over "Made with Nightshift", the
 * heading's lower half showing through its 74 % glass, cut in two. So, as on the sites people compare us with, it slides up
 * (data-hidden, a transform: no layout moves) once the page is past HEADER_HIDE_AFTER going down, and comes back on a real
 * scroll up, near the top, or the moment the keyboard enters it. It never hides with a menu open or keyboard focus inside it.
 *
 * It also publishes the bar's measured height as --st-header-h (the language can wrap the links to two lines), which
 * site.css turns into the page's scroll-padding-top, so a #section link lands with its heading below the bar.
 */
export function attachHeader(doc: Document = document, win: Window = window): Cleanup {
  let frame = 0;
  let last: boolean | null = null;
  let lastY = Math.max(0, win.scrollY);
  let turn = lastY;
  let dir = 0;
  let hidden = false;
  const headers = () => Array.from(doc.querySelectorAll<HTMLElement>(".st-header"));
  const held = () => headers().some((h) => h.querySelector('[aria-expanded="true"]') !== null || keyboardInside(h, doc));
  const setHidden = (next: boolean) => {
    if (next && held()) next = false;
    if (next === hidden) return;
    hidden = next;
    for (const h of headers()) {
      if (next) h.setAttribute("data-hidden", "true");
      else h.removeAttribute("data-hidden");
    }
  };
  const sync = () => {
    frame = 0;
    // iOS reports a negative scrollY while the page bounces at the top.
    const y = Math.max(0, win.scrollY);
    const scrolled = y > 8;
    if (scrolled !== last) {
      last = scrolled;
      for (const h of headers()) {
        if (scrolled) h.setAttribute("data-scrolled", "true");
        else h.removeAttribute("data-scrolled");
      }
    }
    if (y <= HEADER_SHOW_ABOVE) {
      setHidden(false);
      dir = 0;
      turn = y;
    } else if (y !== lastY) {
      const d = y > lastY ? 1 : -1;
      if (d !== dir) {
        dir = d;
        turn = lastY;
      }
      if (d > 0 && y > HEADER_HIDE_AFTER && y - turn >= HEADER_DOWN) setHidden(true);
      else if (d < 0 && turn - y >= HEADER_UP) setHidden(false);
    }
    lastY = y;
  };
  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(sync);
  };
  // Tab into a bar that is out of view: it comes back before the focus ring is drawn off screen.
  const onFocusIn = (e: FocusEvent) => {
    const t = e.target;
    if (hidden && t instanceof Node && headers().some((h) => h.contains(t) && keyboardInside(h, doc))) setHidden(false);
  };

  const root = doc.documentElement;
  const bar = headers()[0];
  const measure = () => {
    // offsetHeight, not the bounding box: the slide is a transform and must not read as a change of height.
    if (bar) root.style.setProperty("--st-header-h", `${bar.offsetHeight}px`);
  };
  let ro: ResizeObserver | null = null;
  if (bar) {
    measure();
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(bar);
    } else {
      win.addEventListener("resize", measure);
    }
  }

  sync();
  win.addEventListener("scroll", onScroll, { passive: true });
  doc.addEventListener("focusin", onFocusIn);
  return () => {
    win.removeEventListener("scroll", onScroll);
    win.removeEventListener("resize", measure);
    doc.removeEventListener("focusin", onFocusIn);
    ro?.disconnect();
    cancelAnimationFrame(frame);
    root.style.removeProperty("--st-header-h");
    for (const h of headers()) h.removeAttribute("data-hidden");
  };
}

/** The keys that show "loading" while the page they open is on its way. */
const NAV_KEYS = "a.nx-btn, a.st-key:not([data-tone='quiet'])";

/** Clears every key's "loading": the page changed, came back from the back/forward cache, or took too long to say so. */
export function clearBusy(doc: Document = document): void {
  doc.querySelectorAll<HTMLElement>("[data-busy]").forEach((el) => el.removeAttribute("data-busy"));
}

/**
 * 6. A key that opens another page shows a small spinner in place of its arrow until that page arrives (a client-side
 * navigation can take a moment on a slow link, and a key that does nothing visible gets pressed twice). Only for a click that
 * really navigates this tab (nav-intent.ts); visual only, so the link's name and role are unchanged; and never left behind:
 * it clears the moment the address changes (path or query: the new page has committed, and a key that survives the navigation,
 * like the header's, would otherwise keep spinning), on `pageshow`, when this page's shell unmounts, and after 8 s at the latest.
 *
 * The address is watched by a light poll while a key is busy rather than through next/navigation's hooks: the hooks would need
 * a Suspense boundary on every statically rendered public page (useSearchParams) for a few seconds of spinner.
 */
export function attachNavBusy(doc: Document = document, win: Window = window): Cleanup {
  let timer = 0;
  let watch = 0;
  const stop = () => {
    win.clearTimeout(timer);
    win.clearInterval(watch);
    watch = 0;
    clearBusy(doc);
  };
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.<HTMLAnchorElement>(NAV_KEYS) ?? null;
    if (!a || a.getAttribute("aria-disabled") === "true") return;
    if (!willNavigate(e, a, win.location)) return;
    a.setAttribute("data-busy", "true");
    win.clearTimeout(timer);
    timer = win.setTimeout(stop, 8000);
    const from = win.location.pathname + win.location.search;
    win.clearInterval(watch);
    watch = win.setInterval(() => {
      if (win.location.pathname + win.location.search !== from) stop();
    }, 120);
  };
  const onShow = () => stop();
  // Capture phase, before React's: next/link cancels the browser's own navigation (preventDefault) to make it a client-side
  // one, so in the bubble phase every Link click would look cancelled and no key would ever show it is working.
  doc.addEventListener("click", onClick, true);
  win.addEventListener("pageshow", onShow);
  return () => {
    doc.removeEventListener("click", onClick, true);
    win.removeEventListener("pageshow", onShow);
    stop();
  };
}

/** A bar item: a link, or a panel trigger (components/legal/PublicMegaMenu.tsx), so the glass treats both alike. */
const NAV_ITEM = ".st-nav a, .st-nav .st-mm-trigger";

/**
 * 7. The header's links share one glass indicator (site-motion.css, ".st-nav[data-glass]::before") that slides and stretches
 * to the link under a mouse or the link the keyboard focused. The script writes the link's place and size relative to the nav
 * (offsetLeft/offsetTop, which a transform does not change) and sets data-glass, which hands the hover look from each link to
 * the indicator. A tap never moves it (it is not a hover), and focus moves it only for a visible focus (`:focus-visible`), so
 * the keyboard's ring and the glass agree. The light inside it follows the pointer, on a fine pointer with motion allowed.
 */
export function attachNavGlass(doc: Document = document): Cleanup {
  const navs = [...doc.querySelectorAll<HTMLElement>(".st-nav")];
  if (navs.length === 0) return () => undefined;
  let frame = 0;
  const show = (nav: HTMLElement, a: HTMLElement) => {
    const fresh = !nav.hasAttribute("data-ind");
    // Appearing from nothing it fades in where it is; only a move from one link to the next slides.
    if (fresh) nav.setAttribute("data-ind-snap", "");
    nav.style.setProperty("--ind-x", `${a.offsetLeft}px`);
    nav.style.setProperty("--ind-y", `${a.offsetTop}px`);
    nav.style.setProperty("--ind-w", `${a.offsetWidth}px`);
    nav.style.setProperty("--ind-h", `${a.offsetHeight}px`);
    nav.setAttribute("data-ind", "");
    if (fresh) requestAnimationFrame(() => requestAnimationFrame(() => nav.removeAttribute("data-ind-snap")));
  };
  const hide = (nav: HTMLElement) => {
    nav.removeAttribute("data-ind");
    nav.style.removeProperty("--glass-x");
    nav.style.removeProperty("--glass-y");
  };
  const linkIn = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.<HTMLElement>(NAV_ITEM) ?? null;
    return a ? { a, nav: a.closest<HTMLElement>(".st-nav")! } : null;
  };
  const onOver = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    const hit = linkIn(e);
    if (hit) show(hit.nav, hit.a);
  };
  const onOut = (e: PointerEvent) => {
    const nav = (e.target as Element | null)?.closest?.<HTMLElement>(".st-nav") ?? null;
    if (!nav) return;
    const to = e.relatedTarget as Element | null;
    // Still on a link of the same nav: the next pointerover moves it. Between two links (the gap) or off the nav: it goes.
    if (to && to.closest?.(NAV_ITEM) && nav.contains(to)) return;
    if (nav.contains(doc.activeElement) && (doc.activeElement as Element).matches?.(":focus-visible")) {
      show(nav, doc.activeElement as HTMLElement);
      return;
    }
    hide(nav);
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    const hit = linkIn(e);
    if (!hit || !richPointer() || !motionAllowed()) return;
    const { clientX, clientY } = e;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const r = hit.a.getBoundingClientRect();
      hit.nav.style.setProperty("--glass-x", `${Math.round(clientX - r.left)}px`);
      hit.nav.style.setProperty("--glass-y", `${Math.round(clientY - r.top)}px`);
    });
  };
  const onFocusIn = (e: FocusEvent) => {
    const hit = linkIn(e);
    if (hit && hit.a.matches(":focus-visible")) show(hit.nav, hit.a);
  };
  const onFocusOut = (e: FocusEvent) => {
    const nav = (e.target as Element | null)?.closest?.<HTMLElement>(".st-nav") ?? null;
    if (nav && !nav.contains(e.relatedTarget as Node | null)) hide(nav);
  };
  navs.forEach((n) => n.setAttribute("data-glass", ""));
  doc.addEventListener("pointerover", onOver, { passive: true });
  doc.addEventListener("pointerout", onOut, { passive: true });
  doc.addEventListener("pointermove", onMove, { passive: true });
  doc.addEventListener("focusin", onFocusIn);
  doc.addEventListener("focusout", onFocusOut);
  return () => {
    doc.removeEventListener("pointerover", onOver);
    doc.removeEventListener("pointerout", onOut);
    doc.removeEventListener("pointermove", onMove);
    doc.removeEventListener("focusin", onFocusIn);
    doc.removeEventListener("focusout", onFocusOut);
    cancelAnimationFrame(frame);
    navs.forEach((n) => {
      hide(n);
      n.removeAttribute("data-glass");
      n.removeAttribute("data-ind-snap");
      for (const v of ["--ind-x", "--ind-y", "--ind-w", "--ind-h"]) n.style.removeProperty(v);
    });
  };
}

/** The keys and pills whose glass carries a light under the pointer (site-motion.css and app/glass.css read --glass-x/--glass-y). */
const GLASSY = ".ns-glass, .nx-btn, .st-key, .nx-cta, .st-signin, .nx-show-cta, .nx-ai-try, .nx-final .nx-actions .nx-link";

/** 8. The light inside a glass pill or a key follows a mouse (rAF-throttled), and goes back to rest when the pointer leaves. */
export function attachGlassLight(doc: Document = document): Cleanup {
  let lit: HTMLElement | null = null;
  let frame = 0;
  const rest = () => {
    cancelAnimationFrame(frame);
    if (!lit) return;
    lit.style.removeProperty("--glass-x");
    lit.style.removeProperty("--glass-y");
    lit = null;
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    const el = (e.target as Element | null)?.closest?.<HTMLElement>(GLASSY) ?? null;
    if (el !== lit) rest();
    if (!el || !richPointer() || !motionAllowed()) return;
    lit = el;
    const { clientX, clientY } = e;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--glass-x", `${Math.round(clientX - r.left)}px`);
      el.style.setProperty("--glass-y", `${Math.round(clientY - r.top)}px`);
    });
  };
  const onOut = (e: PointerEvent) => {
    if (!e.relatedTarget) rest();
  };
  doc.addEventListener("pointermove", onMove, { passive: true });
  doc.addEventListener("pointerout", onOut, { passive: true });
  return () => {
    doc.removeEventListener("pointermove", onMove);
    doc.removeEventListener("pointerout", onOut);
    rest();
  };
}
