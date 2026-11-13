"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Pause, Play } from "lucide-react";
import { fmt } from "@/lib/i18n/core";
import { firstSentence, ringIndex, type SampleSlide } from "@/lib/site/carousel";
import { useMotionPaused } from "@/lib/site/motion";
import type { SiteCarouselDictionary } from "@/lib/i18n/site-carousel";
import { clipsAllowed } from "@/components/site/LoopClip";
import { usePageVisible, useReducedMotion, useClipTurn } from "@/components/site/clip-turns";
import "@/components/site/prompt-ticker.css";

export type TickerGalleryCopy = { badge: string; model: string; altClip: string };

/** How long a result stays after its words are typed: its clip to the end, but never less than MIN or more than MAX. */
const MIN_MS = 4000;
const MAX_MS = 9000;

/**
 * Prompt → result, under the hero: a real sample's prompt is typed out (its first sentence; the label and the ellipsis say it is
 * cut), then its own result comes into focus and plays. Then the next sample. Every prompt is a job's own words and every result
 * is that job's own clip, named with its model in the sample's box; nothing is typed that no job was given.
 *
 * While the words are typed the result waits blurred (it is the real result, not a stand-in), and it sharpens when they are done.
 * Screen readers get the whole sentence at once, never letter by letter. Under reduced motion nothing types or plays: the first
 * sample stands still, whole, and "Next example" steps through them. The page's pause switch holds it; it types only while on
 * screen, and its clip plays only with a turn (components/site/clip-turns.ts).
 */
export function PromptTicker({ items, copy, g }: { items: SampleSlide[]; copy: SiteCarouselDictionary["ticker"]; g: TickerGalleryCopy }) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [mounted, setMounted] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [i, setI] = useState(0);
  // How many characters of the sentence are shown; null = all of it (the server's and reduced motion's picture).
  const [typed, setTyped] = useState<number | null>(null);
  const [shown, setShown] = useState(0);
  const [inView, setInView] = useState(false);
  // The visitor's hold: a tap on the result, or the keyboard's button (there is no visible pause button).
  const [held, setHeld] = useState(false);
  const reduced = useReducedMotion();
  const pagePaused = useMotionPaused();
  const visible = usePageVisible();

  useEffect(() => {
    setAllowed(clipsAllowed());
    setMounted(true);
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const auto = mounted && !reduced && !pagePaused && !held && visible && inView;
  const s = items[i] ?? items[0];
  const line = s ? firstSentence(s.prompt) : { text: "", cut: false };
  const chars = Array.from(line.text);
  const done = typed === null || typed >= chars.length;
  const turn = useClipTurn(box, mounted && !reduced && !pagePaused && !held && done);
  const showVideo = !!s && s.clip !== null && allowed && !reduced && done && typed !== null;
  const playing = showVideo && turn && auto;

  const advance = (step: number, byVisitor: boolean) => {
    setI((at) => ringIndex(at, step, items.length));
    setShown(0);
    // A visitor's press shows the next one whole at once when nothing may move; otherwise it is typed like the rest.
    setTyped(byVisitor && !auto ? null : 0);
  };

  // The first time it can move, it starts from an empty line (the server's whole sentence stays for reduced motion and no script).
  useEffect(() => {
    if (auto && typed === null && shown === 0) setTyped(0);
  }, [auto, typed, shown]);

  // Typing: about 2.4 s for a sentence, whatever its length, between 18 and 45 ms a character.
  useEffect(() => {
    if (!auto || typed === null || typed >= chars.length) return;
    const step = Math.min(45, Math.max(18, 2400 / Math.max(1, chars.length)));
    const id = window.setTimeout(() => setTyped((n) => (n === null ? n : n + 1)), step);
    return () => window.clearTimeout(id);
  }, [auto, typed, chars.length]);

  // The result's turn: until its clip ends (MIN..MAX), or MIN for a result shown as its still. `shown` counts the time it had.
  useEffect(() => {
    if (!auto || typed === null || typed < chars.length) return;
    const start = performance.now() - shown;
    let id = 0;
    const tick = () => {
      const t = performance.now() - start;
      const v = video.current;
      const ended = !!v && v.ended;
      if (t >= MAX_MS || (t >= MIN_MS && (ended || !showVideo || !turn))) {
        advance(1, false);
        return;
      }
      setShown(t);
      id = window.setTimeout(tick, 250);
    };
    id = window.setTimeout(tick, 250);
    return () => window.clearTimeout(id);
    // `shown` is read once when the turn (re)starts, so a pause resumes where it was.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, typed, chars.length, showVideo, turn]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (playing) void Promise.resolve(v.play()).catch(() => undefined);
    else v.pause();
  }, [playing, showVideo, i]);

  if (!s) return null;
  const blurred = typed !== null && !done;
  return (
    <div ref={box} className="nxt" data-showcase-entry={s.job} data-model={s.modelName} data-phase={blurred ? "typing" : "result"}>
      <div className="nxt-words">
        <p className="nxt-key">{copy.prompt}</p>
        <p className="nxt-line">
          <span className="nxt-typed" aria-hidden>
            {typed === null ? line.text : chars.slice(0, typed).join("")}
            {done && line.cut ? "…" : ""}
            <span className="nxt-caret" data-on={blurred ? "true" : undefined} />
          </span>
          <span className="sr-only">
            {line.text}
            {line.cut ? "…" : ""}
          </span>
        </p>
        <p className="nxt-meta">
          <span className="nx-ai-badge">{g.badge}</span>
          <span className="nxt-model">
            {g.model} <strong>{s.modelName}</strong>
          </span>
        </p>
        {items.length > 1 && (
          <button type="button" className="nxt-next" onClick={() => advance(1, true)}>
            {copy.next}
            <ArrowRight aria-hidden />
          </button>
        )}
      </div>
      <div className="nxt-media" aria-label={copy.result} role="group" data-held={held ? "true" : undefined} onClick={() => !reduced && setHeld((h) => !h)}>
        {mounted && !reduced && (
          <button
            type="button"
            className="nxt-hold nxt-kbd"
            aria-pressed={held}
            aria-label={copy.pause}
            onClick={(e) => {
              e.stopPropagation();
              setHeld((h) => !h);
            }}
          >
            {held ? <Play aria-hidden /> : <Pause aria-hidden />}
          </button>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img key={s.job} className="nxt-pic" src={s.posterSm} alt={fmt(g.altClip, { model: s.modelName })} width={s.width} height={s.height} loading="lazy" decoding="async" />
        {showVideo && s.clip && (
          <video key={`v-${s.job}`} ref={video} className="nxt-video" muted playsInline preload="auto" poster={s.posterSm} disablePictureInPicture aria-hidden tabIndex={-1}>
            <source src={s.clip.smWebm} type="video/webm" />
            <source src={s.clip.smMp4} type="video/mp4" />
          </video>
        )}
      </div>
    </div>
  );
}
