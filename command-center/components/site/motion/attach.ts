import { motionAllowed, prefersReduced, richPointer } from "@/components/site/motion/env";
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

/**
 * 4. The facts row counts up to its numbers, once, as it is scrolled to.
 *
 * The number in the page never changes: it is the server's text, so without JavaScript, with reduced motion, paused, or for a
 * screen reader it is the true count from the first moment. While counting, that text is drawn transparent (its box, so the
 * row's layout, stays exactly as it is) and a CSS counter in a pseudo-element, whose content is marked as having no
 * alternative text, shows the climbing figure over it. Only a number that starts below the fold counts (one already on screen
 * is never taken back to 0 in front of the visitor), and only a plain integer whose printed form is its own digits (a grouped
 * "1 000" would show a different shape while counting).
 */
export function attachCountUp(doc: Document = document, win: Window = window): Cleanup {
  if (prefersReduced() || typeof IntersectionObserver === "undefined") return () => undefined;
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

/** 5. The sticky header turns to frosted glass and a slimmer bar once the page has scrolled (site-motion.css, 1024 px and up). */
export function attachHeader(doc: Document = document, win: Window = window): Cleanup {
  let frame = 0;
  let last: boolean | null = null;
  const sync = () => {
    frame = 0;
    const scrolled = win.scrollY > 8;
    if (scrolled === last) return;
    last = scrolled;
    doc.querySelectorAll<HTMLElement>(".st-header").forEach((h) => {
      if (scrolled) h.setAttribute("data-scrolled", "true");
      else h.removeAttribute("data-scrolled");
    });
  };
  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(sync);
  };
  sync();
  win.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    win.removeEventListener("scroll", onScroll);
    cancelAnimationFrame(frame);
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
 * SiteMotion clears it on every route change, on `pageshow`, and after 8 s at the latest.
 */
export function attachNavBusy(doc: Document = document, win: Window = window): Cleanup {
  let timer = 0;
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.<HTMLAnchorElement>(NAV_KEYS) ?? null;
    if (!a || a.getAttribute("aria-disabled") === "true") return;
    if (!willNavigate(e, a, win.location)) return;
    a.setAttribute("data-busy", "true");
    win.clearTimeout(timer);
    timer = win.setTimeout(() => clearBusy(doc), 8000);
  };
  const onShow = () => clearBusy(doc);
  // Capture phase, before React's: next/link cancels the browser's own navigation (preventDefault) to make it a client-side
  // one, so in the bubble phase every Link click would look cancelled and no key would ever show it is working.
  doc.addEventListener("click", onClick, true);
  win.addEventListener("pageshow", onShow);
  return () => {
    doc.removeEventListener("click", onClick, true);
    win.removeEventListener("pageshow", onShow);
    win.clearTimeout(timer);
    clearBusy(doc);
  };
}
