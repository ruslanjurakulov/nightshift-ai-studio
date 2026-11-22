"use client";

import { useEffect, useRef, useState, type AnimationEvent, type CSSProperties } from "react";
import { MARK_ASPECT, Wordmark, WORDMARK_ASPECT } from "@/components/site/Wordmark";
import {
  INTRO,
  INTRO_ANGLE_DEG,
  INTRO_CLAIM_MS,
  INTRO_COVER_ATTR,
  INTRO_FALLBACK_MS,
  INTRO_HELD,
  INTRO_SKIP_EVENTS,
  INTRO_TAP_EVENTS,
  introBlocked,
  swallowNextClick,
} from "@/lib/site/brand-intro";
import { startIntroCue, type IntroCue } from "@/lib/site/brand-intro-sound";
import "@/components/site/brand-intro.css";

/** The CSS custom properties brand-intro.css reads: the lockup's proportions, the N's angle and every phase. */
const STYLE = {
  "--ns-wa": WORDMARK_ASPECT.toFixed(4),
  "--ns-ma": MARK_ASPECT.toFixed(4),
  "--ns-angle": `${INTRO_ANGLE_DEG}deg`,
  "--ns-in-at": `${INTRO.inAt}ms`,
  "--ns-in-ms": `${INTRO.inMs}ms`,
  "--ns-wipe-at": `${INTRO.wipeAt}ms`,
  "--ns-wipe-ms": `${INTRO.wipeMs}ms`,
  "--ns-slit-at": `${INTRO.slitAt}ms`,
  "--ns-slit-ms": `${INTRO.slitMs}ms`,
  "--ns-open-at": `${INTRO.openAt}ms`,
  "--ns-open-ms": `${INTRO.openMs}ms`,
} as CSSProperties;

const TAPS: readonly string[] = INTRO_TAP_EVENTS;

/**
 * The homepage's first-visit intro (lib/site/brand-intro.ts has the rules and the timeline). It renders nothing on the server
 * and nothing on the first client render, so the page under it is exactly the server's and hydration has nothing to disagree
 * about. It plays only when the inline script already put the black cover up on this load and it can claim that cover within
 * INTRO_CLAIM_MS: it never covers a page the visitor has seen, and the cover lifts itself at INTRO_LATE_MS when it was not
 * claimed, so nobody stands on bare black for longer than that.
 *
 * The animation runs from its beginning when the overlay commits, and the overlay leaves on the opening's own animationend, so a
 * main thread busy with the rest of hydration delays the whole intro instead of cutting its end. The sound starts on the first
 * animation's animationstart, so it follows the picture rather than a clock.
 *
 * The overlay is decoration: aria-hidden, nothing in it is focusable, focus is never moved and nothing in the page is made inert,
 * so the skip link, the headings and a screen reader's reading order are the page's as they were. It catches pointer input only
 * to end itself, and a skipping tap's click is swallowed so it cannot also press what was under it; keys pass through untouched
 * (a Tab both ends the intro and moves to the skip link).
 */
export function BrandIntro() {
  const [playing, setPlaying] = useState(false);
  const cue = useRef<IntroCue | null>(null);
  const endRef = useRef<() => void>(() => {});

  useEffect(() => {
    const d = document.documentElement;
    const raw = d.getAttribute(INTRO_COVER_ATTR);
    if (raw === null || raw === INTRO_HELD) return;
    const elapsed = performance.now() - Number(raw);
    if (!Number.isFinite(elapsed) || elapsed > INTRO_CLAIM_MS || introBlocked()) {
      d.removeAttribute(INTRO_COVER_ATTR);
      return;
    }
    // Claimed: the inline script's late timer leaves the cover up for the overlay to take over.
    d.setAttribute(INTRO_COVER_ATTR, INTRO_HELD);
    setPlaying(true);
  }, []);

  useEffect(() => {
    if (!playing) return;
    const d = document.documentElement;
    // An input between the claim and this commit made the inline script lift the cover: the visitor already chose the page.
    if (d.getAttribute(INTRO_COVER_ATTR) !== INTRO_HELD) {
      setPlaying(false);
      return;
    }
    // The overlay is committed and opaque black, the same as the cover: lifting the cover now is invisible.
    d.removeAttribute(INTRO_COVER_ATTR);
    let done = false;
    const end = (e?: Event) => {
      if (done) return;
      done = true;
      if (e && TAPS.includes(e.type)) swallowNextClick();
      setPlaying(false);
    };
    endRef.current = end;
    const opts = { capture: true, passive: true } as const;
    for (const e of INTRO_SKIP_EVENTS) window.addEventListener(e, end, opts);
    const timer = window.setTimeout(end, INTRO_FALLBACK_MS);
    return () => {
      window.clearTimeout(timer);
      for (const e of INTRO_SKIP_EVENTS) window.removeEventListener(e, end, opts);
      endRef.current = () => {};
      // Skip or the end: silent within 30 ms, then the context is closed.
      cue.current?.stop();
      cue.current = null;
    };
  }, [playing]);

  if (!playing) return null;

  // The first animation started: the timeline's zero, for the sound (null, and no AudioContext, where sound is not allowed).
  const onStart = (e: AnimationEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || cue.current) return;
    cue.current = startIntroCue(performance.now());
  };
  // The opening finished: the halves are off the screen.
  const onOpened = (e: AnimationEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.pseudoElement) return;
    endRef.current();
  };

  return (
    <div className="ns-intro" aria-hidden="true" data-testid="brand-intro" style={STYLE}>
      <div className="ns-intro-leaf" data-leaf="a" onAnimationEnd={onOpened} />
      <div className="ns-intro-leaf" data-leaf="b" />
      <div className="ns-intro-stage" onAnimationStart={onStart}>
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
