"use client";

import "./sample-detail.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, X } from "lucide-react";
import { clipsAllowed } from "@/components/site/LoopClip";
import { ClipPause } from "@/components/site/ClipPause";
import { holdClips } from "@/lib/site/clip-hold";
import { useMotionPaused, useMotionTap } from "@/lib/site/motion";
import { fmt } from "@/lib/i18n/core";

/** Everything one sample's dialog shows, as plain data from the gallery (a Server Component). */
export type SampleDetailData = {
  jobId: string;
  modelName: string;
  /** The words, or the "no words" line for a sample made from a picture alone. */
  prompt: string;
  /** The card's own prompt element, which describes the button that opens this dialog. */
  cardPromptId: string;
  /** "Made {date}", already in the page's language. */
  made: string;
  createdAt: string;
  width: number;
  height: number;
  poster: string;
  srcSet: string;
  clip: { mp4: string; webm: string; smMp4: string; smWebm: string } | null;
  /** The picture's description, with the model: only the dialog names it (the card's picture says "AI-generated" alone). */
  alt: string;
  leftOut: "preview" | "shut_down" | null;
  href: string | null;
  format: { id: string; title: string; body: string } | null;
  /** The sample's own picture this clip was animated from, when that picture is itself a sample here. */
  source: { jobId: string; src: string; width: number; height: number; alt: string; modelName: string } | null;
};

export type SampleDetailCopy = {
  open: string;
  close: string;
  detail: string;
  badge: string;
  model: string;
  prompt: string;
  notInStudio: string;
  gone: string;
  try: string;
  tryAria: string;
  use: string;
  useNote: string;
  source: string;
  pause: string;
};

/** The marker of the history entry the dialog adds, so the phone's back button closes it instead of leaving the page. */
const HISTORY_KEY = "nsSample";
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function hasMarker(): boolean {
  return Boolean((window.history.state as Record<string, unknown> | null)?.[HISTORY_KEY]);
}

/** Takes the dialog's marker off the current history entry (before "Use this prompt" leaves the page). */
function dropMarker() {
  try {
    const state = { ...((window.history.state as Record<string, unknown> | null) ?? {}) };
    delete state[HISTORY_KEY];
    window.history.replaceState(state, "");
  } catch {
    /* Nothing to drop. */
  }
}

/**
 * One sample of the explore grid, opened: the card (components/site/ShowcaseGallery.tsx) is the picture alone, as the explore
 * grids of the AI studios lay theirs out, and this is where its words, its model and its day are read. The button covers the
 * card; pressing it (a tap, a click, Enter or Space) opens the sample in a modal dialog with the whole picture or clip, the whole
 * prompt, the model, the day, the picture it was made from when that is one of ours, the honest "not in the Studio" line and
 * "Try this prompt" / "Use this prompt" with its note: everything the card used to stack under every picture, said once.
 *
 * The dialog is the sample's own box (`data-showcase-entry`), the only kind of element on the public pages that may name a model
 * (tests/helpers/showcase-scope.ts). It is drawn on <body> (a portal), because the gallery's section clips what overflows it.
 *
 * A modal as the phone's Shorts feed is (components/site/ShortsFeed.tsx): focus moves to Close and stays inside (Tab wraps), the
 * rest of the page is inert, Escape and the back button close it (one history entry per opening), the page under it does not
 * scroll, the grid's clips hold their frame (lib/site/clip-hold.ts), and focus goes back to the card. The clip follows every rule
 * the grid's clips follow (LoopClip clipsAllowed): never fetched under reduced motion, Save-Data or a slow link (the still shows),
 * stopped by the page's pause switch; a tap on it is the pointer's pause (lib/site/motion.ts), and a keyboard has the hidden pause
 * key (ClipPause). No visible pause button and no maker's credit (the owner's rules for the public site, 2026-11-13).
 */
export function SampleDetail({ d, copy }: { d: SampleDetailData; copy: SampleDetailCopy }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    // Our history entry on top: going back removes it, and popstate (below) closes the dialog. Without it (blocked), just close.
    if (typeof window !== "undefined" && hasMarker()) window.history.back();
    else setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    try {
      // One entry per opening: an effect run twice (StrictMode in development) finds the marker and adds no second one.
      if (!hasMarker()) window.history.pushState({ ...(window.history.state ?? {}), [HISTORY_KEY]: true }, "");
    } catch {
      /* A sandboxed frame may refuse; Escape and Close still work. */
    }
    const onPop = () => setOpen(false);
    window.addEventListener("popstate", onPop);
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = "hidden";
    const release = holdClips();
    return () => {
      window.removeEventListener("popstate", onPop);
      html.style.overflow = before;
      release();
    };
  }, [open]);

  return (
    <>
      <button
        ref={opener}
        type="button"
        className="nx-gallery-open"
        aria-haspopup="dialog"
        aria-label={copy.open}
        aria-describedby={d.cardPromptId}
        onClick={() => setOpen(true)}
      />
      {open && typeof document !== "undefined" && createPortal(<Dialog d={d} copy={copy} onClose={close} returnTo={opener} />, document.body)}
    </>
  );
}

