import { SESSION_COOKIE } from "@/lib/session-hint";

/**
 * The homepage's first-visit brand intro (components/site/BrandIntro.tsx): black, the N and NIGHTSHIFT, the lettering slides
 * away behind the N, and the N's diagonal opens like a door onto the page that was server-rendered underneath all along.
 *
 * kling.ai's is 4-5 s, every visit, no way out. Ours plays once per tab, is over in under 1.8 s, any input ends it, and it never
 * plays where it would cost the visitor something: reduced motion, the page's own Pause motion, Save-Data or a slow link, a
 * signed-in visitor, a framed copy, a crawler, or any path but "/". Every one of those is readable synchronously, so the inline
 * script below decides before the first paint and the component only carries out what it decided: nothing ever paints the page
 * and THEN covers it.
 */

/** The phases, in ms from the moment the black cover went up. Each is a CSS animation's delay and length (brand-intro.css). */
export const INTRO = {
  /** Mark and wordmark fade and scale in at the centre. */
  inAt: 0,
  inMs: 300,
  /** The lettering slides away behind the N, and the N moves to the centre. */
  wipeAt: 480,
  wipeMs: 360,
  /** The N's diagonal becomes a slit of light across the screen; the N itself fades into it. */
  slitAt: 820,
  slitMs: 240,
  /** The two halves of the black part along that diagonal; the overlay is removed when they are off the screen. */
  openAt: 1000,
  openMs: 700,
} as const;

/** When the overlay leaves the DOM. The owner's budget is 1.8 s; tests/brand-intro.test.tsx holds every phase inside it. */
export const INTRO_TOTAL_MS = Math.max(
  INTRO.inAt + INTRO.inMs,
  INTRO.wipeAt + INTRO.wipeMs,
  INTRO.slitAt + INTRO.slitMs,
  INTRO.openAt + INTRO.openMs,
);

/**
 * If the page hydrates later than this after the cover went up, the component does not start the intro: it lifts the cover and
 * the page is simply there. A slow phone must not get "black while JavaScript loads, then 1.7 s of logo".
 */
export const INTRO_LATE_MS = 600;

/** Lifts the cover even if no JavaScript after the inline script ever runs (a failed chunk, an exception in hydration). */
export const INTRO_SAFETY_MS = 2500;

/**
 * The angle of the N's diagonal ribbon, in degrees clockwise from horizontal: the mean of its two long edges in app/icon.svg's
 * ns-n path (286.1,405.1 to 734.3,881.8 is 46.76 deg; 315.9,73.4 to 713.1,479.2 is 45.62 deg), the same two angles the fold
 * shadows are drawn at (components/site/brandMarkArt.ts n1, n2).
 */
export const INTRO_ANGLE_DEG = 46.19;

/** sessionStorage: this tab has had its intro (or was offered it). */
export const INTRO_SEEN_KEY = "ns-intro";
/** On <html>, set by the inline script: the black cover is up; its value is performance.now() at that moment. */
export const INTRO_COVER_ATTR = "data-ns-intro";
/** lib/site/motion.ts: the page's own Pause motion, remembered for the tab. */
const MOTION_KEY = "ns-motion";
/** Slower than 4G, as components/site/LoopClip.tsx reads it. */
const SLOW_LINK = /^(slow-2g|2g|3g)$/;
/** Crawlers and audits get the page as it is, not 1.7 s of black in a screenshot. */
const BOT_UA = /bot|crawl|spider|slurp|lighthouse|pagespeed/i;
/** What sets the visitor's pace: a click, a tap, a key, a wheel, a scroll. Any one of them ends the intro. */
export const INTRO_SKIP_EVENTS = ["pointerdown", "click", "keydown", "wheel", "touchstart", "scroll"] as const;

type Connection = { saveData?: boolean; effectiveType?: string };

/**
 * Every reason not to play except "already seen" (which the inline script settles). A check that cannot be made counts as a
 * reason: no matchMedia means reduced motion cannot be ruled out. The component asks this again at mount, so a cover that was
 * put up wrongly is lifted rather than played over.
 */
export function introBlocked(): boolean {
  try {
    const d = document.documentElement;
    if (window.location.pathname !== "/") return true;
    if (window.top !== window.self) return true;
    if (d.getAttribute("data-motion") === "paused") return true;
    if (window.sessionStorage.getItem(MOTION_KEY) === "paused") return true;
    if (typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return true;
    const c = (navigator as Navigator & { connection?: Connection }).connection;
    if (c && (c.saveData || (c.effectiveType && SLOW_LINK.test(c.effectiveType)))) return true;
    if (BOT_UA.test(navigator.userAgent)) return true;
    // The public header's own hint (lib/session-hint.ts, SessionSwap): a signed-in visitor knows who we are.
    if (SESSION_COOKIE.test(document.cookie)) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * The pre-hydration script, inlined at the top of <body> on "/" only (components/legal/PublicShell.tsx `intro`). ES5, no
 * imports: it runs before any bundle. The same checks as introBlocked, written out by hand, because a function's source is not
 * stable across builds and this string is hashed into the CSP (lib/security/csp.ts BRAND_INTRO_SCRIPT_HASH);
 * tests/brand-intro.test.tsx runs both against the same cases so they cannot drift apart.
 *
 * It writes the seen flag BEFORE it puts the cover up and reads it back: a storage that throws or does not keep what it was
 * given means no intro, never an intro on every page load. Until the component takes over, any input lifts the cover, and the
 * safety timeout lifts it regardless.
 */
export const BRAND_INTRO_SCRIPT =
  "(function(){var w=window,d=document.documentElement,n=navigator,A='" +
  INTRO_COVER_ATTR +
  "';try{if(w.location.pathname!=='/'||w.top!==w.self)return;" +
  "if(d.getAttribute('data-motion')==='paused'||w.sessionStorage.getItem('" +
  MOTION_KEY +
  "')==='paused')return;" +
  "if(typeof w.matchMedia!=='function'||w.matchMedia('(prefers-reduced-motion: reduce)').matches)return;" +
  "var c=n.connection;if(c&&(c.saveData||(c.effectiveType&&" +
  String(SLOW_LINK) +
  ".test(c.effectiveType))))return;" +
  "if(" +
  String(BOT_UA) +
  ".test(n.userAgent))return;" +
  "if(" +
  String(SESSION_COOKIE) +
  ".test(document.cookie))return;" +
  "var s=w.sessionStorage,K='" +
  INTRO_SEEN_KEY +
  "';if(s.getItem(K)!==null)return;s.setItem(K,'1');if(s.getItem(K)!=='1')return;" +
  "d.setAttribute(A,String(Math.round(w.performance.now())));}catch(e){d.removeAttribute(A);return;}" +
  "var E=" +
  JSON.stringify(INTRO_SKIP_EVENTS) +
  ",o={capture:true,passive:true},i;" +
  "function off(){d.removeAttribute(A);for(i=0;i<E.length;i++)w.removeEventListener(E[i],off,o);}" +
  "for(i=0;i<E.length;i++)w.addEventListener(E[i],off,o);" +
  "w.setTimeout(off," +
  INTRO_SAFETY_MS +
  ");})();";
