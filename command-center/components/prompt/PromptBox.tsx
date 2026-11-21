"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowRight } from "lucide-react";
import { buttonClass } from "@/components/ds/button-class";
import { fmt } from "@/lib/i18n/core";
import { ideaWords } from "@/lib/site/idea-handoff";

export type PromptBoxCopy = { label: string; placeholder: string; submit: string; note: string; empty: string; count: string };

/**
 * One prompt box, shared by the landing's "Write your idea" (components/landing/home/IdeaBox.tsx) and the app's start box
 * (components/prompt/StartBox.tsx), so the two cannot drift apart in how they refuse an empty idea, count near the limit or send
 * with Ctrl/Cmd+Enter.
 *
 * Presentational: the words, where they go and what "busy" means belong to the caller. The only state kept here is the empty-field
 * problem, because it is cleared by the very keystroke that fixes it.
 *
 * The landing's markup is a contract (its testids, a field with no `name` so a no-script submit never puts the words in an address,
 * the form's action/method): with no `header`, `chips` or `after` the output is exactly the markup IdeaBox drew before this file
 * existed, pinned by tests/prompt-box.test.tsx. Kept free of the Studio's modules for the landing's first paint.
 */
export function PromptBox({
  value,
  onChange,
  onSubmit,
  copy,
  max,
  countFrom = max - 200,
  busy = false,
  onBack,
  allowEmpty = false,
  rows = 2,
  cls,
  testId,
  action,
  method,
  hidden,
  header,
  chips,
  after,
  fieldRef,
  fieldProps,
  rowProps,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Called with a non-empty idea (or any text when `allowEmpty`); the caller decides where it goes. */
  onSubmit: () => void;
  copy: PromptBoxCopy;
  max: number;
  /** The counter appears only this close to the limit: a number under every keystroke is noise. */
  countFrom?: number;
  busy?: boolean;
  /** The page came back from the back/forward cache (Back from where the box sent it): the caller clears its "busy", or the key
   *  would ignore every press after. */
  onBack?: () => void;
  /** The submit needs no words (the start box's "connect a channel" key). */
  allowEmpty?: boolean;
  rows?: number;
  /** The class prefix: `${cls}`, `${cls}-label`, `${cls}-row`, `${cls}-field`, `${cls}-go`, `${cls}-problem`, `${cls}-note`, `${cls}-count`. */
  cls: string;
  /** The testid prefix: `${testId}-box`, `-field`, `-submit`, `-empty`, `-count`. */
  testId: string;
  /** A no-script form target (the landing's /signup). */
  action?: string;
  method?: "get";
  /** Hidden fields a no-script submit carries (never the words). */
  hidden?: ReactNode;
  /** Above the label (the start box's tabs). */
  header?: ReactNode;
  /** Beside the submit key, inside the box (the start box's chips). */
  chips?: ReactNode;
  /** Under the note (the start box's extra lines). */
  after?: ReactNode;
  fieldRef?: RefObject<HTMLTextAreaElement | null>;
  /** ARIA the caller owns on the field (a tab panel's labelledby). */
  fieldProps?: { "aria-labelledby"?: string; id?: string };
  /** The row as the start box's tab panel: a tablist needs a real panel to control, and the row is what each tab changes. */
  rowProps?: { id: string; role: "tabpanel"; "aria-labelledby": string };
}) {
  const id = useId();
  const own = useRef<HTMLTextAreaElement>(null);
  const field = fieldRef ?? own;
  const [problem, setProblem] = useState(false);
  const length = Array.from(value).length;
  const fieldId = fieldProps?.id ?? `${id}-f`;
  const back = useRef(onBack);
  back.current = onBack;

  // Back out of the back/forward cache keeps React's state as it was when the page left: "busy" would stay on for good.
  useEffect(() => {
    const show = (e: PageTransitionEvent) => {
      if (e.persisted) back.current?.();
    };
    window.addEventListener("pageshow", show);
    return () => window.removeEventListener("pageshow", show);
  }, []);

  function go(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    if (!allowEmpty && !ideaWords(value)) {
      setProblem(true);
      field.current?.focus();
      return;
    }
    onSubmit();
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter is a new line (an idea can have paragraphs); Ctrl or Cmd with Enter sends, as in the Studio's own box.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go();
  }

  const submit = (
    <button type="submit" className={buttonClass({ variant: "primary", size: "lg", className: `${cls}-go` })} aria-busy={busy || undefined} data-testid={`${testId}-submit`}>
      {copy.submit}
      <ArrowRight aria-hidden />
    </button>
  );

  return (
    <form className={cls} action={action} method={method} onSubmit={go} data-testid={`${testId}-box`} noValidate>
      {hidden}
      {header}
      <label htmlFor={fieldId} className={`${cls}-label`}>
        {copy.label}
      </label>
      <div className={`${cls}-row`} {...rowProps}>
        <textarea
          id={fieldId}
          ref={field}
          className={`${cls}-field`}
          rows={rows}
          maxLength={max}
          placeholder={copy.placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            if (problem) setProblem(false);
          }}
          onKeyDown={onKey}
          aria-invalid={problem || undefined}
          aria-describedby={`${id}-n${problem ? ` ${id}-e` : ""}`}
          aria-labelledby={fieldProps?.["aria-labelledby"]}
          enterKeyHint="send"
          autoComplete="off"
          data-testid={`${testId}-field`}
        />
        {chips ? (
          <div className={`${cls}-foot`}>
            {chips}
            {submit}
          </div>
        ) : (
          submit
        )}
      </div>
      {problem ? (
        <p id={`${id}-e`} className={`${cls}-problem`} role="alert" data-testid={`${testId}-empty`}>
          {copy.empty}
        </p>
      ) : null}
      <p id={`${id}-n`} className={`${cls}-note`}>
        {copy.note}
        {length >= countFrom ? (
          <span className={`${cls}-count`} data-testid={`${testId}-count`} aria-live="polite" data-full={length >= max ? "" : undefined}>
            {" "}
            {fmt(copy.count, { n: length, max })}
          </span>
        ) : null}
      </p>
      {after}
    </form>
  );
}
