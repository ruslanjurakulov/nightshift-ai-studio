"use client";

import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Copy, Pause, Play, X } from "lucide-react";
import { fmt } from "@/lib/i18n/core";
import { STILL_MS, clock, ringIndex, ringOffset, type SampleSlide } from "@/lib/site/carousel";
import { useMotionPaused } from "@/lib/site/motion";
import type { SiteCarouselDictionary } from "@/lib/i18n/site-carousel";
import { clipsAllowed } from "@/components/site/LoopClip";
import { usePageVisible, useReducedMotion, useClipNear, useClipTurn } from "@/components/site/clip-turns";
import "@/components/site/showcase-carousel.css";

/** The few gallery words the centre card shares with the explore grid (t.site.gallery), so both say the same thing. */
export type CarouselGalleryCopy = { badge: string; model: string; altClip: string; altImage: string; use: string; notInStudio: string; gone: string; noPrompt: string };

/**
 * A coverflow of our own samples (lib/site/showcase.json): one large centre card playing its clip, the cards before and after it
 * peeking at the sides, smaller and dimmed.
 *
 * - The centre clip plays muted, once; when it ends the next card comes in. A picture holds the centre for STILL_MS with a slow
 *   zoom. Pressing a side card brings it to the centre and plays it, and the carousel goes on from there.
 * - Arrow keys (while focus is inside), swipe, and the previous / next buttons move it. A tap on the centre clip stops it (there
 *   is no visible pause button; the stop control is for the keyboard, shown when focused), and so does the page's own pause
 *   switch (lib/site/motion.ts). Starting it again here overrides the page's switch for this carousel only, until the switch is
 *   pressed again; it never turns the page's switch off. Keyboard focus arriving inside holds it too (the APG carousel rule),
 *   and the hold stays after focus leaves, until the start control (or a tap) is pressed.
 * - Under reduced motion nothing plays or advances by itself: the posters stand still, and a clip plays only when its play button
 *   is pressed. With Save-Data or a slow link clips are not fetched until pressed either, and the posters advance on the timer.
 * - Only the centre card ever has a video. It is put in the page once the carousel comes within half a screen of the viewport, so
 *   it is buffered by the time it shows, and it plays while the carousel is on screen (components/site/clip-turns.ts: every clip
 *   on screen plays, the page's other loops alongside it).
 * - Every box is sized before anything loads (the stage, the cards and the panel under them have fixed heights), so nothing on the
 *   page moves when a card or its words change by themselves.
 *
 * Each card is one sample's box (data-showcase-entry), the only kind of element that may name a model; the panel under the stage
 * is the centre sample's box, with its title, its own words, the AI-generated label and the model (no maker's credit line: the
 * owner's rule of 2026-11-13 keeps those off public pages).
 */
