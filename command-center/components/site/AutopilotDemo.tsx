"use client";

import "./autopilot-demo.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { fmt } from "@/lib/i18n/core";
import type { SiteAutopilotDictionary } from "@/lib/i18n/site-autopilot/en";
import {
  AUTOPILOT_STAGES,
  CLAIMS,
  CLAIMS_FILE,
  DEMO_SCRIPT,
  SCENES,
  SCENES_DIR,
  SCRIPT_FILE,
  STAGE_EVIDENCE,
  TIMED_WORDS,
  WORDS_FILE,
  type AutopilotStage,
} from "@/lib/site/autopilot-artifacts";

type Copy = SiteAutopilotDictionary["demo"];

/** Where each file stage's artifact comes from, printed under it (a path in the repository, not a link: it is not served). */
const SOURCE: Partial<Record<AutopilotStage, string>> = {
  topic: SCRIPT_FILE,
  research: CLAIMS_FILE,
  script: SCRIPT_FILE,
  voice: `${SCRIPT_FILE} · ${WORDS_FILE}`,
  visuals: SCRIPT_FILE,
  render: `${SCENES_DIR}/*.json`,
};

/**
 * The landing's autopilot walk-through: the stages of one run (main.py's order, topic to publish) as a rail of steps, each with
 * what that stage really produces. Six stages show a file from the repository, copied verbatim (lib/site/autopilot-artifacts.ts,
 * pinned to the files by tests/autopilot-demo.test.tsx); upload and approval have no file to show, so they are drawn as the app's
 * screen and tagged "Mock of the app's screen" on the panel itself; publish states the rules (CLAUDE.md rules 2 and 3,
 * docs/APPROVE_PUBLISH_1B.md). Nothing here pretends to be a live run: no counter, no fake progress, no number that was not in a file.
 *
 * Click-driven only: a stage button, the previous/next keys, the arrow keys on the rail. Nothing advances by itself, so there is
 * nothing to pause (the owner's rule for the public site, 2026-11-13: no visible pause key). Every panel is in the page at once,
 * stacked in one grid cell with only the current one visible, so the section's height is the tallest panel's from the first
 * paint and moving between stages shifts nothing (CLS 0).
 */
