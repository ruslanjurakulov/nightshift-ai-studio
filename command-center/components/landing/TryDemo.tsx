"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, RotateCcw } from "lucide-react";
import { fmt } from "@/lib/i18n/core";
import type { Dictionary } from "@/lib/i18n";
import { buildPlan, cleanTopic, pickStill, TOPIC_MAX } from "@/lib/site/demo-plan";
import { SampleImg } from "@/components/site/samples";
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
 * It opens already filled, with the first sample topic's plan (tagged
 * "Example", with a line saying so), so the section is never a grey placeholder;
 * asking for a topic of your own replays it with your words in. Layout never
 * moves: all five cards are in the document, in a grid whose height does not
 * depend on how many are shown; cards not shown yet are inert and hidden from
 * assistive tech while it plays; one polite status line says what is
 * happening. With reduced motion, or the page's pause switch on, the plan
 * appears at once. On a phone the cards are a sideways snap row, not a column.
 * The thumbnail card shows one of the six example frames, picked by the topic's
 * words (lib/site/demo-plan.ts pickStill), and says it is a stand-in.
 */
export function TryDemo({ copy, note, samplesTag, href = "/signup" }: { copy: Copy; note: string; samplesTag: string; href?: string }) {
  const uid = useId();
  const [value, setValue] = useState("");
  // What the plan was built from; the field can change without the plan changing under it.
  const [topic, setTopic] = useState("");
  const [shown, setShown] = useState(copy.sections.length);
  const [error, setError] = useState(false);
  const paused = useMotionPaused();
  const timer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // On a phone the cards are a sideways scroller, which a keyboard must be able to reach.
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 859px)");
    const sync = () => setScrolls(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const total = copy.sections.length;
  const rootRef = useRef<HTMLDivElement>(null);

  // The sample plan draws itself once, the first time the section scrolls into view: cards that start below the fold
  // are held back (their boxes still take their space, so nothing shifts) and then appear one after another. Skipped
  // when the section is already on screen when the page loads, with reduced motion, or with the pause switch on, and
  // never run again; without script or IntersectionObserver the plan is simply all there.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || paused || typeof window.matchMedia !== "function" || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    setShown(0);
    let n = 0;
    const tick = () => {
      n += 1;
      setShown(n);
      if (n < total) timer.current = window.setTimeout(tick, STEP_MS);
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        timer.current = window.setTimeout(tick, STEP_MS / 2);
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      // Never leave the plan half drawn: a route change or a hot reload shows all of it.
      if (timer.current !== null) window.clearTimeout(timer.current);
      setShown(total);
    };
    // Once, on mount: the pause switch is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Until a topic is asked for, the plan on show is the first sample topic's.
  const shownTopic = topic || copy.topics[0];
  const plan = buildPlan(copy.sections, shownTopic);
  const state: "sample" | "drafting" | "ready" = !topic ? "sample" : shown < total ? "drafting" : "ready";

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

  const status = error ? copy.noTopic : state === "drafting" ? copy.drafting : state === "ready" ? copy.ready : fmt(copy.sampleNote, { topic: shownTopic });

  return (
    <div className="nx-try" ref={rootRef}>
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
            {state === "sample" ? copy.run : copy.again}
            {state === "sample" ? <ArrowRight aria-hidden /> : <RotateCcw aria-hidden />}
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
        <ol className="nx-try-cards" tabIndex={scrolls ? 0 : undefined} aria-label={scrolls ? copy.label : undefined}>
          {copy.sections.map((s, i) => {
            const on = i < shown;
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
                {s.id === "thumb" && (
                  <figure className="nx-try-thumb">
                    <div className="nx-try-thumb-pic">
                      <SampleImg id={pickStill(shownTopic)} className="nx-art" crop="b" />
                      <span className="nx-result-badge">{samplesTag}</span>
                    </div>
                    <figcaption>{copy.thumbNote}</figcaption>
                  </figure>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="nx-try-end" data-on={shown < total ? "false" : "true"} inert={shown < total ? true : undefined}>
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
