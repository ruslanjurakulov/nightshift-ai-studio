"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Film, Plus, X } from "lucide-react";
import { PROMPT_MAX, TEXT_TOOL, attachedHref, promptHref, type PromptTool } from "@/lib/site/prompt-link";
import {
  ATTACH_ACCEPT,
  checkAttachment,
  dropExpired,
  indexedDbStore,
  keepPending,
  type AttachKind,
  type AttachProblem,
} from "@/lib/site/pending-attachment";
import { formatMediaBytes } from "@/lib/media";
import { fmt } from "@/lib/i18n/core";

export type PromptBarCopy = {
  label: string;
  placeholder: string;
  /** "+": a picture or a video, from the device. */
  attach: string;
  /** The chip's group label: "Attached: {name}". */
  attached: string;
  /** The chip's ×: "Remove {name}". */
  remove: string;
  picture: string;
  /** picture / video while no Studio model is on sale: no promise of a video. */
  pictureClosed: string;
  videoClosed: string;
  video: string;
  submit: string;
  empty: string;
  /** The file is not a picture or a video the library takes. */
  badType: string;
  /** Over the upload cap: "{max}". */
  tooBig: string;
  emptyFile: string;
  /** This browser would not keep the file for the next page. */
  keepFailed: string;
  noteIn: string;
  noteOut: string;
  noteInClosed: string;
  noteOutClosed: string;
  /** With a file attached: where it is until the Studio has it. */
  keptOut: string;
  keptIn: string;
  ideas: string;
};

/** A real sample's words the visitor can start from: its format's name (the chip) and the prompt its job was given. */
export type PromptIdea = { id: string; label: string; tool: PromptTool; prompt: string };

/** At most this many lines before the box scrolls (its line height is 24 px). */
const MAX_LINES = 6;
/**
 * The composer docks once the page has moved this far from its top, and comes back into the first screen above UNDOCK_AT (the gap
 * keeps it from flickering on a slow scroll at the edge). Not "once its place has left the window": on a tall window (a phone showing
 * the desktop site, a tablet, a large monitor) that place stays in view while the visitor is already reading the sections under it,
 * and the box went UP with the page instead of coming down with the screen (measured on the live site, 1180x2560: undocked until
 * about 500 px of scroll).
 */
export const DOCK_AT = 48;
export const UNDOCK_AT = 16;

type Picked = { file: File; kind: AttachKind; mime: string; url: string };
type Problem = "words" | AttachProblem | "keep";