export function AutopilotDemo({ copy }: { copy: Copy }) {
  const [at, setAt] = useState(0);
  const rail = useRef<HTMLOListElement>(null);
  const total = AUTOPILOT_STAGES.length;

  const go = useCallback((i: number) => setAt(Math.max(0, Math.min(total - 1, i))), [total]);

  // On a phone the rail scrolls sideways: keep the current stage in its view, without scrolling the page (no scrollIntoView).
  useEffect(() => {
    const ol = rail.current;
    const btn = ol?.querySelectorAll<HTMLElement>(".nx-ap-step")[at];
    if (!ol || !btn || ol.scrollWidth <= ol.clientWidth) return;
    ol.scrollTo({ left: btn.offsetLeft - ol.clientWidth / 2 + btn.clientWidth / 2 });
  }, [at]);

  const onRailKey = (ev: KeyboardEvent<HTMLOListElement>) => {
    const keys: Record<string, number> = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: total - 1 };
    if (!(ev.key in keys)) return;
    ev.preventDefault();
    const next = Math.max(0, Math.min(total - 1, keys[ev.key]));
    go(next);
    rail.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };

  const stages = AUTOPILOT_STAGES.map((id) => ({ id, s: copy.stages.find((x) => x.id === id)! }));

  return (
    <section id="autopilot" aria-labelledby="autopilot-title" className="nx-section nx-ap" data-tone="raised">
      <div className="nx-wrap">
        <p className="nx-label">{copy.label}</p>
        <h2 id="autopilot-title" className="nx-h2">
          {copy.title}
        </h2>
        <p className="nx-sub">{copy.lead}</p>

        <div className="nx-ap-frame">
          <ol ref={rail} className="nx-ap-rail" aria-label={copy.rail} onKeyDown={onRailKey}>
            {stages.map(({ id, s }, i) => (
              <li key={id} className="nx-ap-step" data-state={i < at ? "done" : i === at ? "now" : "next"}>
                <button
                  type="button"
                  className="nx-ap-stepbtn"
                  aria-current={i === at ? "step" : undefined}
                  aria-controls={`nx-ap-panel-${id}`}
                  onClick={() => go(i)}
                >
                  <span className="nx-ap-dot" aria-hidden>
                    {i + 1}
                  </span>
                  <span className="nx-ap-name">{s.name}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="nx-ap-track" aria-hidden>
            <span className="nx-ap-fill" style={{ transform: `scaleX(${(at + 1) / total})` }} />
          </div>

          <div className="nx-ap-keys">
            <button type="button" className="nx-ap-key" onClick={() => go(at - 1)} disabled={at === 0} aria-label={copy.prev}>
              <ChevronLeft aria-hidden />
            </button>
            <button type="button" className="nx-ap-key" onClick={() => go(at + 1)} disabled={at === total - 1} aria-label={copy.next}>
              <ChevronRight aria-hidden />
            </button>
            <p className="nx-ap-count" aria-live="polite">
              {fmt(copy.stepOf, { n: String(at + 1), total: String(total) })}
              <span className="nx-ap-sr">: {stages[at].s.name}</span>
            </p>
          </div>

          <div className="nx-ap-stack">
            {stages.map(({ id, s }, i) => {
              const kind = STAGE_EVIDENCE[id];
              const active = i === at;
              return (
                <article
                  key={id}
                  id={`nx-ap-panel-${id}`}
                  className="nx-ap-panel"
                  data-stage={id}
                  data-evidence={kind}
                  data-active={active ? "true" : "false"}
                  aria-labelledby={`nx-ap-title-${id}`}
                  aria-hidden={active ? undefined : true}
                  inert={!active}
                >
                  <div className="nx-ap-text">
                    <span className="nx-ap-tag" data-kind={kind}>
                      {kind === "file" ? copy.fileTag : kind === "mock" ? copy.mockTag : copy.rulesTag}
                    </span>
                    <h3 id={`nx-ap-title-${id}`} className="nx-h3">
                      {s.title}
                    </h3>
                    <p className="nx-body">{s.body}</p>
                  </div>
                  <div className="nx-ap-art">
                    <Artifact stage={id} copy={copy} />
                    {kind === "file" && (
                      <p className="nx-ap-source">
                        {copy.source} <code>{SOURCE[id]}</code>. {copy.fileNote}
                      </p>
                    )}
                    {kind === "mock" && <p className="nx-ap-source">{copy.mockNote}</p>}
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <div className="nx-ap-cta">
          <h3 className="nx-h3">{copy.cta.title}</h3>
          <p className="nx-body">{copy.cta.body}</p>
          <div className="nx-actions">
            <Link href="/signup" className="nx-btn">
              {copy.cta.primary}
              <ArrowRight aria-hidden />
            </Link>
            <Link href="/studio#publish" className="nx-link">
              {copy.cta.secondary}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/** A label and its value, as the artifacts lay them out. */
function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="nx-ap-row">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The narration with its cues ([PAUSE:1.0], [SFX:…], [MUSIC:…]) set apart, so the reader sees what the narrator stage is told. */
function Narration({ text, cue }: { text: string; cue: string }) {
  const parts = text.split(/(\[[A-Z]+:[^\]]+\])/);
  return (
    <p className="nx-ap-narr" lang="en">
      {parts.map((p, i) =>
        /^\[[A-Z]+:/.test(p) ? (
          <span key={i} className="nx-ap-cue" title={cue}>
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </p>
  );
}

const secs = (n: number) => n.toFixed(1);

function Artifact({ stage, copy }: { stage: AutopilotStage; copy: Copy }) {
  const d = DEMO_SCRIPT;
  switch (stage) {
    case "topic":
      return (
        <dl className="nx-ap-card" lang="en">
          <Row k={copy.topic.topic}>
            <strong className="nx-ap-big">{d.topic}</strong>
          </Row>
          <Row k={copy.topic.hook}>{d.hookSentence}</Row>
        </dl>
      );
    case "research":
      return (
        <ul className="nx-ap-card nx-ap-claims">
          {CLAIMS.map((c) => (
            <li key={c.id} data-status={c.status}>
              <span className="nx-ap-k">{copy.research.claim}</span>
              <span lang="en">{c.text}</span>
              <span className="nx-ap-verdict" data-status={c.status}>
                {copy.research.status}: {copy.research.statuses[c.status]}
                {c.requiresHumanReview && <> · {copy.research.review}</>}
              </span>
            </li>
          ))}
        </ul>
      );
    case "script":
      return (
        <div className="nx-ap-card">
          <dl lang="en">
            <Row k={copy.script.titleA}>{d.title}</Row>
            <Row k={copy.script.titleB}>{d.titleAb}</Row>
          </dl>
          <p className="nx-ap-k">{copy.script.sections}</p>
          <ol className="nx-ap-sections">
            {d.sections.map((s) => (
              <li key={s.name}>
                <code>{s.name}</code>
                <span>{fmt(copy.script.seconds, { n: String(s.durationHint) })}</span>
              </li>
            ))}
          </ol>
        </div>
      );
    case "voice":
      return (
        <div className="nx-ap-card">
          <p className="nx-ap-k">{copy.voice.narration}</p>
          <Narration text={d.hookNarration} cue={copy.voice.cue} />
          <p className="nx-ap-k">{copy.voice.words}</p>
          <ul className="nx-ap-words">
            {TIMED_WORDS.map((w) => (
              <li key={w.text}>
                <span lang="en">{w.text}</span>
                <span>{fmt(copy.voice.span, { from: secs(w.start), to: secs(w.end) })}</span>
              </li>
            ))}
          </ul>
          <p className="nx-ap-note">{copy.voice.noAudio}</p>
        </div>
      );
    case "visuals":
      return (
        <div className="nx-ap-card">
          <p className="nx-ap-k">{copy.visuals.keywords}</p>
          <dl className="nx-ap-kw">
            {d.keywords.map((k) => (
              <Row key={k.section} k={k.section}>
                <ul className="nx-ap-chips" lang="en">
                  {k.words.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Row>
            ))}
          </dl>
          <dl lang="en">
            <Row k={copy.visuals.thumbA}>{d.thumbnailPromptA}</Row>
            <Row k={copy.visuals.thumbB}>{d.thumbnailPromptB}</Row>
            <Row k={copy.visuals.overlay}>
              <span className="nx-ap-overlay">{d.thumbnailOverlayText}</span>
            </Row>
          </dl>
        </div>
      );
    case "render":
      return (
        <ol className="nx-ap-card nx-ap-scenes">
          {SCENES.map((s) => (
            <li key={s.id}>
              <span className="nx-ap-scene-id">
                {copy.render.scene} <code>{s.id}</code>
              </span>
              <span className="nx-ap-scene-how">
                {copy.render.recipe} <code>{s.recipe}</code> · {copy.render.transition} <code>{s.transition}</code>
              </span>
              <span lang="en" className="nx-ap-scene-line">
                {s.narration}
              </span>
            </li>
          ))}
        </ol>
      );
    case "upload":
      return (
        <figure className="nx-ap-card nx-ap-mock" aria-label={`${copy.mockTag}: ${copy.upload.screen}`}>
          <p className="nx-ap-mock-bar">{copy.upload.screen}</p>
          <dl>
            <Row k={copy.upload.title}>
              <span lang="en">{d.title}</span>
            </Row>
            <Row k={copy.upload.privacy}>
              <span className="nx-ap-private">
                <Lock aria-hidden />
                {copy.upload.private}
              </span>
            </Row>
            <Row k={copy.upload.tags}>
              <ul className="nx-ap-chips" lang="en">
                {d.tags.map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
              </ul>
            </Row>
            <Row k={copy.upload.check}>{copy.upload.checkNote}</Row>
          </dl>
        </figure>
      );
    case "approve":
      return (
        <figure className="nx-ap-card nx-ap-mock" aria-label={`${copy.mockTag}: ${copy.approve.screen}`}>
          <p className="nx-ap-mock-bar">{copy.approve.screen}</p>
          <p className="nx-ap-mock-title" lang="en">
            {d.title}
          </p>
          <span className="nx-ap-private">
            <Lock aria-hidden />
            {copy.approve.privacy}
          </span>
          {/* A drawing of the key, not a key: nothing on the public site approves anything. */}
          <span className="nx-ap-fakebtn">
            {copy.approve.button}
          </span>
          <p className="nx-ap-note">{copy.approve.records}</p>
          <p className="nx-ap-note">
            <strong>{copy.approve.unchanged}</strong>
          </p>
        </figure>
      );
    case "publish":
      return (
        <div className="nx-ap-card nx-ap-rules">
          <div>
            <p className="nx-ap-k">{copy.publish.defaultTitle}</p>
            <p>{copy.publish.defaultBody}</p>
          </div>
          <div>
            <p className="nx-ap-k">{copy.publish.autoTitle}</p>
            <p>{copy.publish.autoBody}</p>
          </div>
          <div>
            <p className="nx-ap-k">{copy.publish.approvedTitle}</p>
            <ol className="nx-ap-ruleslist">
              {copy.publish.approvedSteps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        </div>
      );
  }
}
