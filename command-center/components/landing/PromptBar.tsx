"use client";

import { useId, useRef, useState } from "react";
import { ArrowUp, Clapperboard, Image as ImageIcon } from "lucide-react";
import { PROMPT_TOOLS, PROMPT_MAX, promptHref, type PromptTool } from "@/lib/site/prompt-link";

export type PromptBarCopy = {
  label: string;
  placeholder: string;
  tools: string;
  video: string;
  image: string;
  submit: string;
  empty: string;
  noteIn: string;
  noteOut: string;
  ideas: string;
};

/** A real sample's words the visitor can start from: its format's name (the chip) and the prompt its job was given. */
export type PromptIdea = { id: string; label: string; tool: PromptTool; prompt: string };

/**
 * The landing's prompt bar: type what you want, pick video or image, press Create (or Enter). It goes to the Studio form with the
 * tool and the words (lib/site/prompt-link.ts), through sign-up first when signed out. That is all it does: a link, never a job,
 * a price or a hold (CLAUDE.md #3), and the note under it says so in as many words. The chips under it fill the box with a real
 * sample's prompt (the words that made a clip on this page), never words we wrote to look like one.
 *
 * Shift+Enter is a new line; an empty box says what is missing and keeps the focus there. 16 px text, 44 px controls.
 */
export function PromptBar({ copy, ideas, signedIn = false }: { copy: PromptBarCopy; ideas: PromptIdea[]; signedIn?: boolean }) {
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const [words, setWords] = useState("");
  const [tool, setTool] = useState<PromptTool>("t2v");
  const [missing, setMissing] = useState(false);

  const go = () => {
    const href = promptHref(tool, words, signedIn);
    if (!href) {
      setMissing(true);
      box.current?.focus();
      return;
    }
    window.location.assign(href);
  };

  const label: Record<PromptTool, string> = { t2v: copy.video, t2i: copy.image };
  const Icon = { t2v: Clapperboard, t2i: ImageIcon } as const;

  return (
    <form
      className="nx-pbar"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <label htmlFor={`${id}-box`} className="sr-only">
        {copy.label}
      </label>
      <textarea
        ref={box}
        id={`${id}-box`}
        className="nx-pbar-box"
        rows={2}
        maxLength={PROMPT_MAX}
        placeholder={copy.placeholder}
        value={words}
        aria-invalid={missing || undefined}
        aria-describedby={`${id}-note${missing ? ` ${id}-err` : ""}`}
        onChange={(e) => {
          setWords(e.target.value);
          if (missing) setMissing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            go();
          }
        }}
      />
      <div className="nx-pbar-row">
        <div role="group" aria-label={copy.tools} className="nx-pbar-tools">
          {PROMPT_TOOLS.map((k) => {
            const I = Icon[k];
            return (
              <button key={k} type="button" aria-pressed={tool === k} className="nx-pbar-tool" onClick={() => setTool(k)}>
                <I aria-hidden />
                {label[k]}
              </button>
            );
          })}
        </div>
        <button type="submit" className="nx-pbar-go">
          {copy.submit}
          <ArrowUp aria-hidden />
        </button>
      </div>
      {missing && (
        <p id={`${id}-err`} className="nx-pbar-err" role="alert">
          {copy.empty}
        </p>
      )}
      <p id={`${id}-note`} className="nx-pbar-note">
        {signedIn ? copy.noteIn : copy.noteOut}
      </p>
      {ideas.length > 0 && (
        <div className="nx-pbar-ideas">
          <span className="nx-pbar-ideas-label">{copy.ideas}</span>
          <ul>
            {ideas.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  className="nx-pbar-idea"
                  onClick={() => {
                    setWords(i.prompt);
                    setTool(i.tool);
                    setMissing(false);
                    box.current?.focus();
                  }}
                >
                  {i.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
