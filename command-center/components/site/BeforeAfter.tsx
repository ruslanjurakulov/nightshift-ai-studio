"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { Pause, Play } from "lucide-react";
import { fmt } from "@/lib/i18n/core";
import { sliderKey, type SampleSlide } from "@/lib/site/carousel";
import { useMotionPaused } from "@/lib/site/motion";
import type { SiteCarouselDictionary } from "@/lib/i18n/site-carousel";
import { clipsAllowed } from "@/components/site/LoopClip";
import { usePageVisible, useReducedMotion, useClipNear, useClipTurn } from "@/components/site/clip-turns";
import "@/components/site/before-after.css";

export type CompareGalleryCopy = { badge: string; model: string; altClip: string; altImage: string };

/**
 * Picture → video: one of our pictures (a text-to-image sample) and the clip another model made from that exact picture (an
 * image-to-video sample whose input is that job; lib/site/carousel.ts beforeAfterPairs), one over the other, with a divider the
 * visitor drags to compare. The picture is on the left of the line, the playing clip on the right, each labelled, and both models
 * are named under it with the AI-generated label (no maker's credit line: the owner's rule of 2026-11-13 keeps those off public
 * pages).
 *
 * The divider is a slider (role="slider", aria-valuenow 0..100 = how much of the frame is the picture): mouse, touch (a
 * horizontal drag; a vertical one still scrolls the page), and the APG slider keys. The clip follows the page's rules: muted, only
 * while it has a turn (components/site/clip-turns.ts) and the page's pause switch is off; under reduced motion or Save-Data it is
 * not fetched until its play button is pressed, and the video side shows the clip's first frame (its poster) until then.
 */