function Dialog({ d, copy, onClose, returnTo }: { d: SampleDetailData; copy: SampleDetailCopy; onClose: () => void; returnTo: RefObject<HTMLButtonElement | null> }) {
  const root = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const paused = useMotionPaused();
  // Decided once, when the visitor opened it: the dialog exists only in the browser, so the server never renders a different answer.
  const [allowed] = useState(() => d.clip !== null && clipsAllowed());
  // A phone gets the 640 file, a wide screen the 1280 one (the same split as LoopClip; a source's `media` is not honoured).
  const [wide] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(min-width: 860px)").matches);
  // A tap on the clip is the pointer's pause, as everywhere on the public pages.
  useMotionTap();

  // The rest of the page is inert while the dialog is open; on close it comes back first, then focus returns to the card.
  useEffect(() => {
    const me = root.current;
    const others = [...document.body.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== me && !el.inert);
    others.forEach((el) => (el.inert = true));
    closeBtn.current?.focus();
    const back = returnTo.current;
    return () => {
      others.forEach((el) => (el.inert = false));
      back?.focus();
    };
  }, [returnTo]);

  // The clip plays while the page's pause switch is off and the tab is showing.
  useEffect(() => {
    const v = video.current;
    if (!allowed || !v) return;
    const sync = () => {
      if (!paused && document.visibilityState === "visible") void Promise.resolve(v.play()).catch(() => undefined);
      else v.pause();
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [allowed, paused]);

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
      return;
    }
    if (ev.key !== "Tab" || !root.current) return;
    const els = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (els.length === 0) return;
    const first = els[0];
    const last = els[els.length - 1];
    if (ev.shiftKey && (document.activeElement === first || !root.current.contains(document.activeElement))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && (document.activeElement === last || !root.current.contains(document.activeElement))) {
      ev.preventDefault();
      first.focus();
    }
  };
  // Read on the document, not the dialog: after a tap on the clip focus is on <body>, and Escape must still close.
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const k = (ev: KeyboardEvent) => keyRef.current(ev);
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);

  const promptId = `sample-detail-prompt-${d.jobId}`;
  const noteId = `sample-use-${d.jobId}`;
  const media = { aspectRatio: `${d.width} / ${d.height}`, "--sd-r": (d.width / d.height).toFixed(4) } as CSSProperties;
  return (
    <div ref={root} className="nx-sd" role="dialog" aria-modal="true" aria-label={copy.detail} aria-describedby={promptId} data-showcase-entry={d.jobId}>
      <button ref={closeBtn} type="button" className="nx-sd-close" onClick={onClose} aria-label={copy.close}>
        <X aria-hidden />
      </button>
      <div className="nx-sd-in">
        <div className="nx-sd-stage">
          <div className="nx-sd-media" data-clip={d.clip ? "sample" : undefined} style={media}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={d.poster} srcSet={d.srcSet} sizes="(min-width: 900px) calc(100vw - 460px), 100vw" width={d.width} height={d.height} alt={d.alt} decoding="async" />
            {allowed && d.clip && (
              <video ref={video} muted loop playsInline preload="auto" poster={d.poster} disablePictureInPicture aria-hidden tabIndex={-1}>
                <source src={wide ? d.clip.webm : d.clip.smWebm} type="video/webm" />
                <source src={wide ? d.clip.mp4 : d.clip.smMp4} type="video/mp4" />
              </video>
            )}
            <span className="nx-result-badge">{copy.badge}</span>
            {d.clip && <ClipPause label={copy.pause} />}
          </div>
        </div>
        <div className="nx-sd-panel">
          {d.format && (
            <div className="nx-gallery-format" data-format={d.format.id}>
              <h3 className="nx-gallery-format-t">{d.format.title}</h3>
              <p className="nx-gallery-format-b">{d.format.body}</p>
            </div>
          )}
          <p className="nx-gallery-key">{copy.prompt}</p>
          <p id={promptId} className="nx-sd-prompt">
            {d.prompt}
          </p>
          <p className="nx-gallery-model">
            <span className="nx-gallery-key">{copy.model}</span> <strong>{d.modelName}</strong>
          </p>
          {d.leftOut && <p className="nx-gallery-unavailable">{d.leftOut === "shut_down" ? copy.gone : copy.notInStudio}</p>}
          <p className="nx-gallery-date">
            <time dateTime={d.createdAt}>{d.made}</time>
          </p>
          {d.source && (
            <figure className="nx-gallery-source" data-source-entry={d.source.jobId}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={d.source.src} width={d.source.width} height={d.source.height} alt={d.source.alt} loading="lazy" decoding="async" />
              <figcaption>
                <span className="nx-gallery-key">{copy.source}</span> <strong>{d.source.modelName}</strong>
              </figcaption>
            </figure>
          )}
          {d.href && (
            <>
              {/* Named by the model only where the link opens that model; elsewhere "Use this prompt" and a note on which model runs
                  it. `replace`: the Studio takes the dialog's history entry, so Back from it returns to the page, not to a stale
                  "dialog open" entry; the marker is dropped first in case the navigation is a full load. */}
              <Link
                href={d.href}
                prefetch={false}
                replace
                onClick={dropMarker}
                className="nx-btn nx-sd-try"
                aria-label={d.leftOut ? undefined : fmt(copy.tryAria, { model: d.modelName })}
                aria-describedby={d.leftOut ? `${promptId} ${noteId}` : promptId}
              >
                {d.leftOut ? copy.use : copy.try}
                <ArrowRight aria-hidden />
              </Link>
              {d.leftOut && (
                <p id={noteId} className="nx-gallery-use">
                  {copy.useNote}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
