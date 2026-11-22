"use client";

import Link from "next/link";
import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";
import { filmStudioStrings } from "@/lib/i18n/film-studio";
import { useChannelPath } from "@/lib/channels-client";
import { CONTACT_HREF, LEGAL } from "@/lib/legal";
import type { FilmQuote } from "@/lib/studio/timeline";
import { PROVIDER_DOWN_WORDS, startReasonText, useFilmStart, type BlockReason, type ReasonDictionaries } from "@/lib/studio/useFilmStart";
// TODO(S5): replace with `@/components/ds/States` once #899 merges (same names and props: a one-line import change).
import { InsufficientCredits, ProviderUnavailable, SessionExpired } from "./filmStartStates";

export interface FilmCreateButtonProps {
  filmId: string;
  /** The server's quote (coerceQuote of quote_film's answer), or null when there is none. The button never prices. */
  quote: FilmQuote | null;
  /** Called once a start went through (`replayed`: this press had already been counted). */
  onStarted: (result: { replayed: boolean }) => void;
  /** A fresh quote; defaults to reading the project's version and POSTing the quote route. */
  requote?: () => Promise<FilmQuote | null>;
  className?: string;
}

/**
 * "Create" for a project started outside the timeline: the server's quote → the person confirms that number → the start route holds
 * it. It only calls the routes and stops (rule 3), shows no number the server did not answer (rule 5), and every refusal names its
 * remedy (rule 6). The states live in useFilmStart; this file only says them.
 */