export function BeforeAfter({ clip, picture, title, copy, g }: { clip: SampleSlide; picture: SampleSlide; title: string; copy: SiteCarouselDictionary["compare"]; g: CompareGalleryCopy }) {
  const frame = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  // The pointer pressed on the frame: where it went down, and whether it has moved far enough to be a drag (not a tap).
  const drag = useRef<{ id: number; x: number; moved: boolean; onHandle: boolean } | null>(null);
  const [stopped, setStopped] = useState(false);
  const [pos, setPos] = useState(50);
  const [mounted, setMounted] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [failed, setFailed] = useState(false);
  const reduced = useReducedMotion();
  const pagePaused = useMotionPaused();
  const visible = usePageVisible();

  useEffect(() => {
    setAllowed(clipsAllowed());
    setMounted(true);
  }, []);

  const auto = mounted && allowed && !reduced && !pagePaused && !stopped;
  const turn = useClipTurn(frame, mounted && (auto || pressed));
  const near = useClipNear(frame, mounted);
  // Clips started by hand (reduced motion, Save-Data, a slow link): a visible play button, toggled by `pressed`. Otherwise the clip
  // plays by itself and its only control is the keyboard's pause, toggled by `stopped`.
  const byHand = reduced || !allowed;
  const hasClip = clip.clip !== null && !failed;
  // A clip playing by itself is put in the page when the frame comes within half a screen of the viewport (so it is buffered and
  // its first frame decoded before it shows), and taken out again, not only paused, once it is neither near nor on screen, so a
  // phone holds no decoder for it far away (components/site/clip-turns.ts); it comes back from the cache.
  const showVideo = hasClip && (pressed || (auto && (turn || near)));
  const playing = showVideo && turn && visible && (pressed || auto);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (playing) void Promise.resolve(v.play()).catch(() => undefined);
    else v.pause();
  }, [playing, showVideo]);

  const at = (clientX: number) => {
    const r = frame.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    setPos(Math.round(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100))));
  };
  // The clip's pause is a tap on the frame (there is no visible pause button; the keyboard has its own, shown when focused). A drag,
  // or a press on the divider itself, moves the divider instead.
  const togglePlay = () => {
    if (byHand) setPressed((p) => !p);
    else setStopped((x) => !x);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".nxb-play")) return;
    const onHandle = !!(e.target as HTMLElement).closest(".nxb-handle");
    drag.current = { id: e.pointerId, x: e.clientX, moved: onHandle, onHandle };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientX - d.x) > 4) d.moved = true;
    if (d.moved) at(e.clientX);
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved && hasClip) togglePlay();
  };
  const onCancel = () => {
    drag.current = null;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = sliderKey(pos, e.key);
    if (next === null) return;
    e.preventDefault();
    setPos(next);
  };

  return (
    // The `#sample-` anchor: a model tile links to its sample's box, and for a clip made from a picture this is the only one on the page.
    <figure id={`sample-${clip.job}`} className="nxb" data-showcase-entry={clip.job} data-model={clip.modelName}>
      <div
        ref={frame}
        className="nxb-frame"
        data-shape={clip.height > clip.width * 1.15 ? "tall" : "wide"}
        style={{ aspectRatio: `${clip.width} / ${clip.height}`, "--nxb-pos": pos } as CSSProperties}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
      >
        <div className="nxb-layer nxb-after">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={clip.posterSm} srcSet={`${clip.posterSm} 640w, ${clip.poster} 1280w`} sizes="(min-width: 1024px) 640px, 100vw" width={clip.width} height={clip.height} alt={fmt(g.altClip, { model: clip.modelName })} loading="lazy" decoding="async" />
          {showVideo && clip.clip && (
            <video ref={video} className="nxb-video" muted loop playsInline preload="auto" poster={clip.posterSm} disablePictureInPicture aria-hidden tabIndex={-1} onError={() => setFailed(true)}>
              <source src={clip.clip.smWebm} type="video/webm" />
              <source src={clip.clip.smMp4} type="video/mp4" />
            </video>
          )}
        </div>
        <div className="nxb-layer nxb-before" data-source-entry={picture.job}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={picture.posterSm} srcSet={`${picture.posterSm} 640w, ${picture.poster} 1280w`} sizes="(min-width: 1024px) 640px, 100vw" width={picture.width} height={picture.height} alt={fmt(g.altImage, { model: picture.modelName })} loading="lazy" decoding="async" />
        </div>
        <span className="nxb-tag" data-side="before" aria-hidden>
          {copy.picture}
        </span>
        <span className="nxb-tag" data-side="after" aria-hidden>
          {copy.video}
        </span>
        <div
          className="nxb-handle"
          role="slider"
          tabIndex={0}
          aria-label={fmt(copy.slider, { title })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pos}
          aria-valuetext={fmt(copy.value, { n: pos, m: 100 - pos })}
          aria-orientation="horizontal"
          onKeyDown={onKey}
        >
          <span className="nxb-knob" aria-hidden />
        </div>
        {mounted && hasClip && (
          // Named for what it does and toggled from the visitor's own choice, never from whether the clip plays yet (a clip waiting
          // for its turn must not flip the button). Starting by hand is a visible play button; every pause is the keyboard's only,
          // shown when focused, because a tap on the frame is the pause for everyone else.
          <button
            type="button"
            className={byHand && !pressed ? "nxb-play" : "nxb-play nxb-kbd"}
            aria-pressed={byHand ? pressed : stopped}
            aria-label={byHand ? copy.playClip : copy.pauseClip}
            onClick={togglePlay}
          >
            {(byHand ? pressed : !stopped) ? <Pause aria-hidden /> : <Play aria-hidden />}
          </button>
        )}
      </div>
      <figcaption className="nxb-cap">
        <h3 className="nxb-title">{title}</h3>
        <span className="nx-ai-badge">{g.badge}</span>
        <p className="nxb-credit">
          <span className="nxb-key">{copy.pictureBy}</span> <strong>{picture.modelName}</strong>
        </p>
        <p className="nxb-credit">
          <span className="nxb-key">{copy.videoBy}</span> <strong>{clip.modelName}</strong>
        </p>
        {clip.prompt.trim() && (
          <>
            <p className="nxb-key">{copy.prompt}</p>
            <p className="nxb-prompt">{clip.prompt}</p>
          </>
        )}
        <p className="nxb-still">{copy.still}</p>
      </figcaption>
    </figure>
  );
}
