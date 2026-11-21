"use client";

import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowRight } from "lucide-react";
import { buttonClass } from "@/components/ds/button-class";
import { fmt } from "@/lib/i18n/core";
import { IDEA_HREF, IDEA_MAX, IDEA_NEXT, ideaWords, stashIdea } from "@/lib/site/idea-handoff";
import { TEXT_TOOL, promptHref } from "@/lib/site/prompt-link";

export type IdeaBoxCopy = { label: string; placeholder: string; submit: string; note: string; empty: string; count: string };

/** The counter appears only this close to the limit: a number under every keystroke is noise. */
const COUNT_FROM = IDEA_MAX - 200;

/**
 * The landing's "Write your idea" box: one field and one button, near the top of "/". It is a link and nothing more: the words are
 * kept in this browser (lib/site/idea-handoff.ts) and the visitor goes to sign-up with the Studio as `next` (a signed-in visitor is
 * sent straight on by the middleware). Nothing is priced, started or sent to a model before the person presses send in the Studio.
 *
 * The page stays static: whether the visitor is signed in is not asked here, so the first paint needs no session read. The field's
 * height is fixed by its rows, so the hero's box is the same before and after this hydrates (CLS 0).
 *
 * Without script the form still goes to sign-up with the Studio as `next` (the field has no name: its words never enter the address).
 */
export function IdeaBox({ copy }: { copy: IdeaBoxCopy }) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const length = Array.from(text).length;

  function go(e?: FormEvent) {
    e?.preventDefault();
    if (leaving) return;
    const words = ideaWords(text);
    if (!words) {
      setProblem(true);
      field.current?.focus();
      return;
    }
    setLeaving(true);
    // Kept in this browser: the address carries only `idea=1`. Storage off or full: the words go in the address instead, cut on a
    // word to what still fits through sign-up (the landing prompt bar's way), rather than being lost.
    const href = stashIdea(words) ? IDEA_HREF : (promptHref(TEXT_TOOL, words, false) ?? IDEA_HREF);
    window.location.assign(href);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter is a new line (an idea can have paragraphs); Ctrl or Cmd with Enter sends, as in the Studio's own box.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go();
  }

  return (
    <form className="hm-idea" action="/signup" method="get" onSubmit={go} data-testid="idea-box" noValidate>
      <input type="hidden" name="next" value={IDEA_NEXT} />
      <label htmlFor={`${id}-f`} className="hm-idea-label">
        {copy.label}
      </label>
      <div className="hm-idea-row">
        <textarea
          id={`${id}-f`}
          ref={field}
          className="hm-idea-field"
          rows={2}
          maxLength={IDEA_MAX}
          placeholder={copy.placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (problem) setProblem(false);
          }}
          onKeyDown={onKey}
          aria-invalid={problem || undefined}
          aria-describedby={`${id}-n${problem ? ` ${id}-e` : ""}`}
          enterKeyHint="send"
          autoComplete="off"
          data-testid="idea-field"
        />
        <button type="submit" className={buttonClass({ variant: "primary", size: "lg", className: "hm-idea-go" })} aria-busy={leaving || undefined} data-testid="idea-submit">
          {copy.submit}
          <ArrowRight aria-hidden />
        </button>
      </div>
      {problem ? (
        <p id={`${id}-e`} className="hm-idea-problem" role="alert" data-testid="idea-empty">
          {copy.empty}
        </p>
      ) : null}
      <p id={`${id}-n`} className="hm-idea-note">
        {copy.note}
        {length >= COUNT_FROM ? (
          <span className="hm-idea-count" data-testid="idea-count">
            {" "}
            {fmt(copy.count, { n: length, max: IDEA_MAX })}
          </span>
        ) : null}
      </p>
    </form>
  );
}
