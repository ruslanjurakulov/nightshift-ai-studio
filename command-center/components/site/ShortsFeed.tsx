"use client";

import "./autopilot-demo.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, ChevronDown, ChevronUp, Pause, Play, Smartphone, Volume2, VolumeX, X } from "lucide-react";
import { fmt } from "@/lib/i18n/core";
import type { SiteAutopilotDictionary } from "@/lib/i18n/site-autopilot/en";
import type { SiteDictionary } from "@/lib/i18n/site/en";
import { useMotionPaused } from "@/lib/site/motion";
import { holdClips } from "@/lib/site/clip-hold";
import type { ShortsItem } from "@/components/site/shorts";
import { AiMark } from "@/components/site/AiMark";

type NetworkInformation = { saveData?: boolean };
type GalleryCopy = Pick<SiteDictionary["gallery"], "badge" | "badgeName" | "try" | "tryAria" | "use" | "useNote" | "noPrompt">;

/** The marker of the history entry the feed adds, so the phone's back button closes the feed instead of leaving the page. */
const HISTORY_KEY = "nsShorts";

/** A clip may start by itself only with motion allowed, the page's pause switch off and no Save-Data: otherwise each waits for Play. */
function autoplayAllowed(paused: boolean): boolean {
  if (paused || typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  return !(navigator as Navigator & { connection?: NetworkInformation }).connection?.saveData;
}

/** Takes the feed's marker off the current history entry (before "Use this prompt" leaves the page). */
function dropMarker() {
  try {
    const state = { ...((window.history.state as Record<string, unknown> | null) ?? {}) };
    delete state[HISTORY_KEY];
    window.history.replaceState(state, "");
  } catch {
    /* Nothing to drop. */
  }
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The phone's Shorts feed of the vertical samples: a "Watch as Shorts" key on the explore grid (shown below 768px only, by CSS)
 * opens the 9:16 clips full screen, one per screen, swiped up and down (CSS scroll snap: the browser's own scrolling, so a swipe
 * feels native and a keyboard or a screen reader can still move). Only the clip on screen plays; its neighbours are mounted
 * with `preload="none"` and everything further is a poster, so opening the feed fetches one clip. Muted from the start; the
 * sound key is disabled with "This clip has no sound" for a clip without sound (components/site/shorts.ts: today every one).
 *
 * Each slide is the sample's own box (`data-showcase-entry`), the only kind of element on the public pages that may name a model:
 * the AI label, its prompt, the model's name, and "Use this prompt" / "Try this prompt" exactly as the gallery card. No maker's
 * "Powered by" line or link, and no visible pause key: a tap on the clip pauses or plays it, and a keyboard-only key (hidden
 * until it has focus) does the same (the owner's rules for the public site, 2026-11-13).
 *
 * A modal dialog: focus moves to Close and stays inside (Tab wraps), Escape and the back button close it (an entry is pushed on
 * open), the page under it does not scroll, and focus goes back to the key that opened it. Under reduced motion, the pause
 * switch or Save-Data nothing starts by itself: each clip starts on a tap, and next/previous move one clip at a time.
 */
export function ShortsFeed({ items, copy, g }: { items: readonly ShortsItem[]; copy: SiteAutopilotDictionary["shorts"]; g: GalleryCopy }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    // Our history entry on top: going back removes it, and popstate (below) closes the feed. Without it (blocked), just close.
    if (typeof window !== "undefined" && (window.history.state as Record<string, unknown> | null)?.[HISTORY_KEY]) window.history.back();
    else setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    try {
      // One entry per opening: an effect run twice (React's StrictMode in development) finds the marker and adds no second one.
      if (!(window.history.state as Record<string, unknown> | null)?.[HISTORY_KEY]) window.history.pushState({ ...(window.history.state ?? {}), [HISTORY_KEY]: true }, "");
    } catch {
      /* A sandboxed frame may refuse; Escape and Close still work. */
    }
    const onPop = () => setOpen(false);
    window.addEventListener("popstate", onPop);
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = "hidden";
    // The gallery's clips under the feed stop while it is open (lib/site/clip-hold.ts), so only the feed's clip plays.
    const release = holdClips();
    return () => {
      window.removeEventListener("popstate", onPop);
      html.style.overflow = before;
      release();
    };
  }, [open]);

  if (items.length === 0) return null;
  return (
    <div className="nx-shorts-entry">
      <button ref={opener} type="button" className="nx-shorts-open" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Smartphone aria-hidden />
        {copy.open}
      </button>
      <span className="nx-shorts-open-note">{fmt(copy.openNote, { n: String(items.length) })}</span>
      {open && typeof document !== "undefined" && createPortal(<Feed items={items} copy={copy} g={g} onClose={close} returnTo={opener} />, document.body)}
    </div>
  );
}

function Feed({
  items,
  copy,
  g,
  onClose,
  returnTo,
}: {
  items: readonly ShortsItem[];
  copy: SiteAutopilotDictionary["shorts"];
  g: GalleryCopy;
  onClose: () => void;
  returnTo: RefObject<HTMLButtonElement | null>;
}) {
  const paused = useMotionPaused();
  const [at, setAt] = useState(0);
  const [auto] = useState(() => autoplayAllowed(paused));
  // Whether the clip on screen should play: from the start when it may start by itself, otherwise only after its Play key.
  const [want, setWant] = useState(auto);
  const [muted, setMuted] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const videos = useRef(new Map<number, HTMLVideoElement>());
  const total = items.length;

  // The rest of the page is inert while the feed is open: a tap on the clip (which takes no focus) leaves focus on <body>, and
  // the next Tab must still land inside the feed. On close the page comes back first, then focus returns to the opening key.
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

  // Which slide is on screen: the one at least 60% in view of the feed (a swipe ends on a snap point, so one always is).
  useEffect(() => {
    const ul = list.current;
    if (!ul || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setAt(Number((e.target as HTMLElement).dataset.index));
      },
      { root: ul, threshold: 0.6 },
    );
    ul.querySelectorAll(".nx-shorts-slide").forEach((li) => io.observe(li));
    return () => io.disconnect();
  }, []);

  // A new clip on screen: it starts by itself only where that is allowed; elsewhere it waits for its own Play.
  useEffect(() => setWant(auto && !paused), [at, auto, paused]);

  // One clip plays at a time: the one on screen, while wanted and the tab is showing. The rest are paused and rewound.
  useEffect(() => {
    const sync = () => {
      videos.current.forEach((v, i) => {
        v.muted = muted;
        if (i === at && want && document.visibilityState === "visible") void Promise.resolve(v.play()).catch(() => undefined);
        else {
          v.pause();
          if (i !== at) v.currentTime = 0;
        }
      });
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [at, want, muted]);

  const goTo = (i: number) => {
    const next = Math.max(0, Math.min(total - 1, i));
    const ul = list.current;
    const li = ul?.querySelectorAll<HTMLElement>(".nx-shorts-slide")[next];
    if (ul && li && typeof ul.scrollTo === "function") ul.scrollTo({ top: li.offsetTop });
    setAt(next);
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
      return;
    }
    if (["ArrowDown", "PageDown", "ArrowUp", "PageUp"].includes(ev.key)) {
      ev.preventDefault();
      goTo(at + (ev.key === "ArrowDown" || ev.key === "PageDown" ? 1 : -1));
      return;
    }
    if (ev.key !== "Tab" || !root.current) return;
    // Focus stays in the feed: only what is not inert (the clip on screen and the feed's own keys) can take it.
    const els = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[inert]"));
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

  // Keys are read on the document, not the dialog: after a tap on the clip focus is on <body>, and Escape must still close.
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const k = (ev: KeyboardEvent) => keyRef.current(ev);
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);

  const cur = items[at];
  return (
    <div ref={root} className="nx-shorts" role="dialog" aria-modal="true" aria-label={copy.dialog}>
      <div className="nx-shorts-top">
        <p className="nx-shorts-pos" aria-live="polite">
          {fmt(copy.position, { n: String(at + 1), total: String(total) })}
        </p>
        <button ref={closeBtn} type="button" className="nx-shorts-btn" onClick={onClose} aria-label={copy.close}>
          <X aria-hidden />
        </button>
      </div>

      <ul ref={list} className="nx-shorts-list">
        {items.map((it, i) => {
          const here = i === at;
          // The clip on screen and its neighbours hold a video (lazy: preload none until it is the one on screen); the rest a poster.
          // Where nothing starts by itself, no video is mounted until its Play is pressed, so nothing is fetched unasked.
          const mounted = Math.abs(i - at) <= 1 && (auto || (here && want));
          const promptId = `shorts-prompt-${it.jobId}`;
          return (
            <li
              key={it.jobId}
              className="nx-shorts-slide"
              data-index={i}
              data-showcase-entry={it.jobId}
              aria-hidden={here ? undefined : true}
              aria-roledescription="slide"
            >
              {/* Tap the clip to pause or play it (no visible pause key: the owner's rule for the public site, 2026-11-13). */}
              <div className="nx-shorts-media" data-live={here && want ? "true" : undefined} onClick={here ? () => setWant((w) => !w) : undefined}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={it.posterSm} width={it.width} height={it.height} alt="" loading={Math.abs(i - at) <= 1 ? "eager" : "lazy"} decoding="async" />
                {mounted && (
                  <video
                    ref={(v) => {
                      if (v) videos.current.set(i, v);
                      else videos.current.delete(i);
                    }}
                    muted
                    loop
                    playsInline
                    preload={here ? "auto" : "none"}
                    poster={it.posterSm}
                    disablePictureInPicture
                    aria-hidden
                    tabIndex={-1}
                  >
                    <source src={it.sources.smWebm} type="video/webm" />
                    <source src={it.sources.smMp4} type="video/mp4" />
                  </video>
                )}
              </div>
              <div className="nx-shorts-shade" aria-hidden />
              {/* Where nothing starts by itself, a still says "tap to play"; the tap lands on the clip under it. */}
              {!auto && here && !want && (
                <span className="nx-shorts-btn nx-shorts-playbig" aria-hidden>
                  <Play />
                </span>
              )}
              {i === 0 && total > 1 && here && <p className="nx-shorts-hint" aria-hidden>{copy.hint}</p>}
              <div className="nx-shorts-cap" inert={!here}>
                <span className="nx-shorts-badge"><AiMark short={g.badge} name={g.badgeName} /></span>
                <p className="nx-shorts-model">
                  {/* The model's name and the AI label, and no maker's "Powered by" line or link (owner's rule, 2026-11-13). */}
                  {copy.madeBy} <strong>{it.modelName}</strong>
                </p>
                <p id={promptId} className="nx-shorts-prompt" lang="en">
                  <span className="nx-ap-sr">{copy.prompt}: </span>
                  {it.prompt.trim() ? it.prompt : g.noPrompt}
                </p>
                {it.href && (
                  <>
                    {/* `replace`: the Studio takes the feed's own history entry, so Back from it returns to the page, not to a
                        stale "feed open" entry; the marker is dropped first in case the navigation is a full load. */}
                    <Link
                      href={it.href}
                      prefetch={false}
                      replace
                      onClick={dropMarker}
                      className="nx-shorts-use"
                      aria-label={it.leftOut ? undefined : fmt(g.tryAria, { model: it.modelName })}
                      aria-describedby={it.leftOut ? `${promptId} shorts-use-${it.jobId}` : promptId}
                    >
                      {it.leftOut ? g.use : g.try}
                      <ArrowRight aria-hidden />
                    </Link>
                    {it.leftOut && (
                      <p id={`shorts-use-${it.jobId}`} className="nx-shorts-usenote">
                        {g.useNote}
                      </p>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="nx-shorts-side">
        {/* For the keyboard only: hidden until it has focus (a tap on the clip does the same). */}
        <button type="button" className="nx-shorts-btn nx-shorts-kbd" onClick={() => setWant((w) => !w)} aria-label={want ? copy.pause : copy.play}>
          {want ? <Pause aria-hidden /> : <Play aria-hidden />}
        </button>
        <button
          type="button"
          className="nx-shorts-btn"
          onClick={() => setMuted((m) => !m)}
          disabled={!cur.sound}
          aria-label={!cur.sound ? copy.noSound : muted ? copy.unmute : copy.mute}
          title={!cur.sound ? copy.noSound : undefined}
        >
          {muted || !cur.sound ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
        </button>
        <button type="button" className="nx-shorts-btn" onClick={() => goTo(at - 1)} disabled={at === 0} aria-label={copy.prev}>
          <ChevronUp aria-hidden />
        </button>
        <button type="button" className="nx-shorts-btn" onClick={() => goTo(at + 1)} disabled={at === total - 1} aria-label={copy.next}>
          <ChevronDown aria-hidden />
        </button>
      </div>
    </div>
  );
}
