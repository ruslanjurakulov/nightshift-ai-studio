"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { MARK_ASPECT, Wordmark, WORDMARK_ASPECT } from "@/components/site/Wordmark";
import {
  INTRO,
  INTRO_ANGLE_DEG,
  INTRO_COVER_ATTR,
  INTRO_LATE_MS,
  INTRO_SKIP_EVENTS,
  INTRO_TOTAL_MS,
  introBlocked,
} from "@/lib/site/brand-intro";
import "@/components/site/brand-intro.css";

/**
 * The homepage's first-visit intro (lib/site/brand-intro.ts has the rules and the timeline). It renders nothing on the server
 * and nothing on the first client render, so the page under it is exactly the server's and hydration has nothing to disagree
 * about. It plays only when the inline script already put the black cover up on this load: it never covers a page the visitor
 * has seen.
 *
 * The overlay is decoration: aria-hidden, nothing in it is focusable, focus is never moved and nothing in the page is made inert,
 * so the skip link, the headings and a screen reader's reading order are the page's as they were. It catches pointer input only
 * to end itself; keys pass through untouched (a Tab both ends the intro and moves to the skip link).
 */
export function BrandIntro() {
  // How far into the timeline the cover already was when hydration got here; null: not playing.
  const [shift, setShift] = useState<number | null>(null);

  useEffect(() => {
    const d = document.documentElement;
    const raw = d.getAttribute(INTRO_COVER_ATTR);
    if (raw === null) return;
    const elapsed = performance.now() - Number(raw);
    if (!Number.isFinite(elapsed) || elapsed > INTRO_LATE_MS || introBlocked()) {
      d.removeAttribute(INTRO_COVER_ATTR);
      return;
    }
    setShift(Math.max(0, Math.round(elapsed)));
  }, []);

  useEffect(() => {
    if (shift === null) return;
    // The overlay is committed and opaque black, the same as the cover: lifting the cover now is invisible.
    document.documentElement.removeAttribute(INTRO_COVER_ATTR);
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      setShift(null);
    };
    const opts = { capture: true, passive: true } as const;
    for (const e of INTRO_SKIP_EVENTS) window.addEventListener(e, end, opts);
    const timer = window.setTimeout(end, Math.max(0, INTRO_TOTAL_MS - shift));
    return () => {
      window.clearTimeout(timer);
      for (const e of INTRO_SKIP_EVENTS) window.removeEventListener(e, end, opts);
    };
  }, [shift]);

  if (shift === null) return null;

  const ms = (n: number) => `${n - shift}ms`;
  const style = {
    "--ns-wa": WORDMARK_ASPECT.toFixed(4),
    "--ns-ma": MARK_ASPECT.toFixed(4),
    "--ns-angle": `${INTRO_ANGLE_DEG}deg`,
    "--ns-in-at": ms(INTRO.inAt),
    "--ns-in-ms": `${INTRO.inMs}ms`,
    "--ns-wipe-at": ms(INTRO.wipeAt),
    "--ns-wipe-ms": `${INTRO.wipeMs}ms`,
    "--ns-slit-at": ms(INTRO.slitAt),
    "--ns-slit-ms": `${INTRO.slitMs}ms`,
    "--ns-open-at": ms(INTRO.openAt),
    "--ns-open-ms": `${INTRO.openMs}ms`,
  } as CSSProperties;

  return (
    <div className="ns-intro" aria-hidden="true" data-testid="brand-intro" style={style}>
      <div className="ns-intro-leaf" data-leaf="a" />
      <div className="ns-intro-leaf" data-leaf="b" />
      <div className="ns-intro-stage">
        <div className="ns-intro-lockup">
          {/* The N stays; it is the header's bare mark, drawn from the same numbers as app/icon.svg. */}
          <span className="ns-intro-n">
            <Wordmark mark />
          </span>
          {/* The whole header lockup in a window that starts at the N's right edge: only the lettering shows through, and it
              slides left out of the window, i.e. behind the N. */}
          <span className="ns-intro-win">
            <span className="ns-intro-slide">
              <Wordmark />
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
