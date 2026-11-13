"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, Clapperboard, Image as ImageIcon, Plus } from "lucide-react";
import { PROMPT_MAX, attachHref, promptHref, type PromptTool } from "@/lib/site/prompt-link";

export type PromptBarCopy = {
  label: string;
  placeholder: string;
  video: string;
  image: string;
  mode: string;
  attachOut: string;
  attachIn: string;
  attachOutClosed: string;
  attachInClosed: string;
  submit: string;
  empty: string;
  noteIn: string;
  noteOut: string;
  noteInClosed: string;
  noteOutClosed: string;
  ideas: string;
};

/** A real sample's words the visitor can start from: its format's name (the chip) and the prompt its job was given. */
export type PromptIdea = { id: string; label: string; tool: PromptTool; prompt: string };

/** At most this many lines before the box scrolls (its line height is 24 px). */
const MAX_LINES = 6;

/**
 * The landing's composer, as a chat app's is: one line that grows to six, "+" on the left, the send key on the right, inside one
 * glass box. It starts in the first screen and, once the visitor scrolls past it, docks to the bottom centre of the window and
 * stays there; its place in the first screen keeps its height (nothing under it moves), and the page's sticky start bar steps
 * aside while it is docked (html[data-composer="docked"], site-next.css). The note and the real prompts to start from stay in the
 * first screen.
 *
 * What it does is a link and nothing more (lib/site/prompt-link.ts): the Studio form with the words and the tool, through
 * sign-up when signed out. Never a job, a price or a hold (CLAUDE.md #3). "+" opens the Studio's picture-to-video form, which asks
 * for the person's own picture; it needs an account, so signed out it goes to sign-up first with the words kept, and nothing is read
 * or stored from the visitor's device here.
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
  const [words, setWords] = useState("");
  const [tool, setTool] = useState<PromptTool>("t2v");
  const [missing, setMissing] = useState(false);
  const [ready, setReady] = useState(false);
  const [docked, setDocked] = useState(false);
  const [reserve, setReserve] = useState<number | null>(null);

  useEffect(() => setReady(true), []);

  // Dock once the composer's place in the first screen has scrolled above the window; undock when it comes back.
  useEffect(() => {
    const el = slot.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => {
      const above = !e.isIntersecting && e.boundingClientRect.bottom < 0;
      if (above && form.current) setReserve(form.current.offsetHeight);
      setDocked(above);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // While docked the box can still grow (more lines, the empty-box message): its place in the first screen follows its height, so
  // undocking puts it back into a place of its own size and nothing under it jumps. Off again on undock, where the place sizes itself.
  useEffect(() => {
    const el = form.current;
    if (!docked || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setReserve(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [docked]);

  useEffect(() => {
    const root = document.documentElement;
    if (docked) root.setAttribute("data-composer", "docked");
    else root.removeAttribute("data-composer");
    return () => root.removeAttribute("data-composer");
  }, [docked]);

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

  const go = () => {
    if (!ready) return;
    const href = promptHref(tool, words, signedIn);
    if (!href) {
      setMissing(true);
      box.current?.focus();
      return;
    }
    window.location.assign(href);
  };

  // "+" is the Studio's picture-to-video form, whose first field is the person's own picture (the Studio asks for it; this page
  // reads nothing from the device). It needs an account to keep a file: signed out it is sign-up first, the words kept.
  const attach = () => {
    if (!ready) return;
    window.location.assign(attachHref(words, signedIn));
  };
  // While no Studio model is on sale it promises no video: it says what the form is and that it is not on sale yet.
  const attachLabel = studioOpen ? (signedIn ? copy.attachIn : copy.attachOut) : signedIn ? copy.attachInClosed : copy.attachOutClosed;

  const ModeIcon = tool === "t2v" ? Clapperboard : ImageIcon;

  return (
    <>
      <div ref={slot} className="nx-pbar-slot" style={docked && reserve ? { minHeight: reserve } : undefined}>
        <form
          ref={form}
          className="nx-pbar"
          data-docked={docked ? "true" : "false"}
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <button type="button" className="nx-pbar-plus" aria-label={attachLabel} title={attachLabel} onClick={attach} disabled={!ready}>
            <Plus aria-hidden />
          </button>
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
            aria-invalid={missing || undefined}
            aria-describedby={`${id}-note${missing ? ` ${id}-err` : ""}`}
            onChange={(e) => {
              setWords(e.target.value);
              if (missing) setMissing(false);
              grow();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.currentTarget.blur();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                go();
              }
            }}
          />
          {/* What to make: a video by default, a picture on a press. One small key, not two big chips. */}
          <button
            type="button"
            className="nx-pbar-mode"
            aria-label={`${copy.mode}: ${tool === "t2v" ? copy.video : copy.image}`}
            onClick={() => setTool(tool === "t2v" ? "t2i" : "t2v")}
          >
            <ModeIcon aria-hidden />
            <span>{tool === "t2v" ? copy.video : copy.image}</span>
          </button>
          <button type="submit" className="nx-pbar-go" aria-label={copy.submit} title={copy.submit} disabled={!ready}>
            <ArrowUp aria-hidden />
          </button>
          {/* Inside the form, so it travels with the box when it docks to the bottom of the window. */}
          {missing && (
            <p id={`${id}-err`} className="nx-pbar-err" role="alert">
              {copy.empty}
            </p>
          )}
        </form>
      </div>
      <p id={`${id}-note`} className="nx-pbar-note">
        {studioOpen ? (signedIn ? copy.noteIn : copy.noteOut) : signedIn ? copy.noteInClosed : copy.noteOutClosed}
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
                    setTool(i.tool);
                    setMissing(false);
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