export function ShowcaseCarousel({ slides, copy, g }: { slides: SampleSlide[]; copy: SiteCarouselDictionary["carousel"]; g: CarouselGalleryCopy }) {
  const n = slides.length;
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const swipe = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const elapsed = useRef(0);
  // Whether keyboard focus was inside when the centre changed: a control that unmounts with its card hands focus to "next".
  const hadFocus = useRef(false);
  const nextBtn = useRef<HTMLButtonElement>(null);
  // How long the centre clip has been asked to play without frames to show (a stalled download).
  const waited = useRef(0);

  const [mounted, setMounted] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [small, setSmall] = useState(true);
  const [index, setIndex] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [held, setHeld] = useState(false);
  // "Start" pressed here while the page's pause switch is on: this carousel runs anyway, until the switch changes again.
  const [override, setOverride] = useState(false);
  const [open, setOpen] = useState(false);
  const [pressedPlay, setPressedPlay] = useState(false);
  const [failed, setFailed] = useState(false);
  const [woke, setWoke] = useState(false);
  const [left, setLeft] = useState("");
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const [said, setSaid] = useState("");

  const reduced = useReducedMotion();
  const pagePaused = useMotionPaused();
  const visible = usePageVisible();

  useEffect(() => {
    setAllowed(clipsAllowed());
    setSmall(typeof window.matchMedia !== "function" || !window.matchMedia("(min-width: 1024px)").matches);
    setMounted(true);
  }, []);

  const s = slides[index] ?? slides[0];
  useEffect(() => setOverride(false), [pagePaused]);
  const pageHolds = pagePaused && !override;
  // What the stop control shows: stopped by a tap or the control, held by keyboard focus, or held by the page's switch.
  const paused = stopped || held || pageHolds;
  const auto = mounted && !reduced && !stopped && !pageHolds;
  // A press on play is the visitor's own choice, so it plays even with reduced motion or Save-Data on.
  const turn = useClipTurn(stage, mounted && (auto || pressedPlay));
  const soon = useClipNear(stage, mounted);
  useEffect(() => {
    if (turn || soon) setWoke(true);
  }, [turn, soon]);

  const hasClip = !!s && s.kind === "video" && s.clip !== null && !failed;
  const showVideo = hasClip && (pressedPlay || (allowed && woke && !reduced));
  const playing = showVideo && turn && visible && (pressedPlay || auto);
  // The clock that moves the carousel on: only by itself, on screen, with no reader holding it.
  const running = auto && turn && visible && !held && !open;
  const timed = running && !(showVideo && playing);

  const go = useCallback(
    (to: number, byVisitor: boolean) => {
      if (n === 0) return;
      const next = ringIndex(to, 0, n);
      setIndex(next);
      setPressedPlay(false);
      setFailed(false);
      setOpen(false);
      setCopied("idle");
      setLeft("");
      elapsed.current = 0;
      waited.current = 0;
      bar.current?.style.setProperty("--nxc-p", "0");
      hadFocus.current = !!root.current && root.current.contains(document.activeElement) && document.activeElement !== document.body;
      if (byVisitor) setSaid(fmt(copy.now, { title: slides[next].title }));
    },
    [n, copy.now, slides],
  );

  // A focused control on the old centre card (its play button, a pressed side card) is gone now: keep the keyboard in the carousel.
  useEffect(() => {
    if (!hadFocus.current) return;
    hadFocus.current = false;
    const a = document.activeElement;
    if (!a || a === document.body || !root.current?.contains(a)) nextBtn.current?.focus({ preventScroll: true });
  }, [index]);

  // Play or hold the centre clip.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (playing) {
      void Promise.resolve(v.play()).catch((err: unknown) => {
        // The browser refused to start it (not a pause racing the play): the poster holds the centre on the timer instead.
        if (err instanceof DOMException && err.name === "NotAllowedError") setFailed(true);
      });
    } else v.pause();
  }, [playing, showVideo, s?.job]);

  // The progress bar and "0:04 left": the clip's own position, or a picture's share of its turn. Written straight to the bar's
  // style each frame; the words change at most once a second.
  useEffect(() => {
    if (!timed && !playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const v = video.current;
      let p = 0;
      let rest = Number.NaN;
      if (showVideo && v && playing) {
        // A clip that never arrives does not hold the carousel: after 10 s in a row without frames its poster takes the
        // picture's turn. Any moment with frames to play starts the count again.
        if (v.readyState >= 3) waited.current = 0;
        else {
          waited.current += dt;
          if (waited.current > 10_000) {
            setFailed(true);
            return;
          }
        }
      }
      if (showVideo && v && Number.isFinite(v.duration) && v.duration > 0) {
        p = v.currentTime / v.duration;
        rest = v.duration - v.currentTime;
      } else if (timed) {
        elapsed.current += dt;
        p = elapsed.current / STILL_MS;
        rest = (STILL_MS - elapsed.current) / 1000;
        if (elapsed.current >= STILL_MS) {
          go(index + 1, false);
          return;
        }
      }
      bar.current?.style.setProperty("--nxc-p", String(Math.min(1, Math.max(0, p))));
      const text = clock(rest);
      setLeft((had) => (had === text ? had : text));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [timed, playing, showVideo, index, go]);

  const onEnded = () => {
    if (running) go(index + 1, false);
    else if (pressedPlay) setPressedPlay(false);
    else {
      // Held (a reader, or keyboard focus inside): the clip starts over instead of the carousel moving on under them.
      const v = video.current;
      if (v) {
        v.currentTime = 0;
        void Promise.resolve(v.play()).catch(() => undefined);
      }
    }
  };

  const toggleRun = () => {
    if (paused) {
      setStopped(false);
      setHeld(false);
      if (pagePaused) setOverride(true);
    } else setStopped(true);
  };

  // A tap on the centre clip is its pause (there is no visible pause button: the stop control is for the keyboard, shown when
  // focused). With clips started by hand it pauses or plays that clip; otherwise it stops or restarts the carousel.
  const tapCentre = () => {
    if (swipe.current?.moved) {
      swipe.current = null;
      return;
    }
    if (reduced || !allowed || pressedPlay) {
      if (hasClip) setPressedPlay((p) => !p);
      return;
    }
    toggleRun();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) {
      setOpen(false);
      moreBtn.current?.focus();
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if ((e.target as HTMLElement).closest?.(".nxc-full")) return;
    e.preventDefault();
    go(index + (e.key === "ArrowLeft" ? -1 : 1), true);
  };

  const onFocusIn = (e: FocusEvent<HTMLDivElement>) => {
    const from = e.relatedTarget as Node | null;
    if (from && root.current?.contains(from)) return;
    let keyboard = false;
    try {
      keyboard = (e.target as HTMLElement).matches(":focus-visible");
    } catch {
      keyboard = false;
    }
    if (keyboard) setHeld(true);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    swipe.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const t = swipe.current;
    if (!t) return;
    const dx = e.clientX - t.x;
    const dy = e.clientY - t.y;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      t.moved = true;
      go(index + (dx < 0 ? 1 : -1), true);
    }
  };
  const pick = (i: number) => {
    // The release of a swipe also lands as a click on whatever card it ended over.
    if (swipe.current?.moved) {
      swipe.current = null;
      return;
    }
    go(i, true);
  };

  const copyPrompt = () => {
    const done = (ok: boolean) => {
      setCopied(ok ? "ok" : "fail");
      setSaid(ok ? copy.copied : copy.copyFailed);
    };
    try {
      void navigator.clipboard.writeText(s.prompt).then(
        () => done(true),
        () => done(false),
      );
    } catch {
      done(false);
    }
  };

  useEffect(() => {
    if (open) closeBtn.current?.focus();
  }, [open]);

  if (n === 0 || !s) return null;
  const promptId = `${uid}-prompt`;
  const fullId = `${uid}-full`;
  const noteId = `${uid}-note`;
  const words = s.prompt.trim();

  return (
    <div
      ref={root}
      className="nxc"
      role="region"
      aria-roledescription={copy.roledescription}
      aria-label={copy.region}
      data-run={running ? "true" : "false"}
      data-reduced={reduced ? "true" : undefined}
      onKeyDown={onKey}
      onFocus={onFocusIn}
    >
      <div ref={stage} className="nxc-stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => (swipe.current = null)}>
        <div className="nxc-track">
          {slides.map((it, i) => {
            const off = ringOffset(i, index, n);
            const near = Math.abs(off) <= 2;
            const centre = off === 0;
            return (
              <div
                key={it.job}
                className="nxc-card"
                data-offset={near ? off : off > 0 ? 3 : -3}
                data-kind={it.kind}
                data-showcase-entry={it.job}
                role="group"
                aria-roledescription={copy.slideRole}
                aria-label={fmt(copy.slide, { n: i + 1, total: n })}
                aria-hidden={centre ? undefined : true}
              >
                {near && (centre ? (
                  <div className="nxc-media" data-live={showVideo && playing ? "true" : undefined} data-stopped={paused ? "true" : undefined} onClick={tapCentre}>
                    <Frame it={it} alt={fmt(it.kind === "video" ? g.altClip : g.altImage, { model: it.modelName })} />
                    {showVideo && it.clip && (
                      <video
                        key={it.job}
                        ref={video}
                        className="nxc-video"
                        muted
                        playsInline
                        preload="auto"
                        poster={it.posterSm}
                        disablePictureInPicture
                        aria-hidden
                        tabIndex={-1}
                        onEnded={onEnded}
                        onError={() => setFailed(true)}
                      >
                        <source src={small ? it.clip.smWebm : it.clip.webm} type="video/webm" />
                        <source src={small ? it.clip.smMp4 : it.clip.mp4} type="video/mp4" />
                      </video>
                    )}
                    <span className="nx-result-badge nxc-badge">{g.badge}</span>
                    {hasClip && mounted && (reduced || !allowed || pressedPlay) && (
                      // Starting a clip by hand is a visible play button; once it plays, its pause is the tap on the clip, and this
                      // button stays only for the keyboard (shown when focused).
                      <button
                        type="button"
                        className={pressedPlay ? "nxc-clipbtn nxc-kbd" : "nxc-clipbtn"}
                        aria-pressed={pressedPlay}
                        aria-label={copy.playClip}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPressedPlay((p) => !p);
                        }}
                      >
                        {pressedPlay ? <Pause aria-hidden /> : <Play aria-hidden />}
                      </button>
                    )}
                  </div>
                ) : (
                  <button type="button" className="nxc-media" tabIndex={-1} aria-label={fmt(copy.show, { n: i + 1, title: it.title })} onClick={() => pick(i)}>
                    <Frame it={it} alt="" />
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        {open && words && (
          <div id={fullId} className="nxc-full" role="region" aria-label={s.title} data-showcase-entry={s.job}>
            <button ref={closeBtn} type="button" className="nxc-icon nxc-full-close" aria-label={copy.close} onClick={() => (setOpen(false), moreBtn.current?.focus())}>
              <X aria-hidden />
            </button>
            <p className="nxc-full-text">{s.prompt}</p>
          </div>
        )}
      </div>

      <div className="nxc-bar">
        <div className="nxc-controls">
          <button type="button" className="nxc-icon" aria-label={copy.prev} onClick={() => go(index - 1, true)}>
            <ChevronLeft aria-hidden />
          </button>
          <button type="button" className="nxc-icon nxc-run nxc-kbd" aria-pressed={paused} aria-label={copy.pause} onClick={toggleRun}>
            {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
          </button>
          <button ref={nextBtn} type="button" className="nxc-icon" aria-label={copy.next} onClick={() => go(index + 1, true)}>
            <ChevronRight aria-hidden />
          </button>
        </div>
        <ol className="nxc-dots" aria-hidden>
          {slides.map((it, i) => (
            <li key={it.job} data-on={i === index ? "true" : undefined}>
              {i === index && <span ref={bar} className="nxc-fill" />}
            </li>
          ))}
        </ol>
        <p className="nxc-pos" aria-hidden>
          <span>{fmt(copy.position, { n: index + 1, total: n })}</span>
          <span className="nxc-left">{left ? fmt(copy.left, { time: left }) : ""}</span>
        </p>
      </div>

      <div className="nxc-info" data-showcase-entry={s.job} data-model={s.modelName}>
        <h3 className="nxc-title">{s.title}</h3>
        <p className="nxc-meta">
          <span className="nx-ai-badge">{g.badge}</span>
          <span className="nxc-chip">
            {g.model} <strong>{s.modelName}</strong>
          </span>
          {s.leftOut && <span className="nxc-unavail">{s.leftOut === "shut_down" ? g.gone : g.notInStudio}</span>}
        </p>
        <p id={promptId} className="nxc-prompt">
          {words ? s.prompt : g.noPrompt}
        </p>
        <div className="nxc-actions">
          {s.href && (
            <Link href={s.href} prefetch={false} className="nxc-use" aria-describedby={`${promptId} ${noteId}`}>
              {g.use}
              <ArrowRight aria-hidden />
            </Link>
          )}
          {words && (
            <button type="button" className="nxc-ghost" onClick={copyPrompt} aria-describedby={promptId}>
              {copied === "ok" ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copy.copy}
            </button>
          )}
          {words && (
            <button ref={moreBtn} type="button" className="nxc-ghost" aria-expanded={open} aria-controls={open ? fullId : undefined} onClick={() => setOpen((o) => !o)}>
              {open ? copy.less : copy.more}
            </button>
          )}
          {copied === "fail" && <span className="nxc-copyfail">{copy.copyFailed}</span>}
        </div>
      </div>
      <p id={noteId} className="nxc-note">
        {copy.note}
      </p>
      <p className="nxc-reduced">{copy.reduced}</p>
      {/* Read out only for the visitor's own presses; a carousel that moves by itself does not talk over the page. */}
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
    </div>
  );
}

/** A card's picture: the sample's own poster, whole (contain), over a blurred copy of itself so every card has one shape. */
function Frame({ it, alt }: { it: SampleSlide; alt: string }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="nxc-back" src={it.posterSm} alt="" aria-hidden width={it.width} height={it.height} loading="lazy" decoding="async" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="nxc-pic"
        src={it.posterSm}
        srcSet={`${it.posterSm} 640w, ${it.poster} 1280w`}
        sizes="(min-width: 1024px) 720px, 80vw"
        alt={alt}
        width={it.width}
        height={it.height}
        loading="lazy"
        decoding="async"
      />
    </>
  );
}
