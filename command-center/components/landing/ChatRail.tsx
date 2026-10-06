"use client";

import { useEffect, useRef, useState } from "react";
import { useMotionPaused } from "@/lib/site/motion";

/**
 * The chat card's rail (Topic, Plan, Approve, Live) that steps on its own: Topic, then Plan, then Approve, where it
 * rests for a few seconds, then again. It never reaches Live, because nothing goes live until the person presses the
 * button, which is the product's whole point, and the card's last row says "Waiting for you".
 *
 * Without script, under reduced motion, while the page's pause switch is pressed and while the card is off screen it
 * shows Approve (the state the rest of the card describes). The server renders that same state, so nothing moves
 * until the page has loaded. The card's `data-step` follows the rail so the status rows can dim until Approve.
 * Only colours change, never a size, and no text fades: nothing here shifts the page or fails a contrast check.
 */
const FINAL = 2;
const CYCLE = [1100, 1300, 5200];

export function ChatRail({ steps }: { steps: { id: string; tab: string }[] }) {
  const paused = useMotionPaused();
  const ref = useRef<HTMLOListElement>(null);
  const [step, setStep] = useState(FINAL);
  const [onScreen, setOnScreen] = useState(false);
  const [ready, setReady] = useState(false);

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
    if (!ready || !onScreen || paused) {
      setStep(FINAL);
      return;
    }
    let i = 0;
    let timer = 0;
    const tick = () => {
      setStep(i);
      timer = window.setTimeout(() => {
        i = (i + 1) % CYCLE.length;
        tick();
      }, CYCLE[i]);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [ready, onScreen, paused]);

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
