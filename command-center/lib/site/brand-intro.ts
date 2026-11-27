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

/** The phases, in ms from the moment the overlay's animations start. Each is a CSS animation's delay and length (brand-intro.css). */
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

/** When the overlay leaves the DOM, after its animations start. The owner's budget is 1.8 s; tests/brand-intro.test.tsx holds
 *  every phase inside it. */
export const INTRO_TOTAL_MS = Math.max(
  INTRO.inAt + INTRO.inMs,
  INTRO.wipeAt + INTRO.wipeMs,
  INTRO.slitAt + INTRO.slitMs,
  INTRO.openAt + INTRO.openMs,
);

/**
 * The longest the bare black cover may stand before the page shows. The inline script lifts the cover itself at this moment
 * unless the component has claimed it (INTRO_HELD), so a phone that hydrates late sees ~0.3 s of black and then the page, never
 * black for as long as JavaScript takes. A component that claims it starts the animation from its beginning.
 */
export const INTRO_LATE_MS = 300;

/**
 * The component claims the cover only this early, a frame or more before the cover's own CSS lift starts at INTRO_LATE_MS: a
 * claim that reached the screen after the lift had begun would put the black back over a page already showing.
 */
export const INTRO_CLAIM_MS = INTRO_LATE_MS - 80;

/** The last resort: lifts even a claimed cover if the overlay never committed (an exception in hydration). */
export const INTRO_SAFETY_MS = 2500;

/** After the overlay's animations should have ended: removes it even where no animationend arrives (a tab hidden mid-intro). */
export const INTRO_FALLBACK_MS = INTRO_TOTAL_MS + 800;

/** A skipping tap's own click must not land on the page under it: the next click within this is swallowed. */
export const INTRO_SWALLOW_MS = 500;

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
/** The cover attribute's value once the component has claimed the cover: the script's own late timer then leaves it alone. */
export const INTRO_HELD = "held";
/** lib/site/motion.ts: the page's own Pause motion, remembered for the tab. */
const MOTION_KEY = "ns-motion";
/** Slower than 4G, as components/site/LoopClip.tsx reads it. */
const SLOW_LINK = /^(slow-2g|2g|3g)$/;
/**
 * Known crawlers get the page as it is, not black in a screenshot. Named one by one: a bare /bot/ also matched phones
 * ("CUBOT"). Lighthouse and PageSpeed are NOT here, so a lab measurement sees what a first visitor gets.
 */
const BOT_UA =
  /googlebot|google-inspectiontool|storebot-google|bingbot|yandexbot|baiduspider|duckduckbot|slurp|applebot|facebookexternalhit|twitterbot|linkedinbot|ahrefsbot|semrushbot|petalbot|bytespider|gptbot|claudebot|ccbot|crawler|spider/i;
/**
 * What the visitor does that ends the intro: a click or tap, a key, a wheel, a finger moving. Not `scroll`: the browser scrolls
 * by itself (restoring a position, following a #hash), and that is not the visitor asking to skip.
 */
export const INTRO_SKIP_EVENTS = ["pointerdown", "click", "keydown", "wheel", "touchstart", "touchmove"] as const;
/** The events whose own click follows them onto the page: a skip by one of these swallows that click. */
export const INTRO_TAP_EVENTS = ["pointerdown", "touchstart"] as const;

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
    // A background tab or a prerender: nobody is looking, and it must not be "seen" for them.
    if (document.visibilityState === "hidden" || (document as Document & { prerendering?: boolean }).prerendering) return true;
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
 * Swallows the next click anywhere on the page, once, within INTRO_SWALLOW_MS: the tap that skipped the intro must not also
 * press the button that was under it. The inline script carries the same few lines.
 */
export function swallowNextClick(): void {
  const eat = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const done = () => window.removeEventListener("click", eat, true);
  window.addEventListener("click", eat, true);
  window.setTimeout(done, INTRO_SWALLOW_MS);
}

/**
 * The pre-hydration script, inlined at the top of <body> on "/" only (components/legal/PublicShell.tsx `intro`). ES5, no
 * imports: it runs before any bundle. The same checks as introBlocked, written out by hand, because a function's source is not
 * stable across builds and this string is hashed into the CSP (lib/security/csp.ts BRAND_INTRO_SCRIPT_HASH);
 * tests/brand-intro.test.tsx runs both against the same cases so they cannot drift apart.
 *
 * It writes the seen flag BEFORE it puts the cover up and reads it back: a storage that throws or does not keep what it was
 * given means no intro, never an intro on every page load. Then:
 * - at INTRO_LATE_MS it lifts the cover unless the component has claimed it (value INTRO_HELD);
 * - any input before the component took the cover over lifts it (claimed or not: the component sees that and does not play),
 *   and a tap's click is swallowed; once the cover is gone, its listeners only unbind themselves;
 * - at INTRO_SAFETY_MS it lifts whatever is left.
 */
export const BRAND_INTRO_SCRIPT =
  "(function(){var w=window,doc=document,d=doc.documentElement,n=navigator,A='" +
  INTRO_COVER_ATTR +
  "',H='" +
  INTRO_HELD +
  "';try{if(w.location.pathname!=='/'||w.top!==w.self)return;" +
  "if(doc.visibilityState==='hidden'||doc.prerendering)return;" +
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
  ".test(doc.cookie))return;" +
  "var s=w.sessionStorage,K='" +
  INTRO_SEEN_KEY +
  "';if(s.getItem(K)!==null)return;s.setItem(K,'1');if(s.getItem(K)!=='1')return;" +
  "d.setAttribute(A,String(Math.round(w.performance.now())));}catch(e){d.removeAttribute(A);return;}" +
  "var E=" +
  JSON.stringify(INTRO_SKIP_EVENTS) +
  ",T=" +
  JSON.stringify(INTRO_TAP_EVENTS) +
  ",o={capture:true,passive:true},i;" +
  "function unbind(){for(i=0;i<E.length;i++)w.removeEventListener(E[i],input,o);}" +
  "function eat(e){e.preventDefault();e.stopPropagation();uneat();}" +
  "function uneat(){w.removeEventListener('click',eat,true);}" +
  "function input(e){unbind();if(!d.hasAttribute(A))return;d.removeAttribute(A);" +
  "if(T.indexOf(e.type)>=0){w.addEventListener('click',eat,true);w.setTimeout(uneat," +
  INTRO_SWALLOW_MS +
  ");}}" +
  "for(i=0;i<E.length;i++)w.addEventListener(E[i],input,o);" +
  "w.setTimeout(function(){if(d.getAttribute(A)!==H&&d.hasAttribute(A)){d.removeAttribute(A);unbind();}}," +
  INTRO_LATE_MS +
  ");" +
  "w.setTimeout(function(){if(d.hasAttribute(A))d.removeAttribute(A);unbind();}," +
  INTRO_SAFETY_MS +
  ");})();";
