"use client";

/**
 * Text the server has already checked, revealed on the card instead of appearing all at once (LIVE_CREATION_PLAN §2, §3.5).
 *
 * This is NOT token streaming and must never be fed raw model output: a revealed prompt that the server later refuses or cuts
 * would have shown the person words that were never real. The caller passes a finished, saved string and labels it "Written".
 *
 * - Pace: about 25 ms a character, the whole reveal capped at 600 ms, so a long prompt never keeps a person waiting.
 * - No caret: a blinking caret would say "the machine is typing", which is not what happens.
 * - The full text is in the tree from the first frame, for a screen reader and for the layout: assistive technology reads it
 *   once, never letter by letter, and the card does not grow while it reveals (the hidden copy holds the final height).
 * - A press on the text, or `instant`, shows it all (everything over 200 ms can be skipped). Under reduced motion it fades.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";

export const REVEAL_MS_PER_CHAR = 25;
export const REVEAL_MAX_MS = 600;

/** How long the reveal of `length` characters takes. */
export function revealDuration(length: number): number {
  return Math.min(Math.max(0, length) * REVEAL_MS_PER_CHAR, REVEAL_MAX_MS);
}

/** How many characters are shown `elapsed` ms into the reveal. */
export function revealedCount(length: number, elapsed: number): number {
  const total = revealDuration(length);
  if (total <= 0 || elapsed >= total) return length;
  if (elapsed <= 0) return 0;
  return Math.min(length, Math.floor((elapsed / total) * length));
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function RevealText({
  text,
  reveal,
  instant = false,
  as: Tag = "p",
  className,
  onDone,
}: {
  text: string;
  /**
   * True when this text has just arrived in front of the person. False for text that was already there (a refresh, a card
   * scrolled back into view): it shows at once, because revealing it again would claim it was being written now.
   */
  reveal: boolean;
  /** Skip the reveal (the board's "show everything" or a person's press). */
  instant?: boolean;
  as?: "p" | "span" | "div";
  className?: string;
  onDone?: () => void;
}) {
  const animate = reveal && !instant;
  const [shown, setShown] = useState(() => (animate ? 0 : text.length));
  const [skipped, setSkipped] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (!animate || skipped || prefersReducedMotion()) {
      setShown(text.length);
      if (animate) done.current?.();
      return;
    }
    setShown(0);
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const n = revealedCount(text.length, now - start);
      setShown(n);
      if (n < text.length) frame = requestAnimationFrame(step);
      else done.current?.();
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text, animate, skipped]);

  const complete = shown >= text.length;
  return (
    <Tag
      className={["live-reveal", className].filter(Boolean).join(" ")}
      data-revealing={complete ? undefined : "true"}
      data-reveal={reveal && !instant ? "on" : undefined}
      onClick={complete ? undefined : () => setSkipped(true)}
      style={{ "--live-reveal-ms": `${revealDuration(text.length)}ms` } as CSSProperties}
    >
      {/* The words, whole, for assistive technology and the final height; invisible only while the reveal runs. */}
      <span className="live-reveal-full">{text}</span>
      {complete ? null : (
        <span className="live-reveal-shown" aria-hidden>
          {text.slice(0, shown)}
        </span>
      )}
    </Tag>
  );
}
