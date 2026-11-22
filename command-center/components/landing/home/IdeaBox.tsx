"use client";

import { useState } from "react";
import { PromptBox, type PromptBoxCopy } from "@/components/prompt/PromptBox";
import { IDEA_HREF, IDEA_MAX, IDEA_NEXT, ideaWords, stashIdea } from "@/lib/site/idea-handoff";
import { TEXT_TOOL, promptHref } from "@/lib/site/prompt-link";

export type IdeaBoxCopy = PromptBoxCopy;

/**
 * The landing's "Write your idea" box: one field and one button, near the top of "/". It is a link and nothing more: the words are
 * kept in this browser (lib/site/idea-handoff.ts) and the visitor goes to sign-up with the Studio as `next` (a signed-in visitor is
 * sent straight on by the middleware). Nothing is priced, started or sent to a model before the person presses send in the Studio.
 *
 * The field, the key, the empty-field line, the counter and the Back reset are the shared PromptBox (components/prompt/PromptBox.tsx);
 * this file is only where the words go. The page stays static: whether the visitor is signed in is not asked here, so the first
 * paint needs no session read.
 *
 * Drawn as one glass bar on the first screen (the owner's "in this style", after kling.ai's hero, 2026-11-22): the hero's own still as
 * a small thumbnail, one line to type in, the key on the right. The bar's height is set by home.css, not by its content, so the
 * hero's box is the same before and after this hydrates (CLS 0). The label stays the field's accessible name, visually hidden.
 *
 * Without script the form still goes to sign-up with the Studio as `next` (the field has no name: its words never enter the address).
 */
export function IdeaBox({ copy, thumb }: { copy: IdeaBoxCopy; thumb?: string }) {
  const [text, setText] = useState("");
  const [leaving, setLeaving] = useState(false);

  function go() {
    if (leaving) return;
    const words = ideaWords(text);
    setLeaving(true);
    // Kept in this browser: the address carries only `idea=1`. Storage off or full: the words go in the address instead, cut on a
    // word to what still fits through sign-up (the landing prompt bar's way), rather than being lost.
    const href = stashIdea(words) ? IDEA_HREF : (promptHref(TEXT_TOOL, words, false) ?? IDEA_HREF);
    window.location.assign(href);
  }

  return (
    <PromptBox
      value={text}
      onChange={setText}
      onSubmit={go}
      copy={copy}
      max={IDEA_MAX}
      busy={leaving}
      onBack={() => setLeaving(false)}
      cls="hm-idea"
      testId="idea"
      single
      lead={
        thumb ? (
          // The hero's own still (its small rendition, the one a phone's first screen already loads), as a background: an echo of
          // the picture behind the bar, not a sample in its own box, so it is not one of the page's labelled image elements.
          <span className="hm-idea-thumb" aria-hidden="true" style={{ backgroundImage: `url("${thumb}")` }} />
        ) : null
      }
      action="/signup"
      method="get"
      hidden={<input type="hidden" name="next" value={IDEA_NEXT} />}
    />
  );
}
