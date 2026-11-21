"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Clapperboard, Image as ImageIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { clipsAllowed } from "@/components/site/LoopClip";
import { aspectCss, mayPlay, onPlayChange, wantPlay } from "@/lib/templates/tile-play";
import type { TemplateDto } from "@/lib/templates/trends";

/** A tile asks to play on a touch screen once this much of it is on screen. */
export const TOUCH_PLAY_RATIO = 0.6;

/**
 * A template's face in the gallery: the poster at the template's own shape (the box is reserved by aspect-ratio, so nothing moves
 * when it loads), the title and "Video · 9:16 · 10 s" over its bottom edge, and the template's preview clip (public/templates/<slug>/
 * preview.mp4, our own Studio output) playing muted over the poster while it may.
 *
 * When it may: hovered or keyboard-focused on a pointer screen; at least 60% on screen on a touch one, one per visual row and four at
 * most on the page (lib/templates/tile-play.ts). Never under reduced motion, Save-Data or a slow link (LoopClip's clipsAllowed): there
 * the poster is all there is. The <video> element does not exist until the tile's first turn, so a gallery that is only looked at costs
 * its posters and nothing more; a paused tile goes back to its poster rather than a frozen frame.
 */
export function TemplateTileFace({ tpl, kindLabel }: { tpl: TemplateDto; kindLabel: string }) {
  const { t, fmt } = useI18n();
  const id = useId();
  const frameRef = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const preview = tpl.kind === "video" ? (tpl.preview_url ?? null) : null;
  const [motion, setMotion] = useState(false);
  const [touch, setTouch] = useState(false);
  const [pointed, setPointed] = useState(false);
  const [seen, setSeen] = useState(0);
  const [turn, setTurn] = useState(false);
  const [armed, setArmed] = useState(false);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!preview || !clipsAllowed()) return;
    setMotion(true);
    setTouch(window.matchMedia("(hover: none)").matches);
  }, [preview]);

  // Hover (a mouse or pen, never a touch's synthetic hover) and keyboard focus on the link that holds this face.
  useEffect(() => {
    const host = frameRef.current?.closest<HTMLElement>(".sb-card");
    if (!motion || !host) return;
    const enter = (e: PointerEvent) => {
      if (e.pointerType !== "touch") setPointed(true);
    };
    const leave = () => setPointed(false);
    const focusIn = () => setPointed(true);
    host.addEventListener("pointerenter", enter);
    host.addEventListener("pointerleave", leave);
    host.addEventListener("focusin", focusIn);
    host.addEventListener("focusout", leave);
    return () => {
      host.removeEventListener("pointerenter", enter);
      host.removeEventListener("pointerleave", leave);
      host.removeEventListener("focusin", focusIn);
      host.removeEventListener("focusout", leave);
    };
  }, [motion]);

  // How much of it is on screen: only asked on a touch screen, where being seen is the only way to ask.
  useEffect(() => {
    const el = frameRef.current;
    if (!motion || !touch || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setSeen(entries[entries.length - 1]?.intersectionRatio ?? 0), {
      threshold: [0, 0.3, TOUCH_PLAY_RATIO, 0.8, 1],
    });
    io.observe(el);
    return () => io.disconnect();
  }, [motion, touch]);

  useEffect(() => onPlayChange(() => setTurn(mayPlay(id))), [id]);

  // Ask, or withdraw. The coordinator answers for every tile at once (one per row, four at most).
  useEffect(() => {
    const el = frameRef.current;
    const want = motion && (pointed || (touch && seen >= TOUCH_PLAY_RATIO));
    if (!want || !el) {
      wantPlay(id, null);
      setTurn(false);
      return;
    }
    const r = el.getBoundingClientRect();
    wantPlay(id, { id, top: r.top, left: r.left, ratio: pointed ? 2 : seen });
    setTurn(mayPlay(id));
  }, [id, motion, touch, pointed, seen]);
  useEffect(() => () => wantPlay(id, null), [id]);

  useEffect(() => {
    if (turn) setArmed(true);
  }, [turn]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (turn) {
      try {
        void Promise.resolve(v.play()).catch(() => undefined);
      } catch {
        // A browser that cannot play it keeps the poster.
      }
    } else {
      v.pause();
      setLive(false);
    }
  }, [turn, armed]);

  const meta = [kindLabel, tpl.aspect, tpl.duration_s ? fmt(t.trends.seconds, { n: tpl.duration_s }) : null].filter(Boolean).join(" · ");
  return (
    <span ref={frameRef} className="sb-card-frame" style={{ aspectRatio: aspectCss(tpl.aspect) }} data-live={live || undefined} data-active={turn || undefined}>
      <span className="sb-card-media" data-kind={tpl.kind} aria-hidden>
        {tpl.poster_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- a static poster under /public/templates, already sized.
          <img src={tpl.poster_url} alt="" loading="lazy" decoding="async" />
        ) : tpl.kind === "video" ? (
          <Clapperboard className="size-6" strokeWidth={1.75} />
        ) : (
          <ImageIcon className="size-6" strokeWidth={1.75} />
        )}
        {armed && preview && (
          <video
            ref={videoRef}
            className="sb-card-video"
            src={preview}
            poster={tpl.poster_url ?? undefined}
            muted
            loop
            playsInline
            preload={turn ? "auto" : "none"}
            disablePictureInPicture
            tabIndex={-1}
            onPlaying={() => setLive(true)}
          />
        )}
      </span>
      <span className="sb-card-body">
        <span className="sb-card-title">{tpl.title}</span>
        <span className="sb-card-meta">{meta}</span>
      </span>
    </span>
  );
}
