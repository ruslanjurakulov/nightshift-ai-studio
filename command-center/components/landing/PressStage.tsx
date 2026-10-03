"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Play } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { Art } from "@/components/landing/Art";

type Stage = Dictionary["site"]["stage"];

/** How long one state rests before the next one shows, when nobody is steering. */
const REST_MS = 4600;

/**
 * The hero's picture: one video's whole life, drawn with the app's own parts
 * in four states — a topic, the plan, the approval, and live on YouTube. It is
 * the page's one idea (the person always presses publish), shown instead of
 * described.
 *
 * Calm on purpose. It starts at the topic and moves on by itself every few
 * seconds, only while it is on screen and untouched; hover, focus or a tap
 * stops it, and so does reduced motion (all four states stay reachable as
 * tabs). Nothing in it is a control except the tabs: the drawn keys are
 * labelled examples, never pressable, and no figure in it is a number the
 * product measured.
 *
 * All four panels are in the page's HTML and share one grid cell, so the
 * stage never changes height when the state does (no layout shift) and every
 * state's words are there for search engines and screen readers.
 */
export function PressStage({ stage }: { stage: Stage }) {
  const uid = useId();
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const picked = useRef(false);
  const held = useRef(false);

  // Autoplay needs three things at once: motion is allowed, the stage is on
  // screen, and nobody has taken over. Any of them failing leaves it still.
  useEffect(() => {
    // No way to tell, no autoplay: the tabs still work.
    if (typeof window.matchMedia !== "function" || typeof IntersectionObserver === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    const sync = () => setAuto(!mq.matches && visible && !picked.current && !held.current);
    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        sync();
      },
      { threshold: 0.4 },
    );
    if (rootRef.current) io.observe(rootRef.current);
    mq.addEventListener("change", sync);
    const root = rootRef.current;
    const hold = () => {
      held.current = true;
      sync();
    };
    const release = () => {
      held.current = false;
      sync();
    };
    root?.addEventListener("pointerenter", hold);
    root?.addEventListener("pointerleave", release);
    root?.addEventListener("focusin", hold);
    root?.addEventListener("focusout", release);
    return () => {
      io.disconnect();
      mq.removeEventListener("change", sync);
      root?.removeEventListener("pointerenter", hold);
      root?.removeEventListener("pointerleave", release);
      root?.removeEventListener("focusin", hold);
      root?.removeEventListener("focusout", release);
    };
  }, []);

  useEffect(() => {
    if (!auto) return;
    const id = window.setTimeout(() => setActive((i) => (i + 1) % stage.steps.length), REST_MS);
    return () => window.clearTimeout(id);
  }, [auto, active, stage.steps.length]);

  const pick = useCallback((i: number) => {
    picked.current = true;
    setAuto(false);
    setActive(i);
  }, []);

  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = stage.steps.length - 1;
    const to = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (to < 0) return;
    e.preventDefault();
    pick(to);
    document.getElementById(`${uid}-tab-${to}`)?.focus();
  };

  return (
    <section ref={rootRef} className="nx-stage" aria-label={stage.label} data-auto={auto ? "true" : "false"}>
      <p className="sr-only">{stage.figure}</p>
      <div className="nx-stage-top">
        <div role="tablist" aria-label={stage.label} className="nx-tabs">
          {stage.steps.map((s, i) => (
            <button
              key={s.id}
              id={`${uid}-tab-${i}`}
              type="button"
              role="tab"
              aria-selected={i === active}
              aria-controls={`${uid}-panel-${i}`}
              tabIndex={i === active ? 0 : -1}
              className="nx-tab"
              onClick={() => pick(i)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <span className="nx-tab-no" aria-hidden>
                {i + 1}
              </span>
              {s.tab}
              {i === active && auto && <span aria-hidden className="nx-tab-bar" style={{ animationDuration: `${REST_MS}ms` }} />}
            </button>
          ))}
        </div>
      </div>

      <div className="nx-panels">
        {stage.steps.map((s, i) => (
          <div
            key={s.id}
            id={`${uid}-panel-${i}`}
            role="tabpanel"
            aria-labelledby={`${uid}-tab-${i}`}
            className="nx-panel"
            data-on={i === active ? "true" : "false"}
            // An inactive state stays in the document for search, but out of
            // the way of tab order and assistive tech.
            inert={i === active ? undefined : true}
            aria-hidden={i === active ? undefined : true}
          >
            <div className="nx-panel-words">
              <p className="nx-panel-title">{s.title}</p>
              <p className="nx-panel-body">{s.body}</p>
            </div>
            <div className="nx-ui" aria-hidden>
              <span className="nx-ui-tag">{stage.tag}</span>
              {s.id === "brief" && <BriefUi s={s as BriefStep} />}
              {s.id === "plan" && <PlanUi s={s as PlanStep} />}
              {s.id === "approve" && <ApproveUi s={s as ApproveStep} tag={stage.tag} />}
              {s.id === "live" && <LiveUi s={s as LiveStep} />}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

type AnyStep = Stage["steps"][number];
type BriefStep = Extract<AnyStep, { field: string }>;
type PlanStep = Extract<AnyStep, { items: unknown }>;
type ApproveStep = Extract<AnyStep, { check: string }>;
type LiveStep = Extract<AnyStep, { sub: string }>;

function BriefUi({ s }: { s: BriefStep }) {
  return (
    <div className="nx-ui-card">
      <div className="nx-field">
        <span>{s.field}</span>
        <i className="nx-caret" />
      </div>
      <div className="nx-chips">
        {s.chips.map((c) => (
          <span key={c} className="nx-chip">
            {c}
          </span>
        ))}
      </div>
      <div className="nx-ui-foot">
        <span className="nx-ui-key">{s.key}</span>
      </div>
    </div>
  );
}

function PlanUi({ s }: { s: PlanStep }) {
  return (
    <div className="nx-ui-card">
      <ul className="nx-ui-list">
        {s.items.map((it) => (
          <li key={it.name}>
            <Check aria-hidden />
            <b>{it.name}</b>
            <span>{it.detail}</span>
          </li>
        ))}
      </ul>
      <div className="nx-ui-foot">
        <span className="nx-ui-note">{s.priceNote}</span>
        <span className="nx-ui-key">{s.key}</span>
      </div>
    </div>
  );
}

function Frame({ live = false }: { live?: boolean }) {
  return (
    <div className="nx-frame" data-live={live ? "true" : "false"}>
      <Art kind="moon" />
      <span className="nx-frame-play">
        <Play aria-hidden />
      </span>
    </div>
  );
}

function ApproveUi({ s, tag }: { s: ApproveStep; tag: string }) {
  return (
    <div className="nx-ui-card">
      <Frame />
      <ul className="nx-ui-status">
        <li>
          <span className="nx-dot" data-tone="ok" />
          {s.lamp}
        </li>
        <li>
          <span className="nx-dot" data-tone="ok" />
          {s.check}
        </li>
        <li data-lit="true">
          <span className="nx-dot" data-tone="run" />
          {s.waiting}
        </li>
      </ul>
      <div className="nx-ui-foot">
        {/* The drawn key is a picture; saying so next to it keeps anyone from reaching for it. */}
        <span className="nx-ui-note">{tag}</span>
        <span className="nx-ui-key" data-lit="true">
          {s.key}
        </span>
      </div>
    </div>
  );
}

function LiveUi({ s }: { s: LiveStep }) {
  return (
    <div className="nx-ui-card">
      <Frame live />
      <ul className="nx-ui-status">
        <li>
          <span className="nx-dot" data-tone="go" />
          {s.lamp}
        </li>
        <li>
          <span className="nx-dot" data-tone="ok" />
          {s.sub}
        </li>
      </ul>
    </div>
  );
}