export function FilmCreateButton({ filmId, quote, onStarted, requote, className }: FilmCreateButtonProps) {
  const { t, fmt, locale } = useI18n();
  const c = t.studioTimeline;
  const k = c.create;
  const path = useChannelPath();
  const { state, slow, press, confirm, cancel } = useFilmStart({ filmId, quote, requote, onStarted });
  const noteId = useId();
  const keyRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const dicts: ReasonDictionaries = {
    create: k,
    startFailed: c.startFailed,
    creativeErrors: t.creative.errors,
    filmErrors: filmStudioStrings(locale ?? "en").errors,
  };
  const reasonText = (word: string | null) => startReasonText(word, dicts);

  const billing = path("/billing");
  const supportHref = LEGAL.contactEmail ? `mailto:${LEGAL.contactEmail}` : CONTACT_HREF;

  // Short of credits: the price and the balance as context, both the quote's own numbers (total → needed, available → available),
  // never a live "N credits" on the key.
  const insufficient = (q: FilmQuote) => <InsufficientCredits needed={q.total} available={q.available} addCreditsHref={billing} compact />;
  // The model's name is not in the quote the browser keeps, so it is said as unknown rather than guessed.
  const providerDown = <ProviderUnavailable provider={c.unknown} compact />;
  const isProviderDown = (w: string | null) => w !== null && (PROVIDER_DOWN_WORDS as readonly string[]).includes(w);
  const supportLink = (
    <a href={supportHref} className="underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" data-testid="film-create-support">
      {k.support}
    </a>
  );

  const blockLine = (r: BlockReason): ReactNode => {
    if (r.kind === "no_quote") return k.noQuote;
    if (r.kind === "not_admin") return c.notAdmin;
    if (r.kind === "unpriced") return isProviderDown(r.word) ? null : (reasonText(r.word) ?? k.unpriced.other);
    return c.blocked[r.block];
  };

  const busy = state.at === "starting" || state.at === "requoting";
  const actionable =
    state.at === "idle" ||
    state.at === "network_error" ||
    state.at === "requote_failed" ||
    state.at === "session_expired" ||
    (state.at === "refused" && state.remedy !== "none" && state.remedy !== "sign_in");

  let label: string = k.create;
  if (state.at === "idle") label = state.quote.exempt || state.quote.total === null ? k.create : fmt(k.createFor, { n: state.quote.total });
  else if (state.at === "starting") label = c.starting;
  else if (state.at === "requoting") label = k.requoting;
  else if (state.at === "started") label = k.startedKey;
  else if (state.at === "network_error" || state.at === "session_expired" || state.at === "requote_failed") label = c.retry;
  else if (state.at === "refused" && actionable) label = k.getNewPrice;

  let note: ReactNode = null;
  // The shared states (role="alert") sit beside the note, never inside its live region, so nothing is announced twice.
  let extra: ReactNode = null;
  if (state.at === "blocked") {
    const lines = state.reasons.map((r) => blockLine(r)).filter((l) => l !== null);
    note = (
      <>
        <span className="block">{k.blockedTitle}</span>
        {lines.length > 0 && (
          <ul className="list-disc ps-5" data-testid="film-create-reasons">
            {lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
      </>
    );
    const q = state.quote;
    extra = (
      <>
        {q && state.reasons.some((r) => r.kind === "block" && r.block === "insufficient_credits") && insufficient(q)}
        {state.reasons.some((r) => r.kind === "unpriced" && isProviderDown(r.word)) && providerDown}
      </>
    );
  } else if (state.at === "idle" && state.quote.exempt) note = k.exemptNote;
  else if (busy) note = slow ? k.stillWorking : null;
  else if (state.at === "started") note = state.replayed ? c.replayed : k.startedNote;
  else if (state.at === "refused") {
    const text = reasonText(state.word);
    if (state.remedy === "add_credits") extra = insufficient(state.quote);
    else if (isProviderDown(state.word)) extra = providerDown;
    note = (
      <>
        {!isProviderDown(state.word) && <span className="block" data-testid="film-create-refusal">{text ?? c.startFailed.other}</span>}
        {state.remedy === "plans" && (
          <Link href={billing} className="underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" data-testid="film-create-plans">
            {k.seePlans}
          </Link>
        )}
        {/* An unknown word still offers a way out: a new price (the key) and a person to ask. */}
        {(state.remedy === "support" || text === null) && supportLink}
      </>
    );
  } else if (state.at === "requote_failed") note = k.requoteFailed;
  // No answer is not a refusal: the start may have gone through, so it never says "nothing was held" (rule 5).
  else if (state.at === "network_error") note = c.startNoAnswer;
  // Nothing reached the database: the key resumes the same press after signing in, in a new tab so this screen stays.
  else if (state.at === "session_expired") extra = <SessionExpired signInHref="/login" draftKept compact />;

  // A held key never presses twice: the browser's repeat of Enter or Space on the key is dropped before it becomes a click.
  const noRepeat = (e: ReactKeyboardEvent) => {
    if (e.repeat) e.preventDefault();
  };

  // The key is disabled while confirming or starting, so focus that would drop to the page body comes back to the key (or the
  // region) once there is something to press.
  useEffect(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (!lost || state.at === "confirming") return;
    if (keyRef.current && !keyRef.current.disabled) keyRef.current.focus();
    else rootRef.current?.focus();
  }, [state.at]);

  return (
    <div ref={rootRef} tabIndex={-1} className={["flex min-w-0 max-w-full flex-col gap-2 outline-none", className].filter(Boolean).join(" ")} data-testid="film-create" data-state={state.at}>
      <button
        type="button"
        ref={keyRef}
        className="btn-primary min-h-11 w-full whitespace-nowrap px-4 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-45 disabled:grayscale sm:w-auto sm:self-start"
        onClick={press}
        onKeyDown={noRepeat}
        disabled={!actionable}
        aria-busy={busy}
        aria-describedby={note ? noteId : undefined}
        data-testid="film-create-key"
      >
        {label}
      </button>
      {note && (
        <div id={noteId} className="min-w-0 break-words text-sm" role="status" aria-live="polite" data-testid="film-create-note">
          {note}
        </div>
      )}
      {extra}
      {state.at === "confirming" && (
        <ConfirmPanel
          title={k.confirmTitle}
          change={
            state.change === null
              ? null
              : state.change.delta > 0
                ? fmt(k.changedUp, { from: state.change.from, to: state.change.to, d: state.change.delta })
                : state.change.delta < 0
                  ? fmt(k.changedDown, { from: state.change.from, to: state.change.to, d: -state.change.delta })
                  : fmt(k.changedSame, { to: state.change.to })
          }
          // The one sentence that explains the hold (Pixel: three sentences said it three ways).
          body={state.quote.exempt || state.quote.total === null ? k.exemptNote : fmt(c.confirmBody, { n: state.quote.total })}
          cancel={c.cancel}
          confirm={state.quote.exempt || state.quote.total === null ? k.confirmExempt : fmt(c.confirm, { n: state.quote.total })}
          onCancel={cancel}
          onConfirm={confirm}
        />
      )}
    </div>
  );
}

/**
 * The confirmation, inline rather than a modal so it fits a chat column at 360 px. Focus starts on Cancel (a held Enter that opened
 * it cannot also confirm), Escape cancels, and a repeated key press is ignored.
 */
function ConfirmPanel({
  title,
  change,
  body,
  cancel,
  confirm,
  onCancel,
  onConfirm,
}: {
  title: string;
  change: string | null;
  body: string;
  cancel: string;
  confirm: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.repeat) {
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <div role="group" aria-labelledby={titleId} className="flex min-w-0 flex-col gap-2 rounded-md border border-[var(--color-line,currentColor)] p-3 text-sm" onKeyDown={onKey} data-testid="film-create-confirm">
      <h3 id={titleId} className="font-semibold">
        {title}
      </h3>
      {change && (
        <p className="font-semibold" data-testid="film-create-change">
          {change}
        </p>
      )}
      <p className="break-words">{body}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" ref={first} className="btn-quiet min-h-11 px-4 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" onClick={onCancel} data-testid="film-create-cancel">
          {cancel}
        </button>
        <button
          type="button"
          className="btn-primary min-h-11 max-w-full px-4 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          onClick={onConfirm}
          data-testid="film-create-confirm-key"
        >
          {confirm}
        </button>
      </div>
    </div>
  );
}
