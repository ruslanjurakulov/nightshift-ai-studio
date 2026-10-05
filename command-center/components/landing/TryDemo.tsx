"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, RotateCcw } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { buildPlan, cleanTopic, TOPIC_MAX } from "@/lib/site/demo-plan";
import { useMotionPaused } from "@/lib/site/motion";

type Copy = Dictionary["site"]["try"];

/** One section appears every STEP_MS while the example is "drafting". */
const STEP_MS = 520;

/**
 * "Type a topic, see the shape of a plan": the landing page's reason to stay
 * and play. It needs no server and no paid call, and it never pretends to be
 * the product: the card says Example, the lead says nothing is generated or
 * sent, and the finished plan ends with what the real run adds (research and
 * checking, the price on the button, your approval) next to "Make this for
 * real".
 *
 * Layout never moves: all five section cards are in the document from the
 * start (skeletons first, then filled), in a grid whose height does not depend
 * on how many are shown. Cards that are not shown yet are inert and hidden from
 * assistive tech; one polite status line says what is happening. With reduced
 * motion, or the page's pause switch on, the whole plan appears at once.
 */
export function TryDemo({ copy, note, href = "/signup" }: { copy: Copy; note: string; href?: string }) {
  const uid = useId();
  const [value, setValue] = useState("");
  // What the plan was built from; the field can change without the plan changing under it.
  const [topic, setTopic] = useState("");
  const [shown, setShown] = useState(0);
  const [error, setError] = useState(false);
  const paused = useMotionPaused();
  const timer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const total = copy.sections.length;
  // Before anything is asked for, the hidden cards hold the first sample topic's plan: real words (never a
  // literal "{topic}") at a realistic height, so the grid is already the size it will be.
  const plan = buildPlan(copy.sections, topic || copy.topics[0]);
  const state: "idle" | "drafting" | "ready" = !topic ? "idle" : shown < total ? "drafting" : "ready";

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  function run(raw: string) {
    const clean = cleanTopic(raw);
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (!clean) {
      setError(true);
      inputRef.current?.focus();
      return;
    }
    setError(false);
    setValue(clean);
    setTopic(clean);
    const instant = paused || (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (instant) {
      setShown(total);
      return;
    }
    setShown(0);
    let n = 0;
    const tick = () => {
      n += 1;
      setShown(n);
      if (n < total) timer.current = window.setTimeout(tick, STEP_MS);
    };
    timer.current = window.setTimeout(tick, STEP_MS / 2);
  }

  const status = error ? copy.noTopic : state === "drafting" ? copy.drafting : state === "ready" ? copy.ready : "";

  return (
    <div className="nx-try">
      <form
        className="nx-try-form"
        onSubmit={(e) => {
          e.preventDefault();
          run(value);
        }}
        noValidate
      >
        <div className="nx-try-bar">
          <label htmlFor={`${uid}-topic`} className="nx-try-label">
            {copy.fieldLabel}
          </label>
          <input
            ref={inputRef}
            id={`${uid}-topic`}
            className="nx-try-input"
            type="text"
            value={value}
            maxLength={TOPIC_MAX}
            placeholder={copy.placeholder}
            autoComplete="off"
            enterKeyHint="go"
            aria-invalid={error || undefined}
            aria-describedby={`${uid}-status`}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(false);
            }}
          />
          <button type="submit" className="nx-btn nx-try-run">
            {state === "idle" ? copy.run : copy.again}
            {state === "idle" ? <ArrowRight aria-hidden /> : <RotateCcw aria-hidden />}
          </button>
        </div>
        <div className="nx-try-picks" role="group" aria-label={copy.pickLabel}>
          <span className="nx-try-picks-label" aria-hidden>
            {copy.pickLabel}
          </span>
          {copy.topics.map((t) => (
            <button key={t} type="button" className="nx-try-pick" onClick={() => run(t)}>
              {t}
            </button>
          ))}
        </div>
        <p id={`${uid}-status`} className="nx-try-status" role="status" data-error={error ? "true" : undefined}>
          {status}
        </p>
      </form>

      <div className="nx-try-plan" data-state={state}>
        <span className="nx-try-tag">{copy.tag}</span>
        <ol className="nx-try-cards">
          {copy.sections.map((s, i) => {
            const on = state !== "idle" && i < shown;
            const filled = plan[i] ?? s;
            return (
              <li key={s.id} className="nx-try-card" data-id={s.id} data-on={on ? "true" : "false"} inert={on ? undefined : true} aria-hidden={on ? undefined : true}>
                <h3 className="nx-try-card-h">
                  <span className="nx-try-check" aria-hidden>
                    <Check />
                  </span>
                  {s.name}
                </h3>
                <ul className="nx-try-items">
                  {filled.items.map((it, k) => (
                    <li key={k}>
                      {it.k && <b>{it.k}</b>}
                      <span>{it.v}</span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
        {/* What is there before anything is asked for: ghosts of the same cards, in the same grid, under one line of words. */}
        <div className="nx-try-idle" data-on={state === "idle" ? "true" : "false"} aria-hidden="true">
          {copy.sections.map((s) => (
            <div key={s.id} className="nx-try-ghost" data-id={s.id}>
              <span className="nx-sk" data-w="40" />
              <span className="nx-sk" />
              <span className="nx-sk" data-w="85" />
              <span className="nx-sk" data-w="70" />
              <span className="nx-sk" data-w="85" />
              <span className="nx-sk" />
              <span className="nx-sk" data-w="70" />
            </div>
          ))}
          <p className="nx-try-idle-cap">{copy.idle}</p>
        </div>
      </div>

      <div className="nx-try-end" data-on={state === "ready" ? "true" : "false"} inert={state === "ready" ? undefined : true}>
        <p className="nx-body">{copy.real}</p>
        <div className="nx-try-cta">
          <Link href={href} className="nx-btn">
            {copy.cta}
            <ArrowRight aria-hidden />
          </Link>
          <span className="nx-note">{note}</span>
        </div>
      </div>
    </div>
  );
}