// The travel between the first screen and the bottom is measured before the change and played after it, before paint.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The landing's composer, as a chat app's is: one line that grows to six, "+" on the left, the send key on the right, inside one
 * glass box. It starts in the first screen and, as soon as the visitor scrolls, travels down to the bottom centre of the window and
 * stays there on every section; back at the top it travels back. Its place in the first screen keeps its height (nothing under it
 * moves), and the page's sticky start bar steps aside while it is docked (html[data-composer="docked"], site-next.css).
 *
 * There is no "what to make" key: what is attached decides it. Nothing attached opens the Studio's text-to-video form with the words.
 * "+" opens the system's file picker (a picture or a video, nothing else asked of the device: no camera, no microphone). The file is
 * checked here against the library's own type list and upload cap, shown as a chip with a ×, and, on send, kept in THIS browser only
 * (lib/site/pending-attachment.ts) while the Studio opens, through sign-up when signed out. The Studio uploads it into the person's
 * library and opens the tool for its kind. Nothing is sent from this page, and nothing is priced, held or started (CLAUDE.md #3).
 *
 * Enter sends, Shift+Enter is a new line, Escape leaves the box. Create is off until this script runs, so no form is ever sent
 * that would drop the words. The light under the pointer is off on touch and under reduced motion.
 */
export function PromptBar({
  copy,
  ideas,
  signedIn = false,
  studioOpen = false,
}: {
  copy: PromptBarCopy;
  ideas: PromptIdea[];
  signedIn?: boolean;
  /**
   * Whether any Studio model is on sale (lib/site/tool-samples.ts studioToolsOpen). Closed by default: the note then says the form
   * opens but nothing can be made there today, rather than "nothing starts until you press Generate" (CLAUDE.md #5).
   */
  studioOpen?: boolean;
}) {
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [words, setWords] = useState("");
  const [problem, setProblem] = useState<{ kind: Problem; max?: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [docked, setDocked] = useState(false);
  const [reserve, setReserve] = useState<number | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [atEnd, setAtEnd] = useState(false);
  const [inUse, setInUse] = useState(false);
  const dockedRef = useRef(false);
  const travelFrom = useRef<DOMRect | null>(null);

  useEffect(() => setReady(true), []);

  // Back to this page from the Studio or sign-up (the browser's back button restores it from its page cache): the send key was left
  // busy by the navigation, and would stay off for good.
  useEffect(() => {
    const back = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", back);
    return () => window.removeEventListener("pageshow", back);
  }, []);

  // A file kept for the Studio more than an hour ago and never picked up is removed from this browser.
  useEffect(() => {
    void dropExpired(indexedDbStore());
  }, []);

  // The thumbnail's object URL lives as long as the chip.
  useEffect(() => {
    if (!picked) return;
    return () => URL.revokeObjectURL(picked.url);
  }, [picked]);

  // Docked from DOCK_AT px of scroll, back in the first screen at UNDOCK_AT; read at most once a frame.
  useEffect(() => {
    let frame = 0;
    const read = (travel = true) => {
      frame = 0;
      const y = window.scrollY;
      const next = dockedRef.current ? y > UNDOCK_AT : y > DOCK_AT;
      if (next === dockedRef.current) return;
      const el = form.current;
      if (el) {
        if (travel) travelFrom.current = el.getBoundingClientRect();
        if (next) setReserve(el.offsetHeight);
      }
      dockedRef.current = next;
      setDocked(next);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => read());
    };
    // A page opened (or reloaded) already scrolled down starts docked, without the travel.
    read(false);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  // The travel: from where the box was to where it is now, by `translate` (the docked box's own centring is `transform`, which this
  // composes with). None under reduced motion, and none where the browser has no Web Animations.
  useIsoLayoutEffect(() => {
    const el = form.current;
    const from = travelFrom.current;
    travelFrom.current = null;
    if (!el || !from || typeof el.animate !== "function") return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = el.getBoundingClientRect();
    const dx = Math.round(from.left + from.width / 2 - (to.left + to.width / 2));
    const dy = Math.round(from.top - to.top);
    if (!dx && !dy) return;
    el.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0px 0px" }], { duration: 420, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" });
  }, [docked]);

  // The page reads the docked box's live height (--nx-dock-h) for the room it leaves at its end and above a scrolled-to anchor. Its
  // place in the first screen keeps the height it had when it docked: resizing that place while docked would move everything the
  // visitor is reading below it (a layout shift); on undock the place sizes itself again, at the top, where the box returns.
  useEffect(() => {
    const el = form.current;
    const root = document.documentElement;
    if (!docked || !el) return;
    const measure = () => root.style.setProperty("--nx-dock-h", `${el.offsetHeight}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return () => root.style.removeProperty("--nx-dock-h");
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--nx-dock-h");
    };
  }, [docked]);

  useEffect(() => {
    const root = document.documentElement;
    if (docked) root.setAttribute("data-composer", "docked");
    else root.removeAttribute("data-composer");
    return () => root.removeAttribute("data-composer");
  }, [docked]);

  // At the very end of the page (the footer in view) the docked box steps down out of the way, as a chat app's dock does, so the
  // footer's links are never under glass. Not while the visitor is in it, has words or a file in it, or a message on it: then it stays.
  useEffect(() => {
    const foot = document.querySelector("footer.st-footer");
    if (!foot || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setAtEnd(e.isIntersecting));
    io.observe(foot);
    return () => io.disconnect();
  }, []);

  // The light that follows the pointer: a fine pointer and motion allowed only, one update per frame (two CSS variables).
  useEffect(() => {
    const el = form.current;
    if (!el || typeof window.matchMedia !== "function") return;
    if (!window.matchMedia("(pointer: fine)").matches || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const move = (ev: PointerEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const r = el.getBoundingClientRect();
        el.style.setProperty("--glass-x", `${Math.round(((ev.clientX - r.left) / r.width) * 100)}%`);
        el.style.setProperty("--glass-y", `${Math.round(((ev.clientY - r.top) / r.height) * 100)}%`);
      });
    };
    el.addEventListener("pointermove", move);
    return () => {
      el.removeEventListener("pointermove", move);
      cancelAnimationFrame(frame);
    };
  }, []);

  const grow = () => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 24 * MAX_LINES + 16)}px`;
  };

  const go = async () => {
    if (!ready || busy) return;
    if (picked) {
      // The file waits in this browser for the Studio; the link carries only the words and that one is waiting.
      // The file waits bound to a fresh nonce, which the link carries: the Studio takes it only for this link.
      setBusy(true);
      let nonce: string;
      try {
        nonce = await keepPending(picked.file, picked.kind, indexedDbStore(), { mime: picked.mime });
      } catch {
        setBusy(false);
        setProblem({ kind: "keep" });
        return;
      }
      window.location.assign(attachedHref(words, signedIn, nonce));
      return;
    }
    const href = promptHref(TEXT_TOOL, words, signedIn);
    if (!href) {
      setProblem({ kind: "words" });
      box.current?.focus();
      return;
    }
    window.location.assign(href);
  };

  const choose = (file: File | undefined) => {
    if (!file) return;
    const check = checkAttachment(file);
    if (!check.ok) {
      setProblem({ kind: check.error, max: check.max });
      return;
    }
    setProblem(null);
    setPicked({ file, kind: check.kind, mime: check.mime, url: URL.createObjectURL(file) });
    box.current?.focus();
  };

  const unpick = () => {
    setPicked(null);
    if (picker.current) picker.current.value = "";
    setProblem(null);
    box.current?.focus();
  };

  const problemText = !problem
    ? null
    : problem.kind === "words"
      ? copy.empty
      : problem.kind === "type"
        ? copy.badType
        : problem.kind === "size"
          ? fmt(copy.tooBig, { max: formatMediaBytes(problem.max ?? null) })
          : problem.kind === "empty"
            ? copy.emptyFile
            : copy.keepFailed;
  const note = studioOpen ? (signedIn ? copy.noteIn : copy.noteOut) : signedIn ? copy.noteInClosed : copy.noteOutClosed;

  return (
    <>
      <div ref={slot} className="nx-pbar-slot" style={docked && reserve ? { minHeight: reserve } : undefined}>
        <form
          ref={form}
          className="nx-pbar"
          data-docked={docked ? "true" : "false"}
          data-attached={picked ? picked.kind : undefined}
          data-away={docked && atEnd && !inUse && !picked && !problem && !words.trim() ? "true" : undefined}
          aria-busy={busy || undefined}
          onFocus={() => setInUse(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setInUse(false);
          }}
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          {picked && (
            <div className="nx-pbar-file" role="group" aria-label={fmt(copy.attached, { name: picked.file.name })} data-kind={picked.kind}>
              <span className="nx-pbar-thumb" aria-hidden>
                {picked.kind === "image" ? (
                  // A local object URL of the visitor's own file: never optimised or sent anywhere.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={picked.url} alt="" />
                ) : (
                  <>
                    {/* #t=0.1: iOS Safari shows a video's first frame only when asked for a time. */}
                    <video src={`${picked.url}#t=0.1`} muted playsInline preload="metadata" />
                    <Film className="nx-pbar-thumb-mark" />
                  </>
                )}
              </span>
              <span className="nx-pbar-file-text">
                <span className="nx-pbar-file-name">{picked.file.name}</span>
                <span className="nx-pbar-file-kind">
                  {picked.kind === "image" ? (studioOpen ? copy.picture : copy.pictureClosed) : studioOpen ? copy.video : copy.videoClosed}
                </span>
              </span>
              <button
                type="button"
                className="nx-pbar-unpick"
                aria-label={fmt(copy.remove, { name: picked.file.name })}
                title={fmt(copy.remove, { name: picked.file.name })}
                onClick={unpick}
                disabled={busy}
              >
                <X aria-hidden />
              </button>
            </div>
          )}
          <button
            type="button"
            className="nx-pbar-plus"
            aria-label={copy.attach}
            title={copy.attach}
            onClick={() => picker.current?.click()}
            disabled={!ready || busy}
          >
            <Plus aria-hidden />
          </button>
          {/* The system picker, a picture or a video. No `capture`: nothing asks for the camera or the microphone. */}
          <input
            ref={picker}
            type="file"
            accept={ATTACH_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => choose(e.target.files?.[0])}
          />
          <label htmlFor={`${id}-box`} className="sr-only">
            {copy.label}
          </label>
          <textarea
            ref={box}
            id={`${id}-box`}
            className="nx-pbar-box"
            rows={1}
            maxLength={PROMPT_MAX}
            placeholder={copy.placeholder}
            value={words}
            aria-invalid={problem?.kind === "words" || undefined}
            aria-describedby={`${id}-note${problem ? ` ${id}-err` : ""}`}
            onChange={(e) => {
              setWords(e.target.value);
              if (problem?.kind === "words") setProblem(null);
              grow();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.currentTarget.blur();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void go();
              }
            }}
          />
          <button type="submit" className="nx-pbar-go" aria-label={copy.submit} title={copy.submit} disabled={!ready || busy}>
            <ArrowUp aria-hidden />
          </button>
          {/* Inside the form, so it travels with the box when it docks to the bottom of the window. */}
          {problemText && (
            <p id={`${id}-err`} className="nx-pbar-err" role="alert">
              {problemText}
            </p>
          )}
        </form>
      </div>
      <p id={`${id}-note`} className="nx-pbar-note">
        {picked ? `${note} ${signedIn ? copy.keptIn : copy.keptOut}` : note}
      </p>
      {ideas.length > 0 && (
        <div className="nx-pbar-ideas">
          <span className="nx-pbar-ideas-label">{copy.ideas}</span>
          <ul>
            {ideas.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  className="nx-pbar-idea"
                  onClick={() => {
                    setWords(i.prompt);
                    if (problem?.kind === "words") setProblem(null);
                    box.current?.focus();
                    requestAnimationFrame(grow);
                  }}
                >
                  {i.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
