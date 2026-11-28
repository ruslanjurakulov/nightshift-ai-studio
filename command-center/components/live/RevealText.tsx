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
 *   once, never letter by letter, and the box does not grow while it reveals (the transparent full copy holds its height).
 * - A text is revealed at most once. One that was already shown (a refresh, `reveal` false, the board's "show all", a press
 *   that skipped it) never types itself again, whatever the props do next: re-typing it would claim it was being written now.
 * - A press on the text, or `instant`, finishes it. The press is a convenience for a pointer; the board's "show all" is the
 *   keyboard path, so the text is not made a control of its own. Under reduced motion it fades instead.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { revealDuration, revealedCount } from "./model";
import "./live.css";

export { revealDuration, revealedCount, REVEAL_MS_PER_CHAR, REVEAL_MAX_MS } from "./model";

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
   * scrolled back into view): it shows at once.
   */
  reveal: boolean;
  /** Finish the reveal now (the board's "show all"). */
  instant?: boolean;
  as?: "p" | "span" | "div";
  className?: string;
  /** Called once per text whose reveal started, when it ends: completed, pressed or cut short by `instant`. */
  onDone?: () => void;
}) {
  // The text that has been shown in full: it is never revealed again.
  const [played, setPlayed] = useState<string | null>(() => (reveal && !instant ? null : text));
  // Progress belongs to one text: a new text starts from 0 on its first frame, never from the old one's count.
  const [progress, setProgress] = useState<{ text: string; n: number }>({ text, n: 0 });
  const animate = reveal && !instant && played !== text;

  const onDoneRef = useRef(onDone);
  useLayoutEffect(() => {
    onDoneRef.current = onDone;
  });
  const started = useRef<string | null>(null);
  const finished = useRef<string | null>(null);
  const finish = useCallback((t: string) => {
    setPlayed(t);
    if (started.current === t && finished.current !== t) {
      finished.current = t;
      onDoneRef.current?.();
    }
  }, []);

  useEffect(() => {
    if (!animate) {
      // Shown at once (reveal false, or cut short): it now counts as shown.
      if (played !== text) finish(text);
      return;
    }
    started.current = text;
    if (prefersReducedMotion()) {
      finish(text);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const n = revealedCount(text.length, now - start);
      setProgress({ text, n });
      if (n < text.length) frame = requestAnimationFrame(step);
      else finish(text);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text, animate, played, finish]);

  const shown = animate ? (progress.text === text ? progress.n : 0) : text.length;
  const revealing = shown < text.length;
  return (
    <Tag
      className={["live-reveal", className].filter(Boolean).join(" ")}
      data-revealing={revealing ? "true" : undefined}
      data-reveal={reveal && !instant ? "on" : undefined}
      onClick={revealing ? () => finish(text) : undefined}
      style={{ "--live-reveal-ms": `${revealDuration(text.length)}ms` } as CSSProperties}
    >
      {/* The words, whole, for assistive technology and the final height; transparent only while the reveal runs. */}
      <span className="live-reveal-full">{text}</span>
      {revealing ? (
        <span className="live-reveal-shown" aria-hidden>
          {text.slice(0, shown)}
        </span>
      ) : null}
    </Tag>
  );
}
