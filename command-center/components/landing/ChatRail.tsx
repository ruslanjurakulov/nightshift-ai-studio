"use client";

import { useEffect, useRef, useState } from "react";
import { useMotionPaused } from "@/lib/site/motion";

/**
 * The chat card's rail (Topic, Plan, Approve, Live) that steps once, on its own: Topic, then Plan, then Approve, where it
 * rests. It never reaches Live, because nothing goes live until the person presses the button, which is the product's whole
 * point, and the card's last row says "Waiting for you".
 *
 * `rest` is the index of the step it rests on (the card says which: `copy.current`); the steps after it are shown but never
 * lit. It runs once, the first time the card is on screen after the page has loaded (if the visitor scrolls away before it gets to the resting step it starts again on their return, until it has got there once), and then does not start again. Without
 * script, under reduced motion, while the page's pause switch is pressed and before it is first seen it shows the resting
 * step (the state the rest of the card describes, which the server renders too); pressing the switch part-way jumps to it.
 * The card's `data-step` follows the rail so the status rows can wait for it. Only colours change, never a size, and no text
 * fades: nothing here shifts the page or fails a contrast check.
 */
const STEP_MS = [1100, 1300];

export function ChatRail({ steps, rest }: { steps: { id: string; tab: string }[]; rest: number }) {
  const paused = useMotionPaused();
  const ref = useRef<HTMLOListElement>(null);
  const [step, setStep] = useState(rest);
  const [onScreen, setOnScreen] = useState(false);
  const [ready, setReady] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const go = () => setReady(true);
    if (document.readyState === "complete") go();
    else window.addEventListener("load", go, { once: true });
    const el = ref.current;
    let io: IntersectionObserver | undefined;
    if (el && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), { threshold: 0.2 });
      io.observe(el);
    }
    return () => {
      window.removeEventListener("load", go);
      io?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (paused) {
      setStep(rest);
      done.current = true; // pressed part-way: it does not pick the sequence up again
      return;
    }
    if (!ready || !onScreen || done.current) return;
    const timers: number[] = [];
    let at = 0;
    setStep(0);
    for (let i = 1; i <= rest; i++) {
      at += STEP_MS[Math.min(i - 1, STEP_MS.length - 1)];
      timers.push(
        window.setTimeout(() => {
          setStep(i);
          if (i === rest) done.current = true; // it has run once: it rests here and never starts again
        }, at),
      );
    }
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      setStep(rest);
    };
  }, [ready, onScreen, paused, rest]);

  useEffect(() => {
    ref.current?.closest(".nx-chat")?.setAttribute("data-step", String(step));
  }, [step]);

  return (
    <ol className="nx-chat-rail" ref={ref}>
      {steps.map((s, i) => (
        <li key={s.id} data-done={i < step ? "true" : undefined} aria-current={i === step ? "step" : undefined}>
          {s.tab}
        </li>
      ))}
    </ol>
  );
}
