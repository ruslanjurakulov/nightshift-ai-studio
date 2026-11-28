"use client";

import Link from "next/link";
import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { PriceButton } from "@/components/ui/PriceButton";
import { formatCredits } from "@/lib/credits";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { CONTACT_HREF, LEGAL } from "@/lib/legal";
import { pluralForm } from "@/lib/plural";
import type { FilmQuote } from "@/lib/studio/timeline";
import {
  ALREADY_STARTED_WORDS,
  blockRemedy,
  isProviderDown,
  startReasonText,
  startRemedy,
  useFilmStart,
  type BlockReason,
  type BlockRemedy,
  type ReasonDictionaries,
  type StartRemedy,
} from "@/lib/studio/useFilmStart";
// TODO(S5): replace with `@/components/ds/States` once #899 merges (same names and props: a one-line import change).
import { InsufficientCredits, ProviderUnavailable, SessionExpired } from "./filmStartStates";
import { creditsText, keyClass } from "./filmStartStates";

export interface FilmCreateButtonProps {
  /** The project. Pass `key={filmId}` too, so another project mounts a fresh button (a stale answer is also dropped inside). */
  filmId: string;
  /** The server's quote (coerceQuote of quote_film's answer), or null when there is none. The button never prices. */
  quote: FilmQuote | null;
  /** Called once a start went through (`replayed`: this press had already been counted). */
  onStarted: (result: { replayed: boolean }) => void;
  /** A fresh quote; defaults to reading the project's version and POSTing the quote route. */
  requote?: () => Promise<FilmQuote | null>;
  /** Where a started project's progress is, when onStarted does not navigate there itself: shown as "Open progress". */
  progressHref?: string;
  /** The caller shows the progress itself, beside this button (Nightshift AI's Plan column): once started, the note says so and no
   *  key leads away to another page. `progressHref` is still the way on for a project that had already been started. */
  inPlace?: boolean;
  /** A model is down: let the person pick another (it is never swapped automatically). Without it, the way forward is support. */
  onChooseAnother?: () => void;
  /**
   * The project editor. A refusal the person fixes in the project (model_not_set, prompt_missing…) then links there as its primary
   * way forward, with "Check again" beside it; without it, "Check again" alone loops on the same answer (S1).
   */
  fixHref?: string;
  className?: string;
}

const VOICE_LANGUAGE_WORDS: readonly string[] = ["voice_language_unsupported", "voice_language_unknown"];
const FOCUS_RING ="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

/**
 * "Create" for a project started outside the timeline: the server's quote → the person confirms that number → the start route holds
 * it. It only calls the routes and stops (rule 3), shows no number the server did not answer (rule 5), and every refusal and every
 * blocked reason names one way forward (rule 6). The states live in useFilmStart; this file only says them.
 */
export function FilmCreateButton({ filmId, quote, onStarted, requote, progressHref, inPlace = false, onChooseAnother, fixHref, className }: FilmCreateButtonProps) {
  const { t, fmt, locale: rawLocale } = useI18n();
  const locale = rawLocale ?? "en";
  const c = t.studioTimeline;
  const k = c.create;
  const path = useChannelPath();
  const { state, slow, cooling, canResume, press, confirm, cancel, recheck } = useFilmStart({ filmId, quote, requote, onStarted });
  const noteId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  const dicts: ReasonDictionaries = { create: k, startFailed: c.startFailed };
  const reasonText = (word: string | null) => startReasonText(word, dicts);
  const billing = path("/billing");
  const supportHref = LEGAL.contactEmail ? `mailto:${LEGAL.contactEmail}` : CONTACT_HREF;
  const unit = (n: number) => pluralForm(k.unit, n, locale);

  const supportLink = (variant: "primary" | "secondary" | "quiet") => (
    <a key="support" href={supportHref} className={keyClass(variant)} data-primary={variant === "primary" || undefined}>
      {k.support}
    </a>
  );
  const plansLink = (variant: "primary" | "secondary") => (
    <Link key="plans" href={billing} className={keyClass(variant)} data-primary={variant === "primary" || undefined}>
      {k.seePlans}
    </Link>
  );
  const smallKey = (key: string, label: string, onClick: () => void, variant: "primary" | "secondary" | "quiet", disabled = false) => (
    <button key={key} type="button" className={keyClass(variant)} onClick={onClick} disabled={disabled} data-primary={variant === "primary" || undefined}>
      {label}
    </button>
  );
  const insufficient = (q: FilmQuote | null) => <InsufficientCredits key="credits" needed={q?.total ?? null} available={q?.available ?? null} addCreditsHref={billing} compact />;
  const providerDown = (secondary: boolean) =>
    onChooseAnother ? <ProviderUnavailable key="provider" provider="" onChooseAnother={onChooseAnother} compact /> : (
      <div key="provider" className="flex flex-col gap-2">
        <ProviderUnavailable provider="" compact />
        {supportLink(secondary ? "secondary" : "primary")}
      </div>
    );

  const fixLink = () => (
    <Link key="fix" href={fixHref ?? ""} className={keyClass("primary")} data-primary>
      {k.openToFix}
    </Link>
  );

  /** The way forward for a refused start or a refused re-quote. The real remedy is the primary key (Pixel M1). */
  const remedyActions = (word: string, remedy: StartRemedy, q: FilmQuote | null): { key: { label: string; enabled?: boolean } | null; actions: ReactNode[] } => {
    if ((ALREADY_STARTED_WORDS as readonly string[]).includes(word)) {
      return { key: null, actions: progressHref ? [<Link key="progress" href={progressHref} className={keyClass("primary")} data-primary>{k.openProgress}</Link>] : [] };
    }
    // Only a member may start a paid project (0215): there is nothing to retry here, only someone to ask.
    if (word === "not_a_member") return { key: null, actions: [] };
    if (isProviderDown(word)) return { key: { label: k.tryAgain }, actions: [providerDown(true)] };
    switch (remedy) {
      case "add_credits":
        return { key: null, actions: [insufficient(q), smallKey("again", k.getNewPrice, recheck, "quiet", cooling)] };
      case "plans":
        return { key: null, actions: [plansLink("primary"), smallKey("again", k.getNewPrice, recheck, "quiet", cooling)] };
      case "support":
        return { key: null, actions: [supportLink("primary"), smallKey("again", k.getNewPrice, recheck, "quiet", cooling)] };
      case "wait":
        return { key: { label: k.tryAgain }, actions: [] };
      case "fix_and_requote":
        if (fixHref) return { key: null, actions: [fixLink(), smallKey("again", k.checkAgain, recheck, "secondary", cooling)] };
        return { key: { label: k.getNewPrice }, actions: [] };
      case "requote":
        return { key: { label: k.getNewPrice }, actions: [] };
      default:
        // Nothing on this screen helps (not_found, forbidden…): the key stays, disabled, beside the reason (Lens M3).
        return { key: { label: k.create, enabled: false }, actions: [] };
    }
  };

  const blockAction = (r: BlockRemedy, q: FilmQuote | null): ReactNode => {
    switch (r) {
      case "add_credits":
        return insufficient(q);
      case "plans":
        return plansLink("secondary");
      case "recheck":
        return smallKey("recheck", k.checkAgain, recheck, "secondary");
      case "support":
        return supportLink("secondary");
      case "choose_another":
        return providerDown(true);
      default:
        return null;
    }
  };

  const blockLine = (r: BlockReason): ReactNode => {
    if (r.kind === "no_quote") return k.noQuote;
    if (r.kind === "not_admin") return c.notAdmin;
    // A model that is down is said by ProviderUnavailable, beside the list.
    if (r.kind === "unpriced") {
      if (isProviderDown(r.word)) return null;
      const text = reasonText(r.word) ?? k.unpriced.other;
      // The database names what it checked ("Eleven v3 does not speak Uzbek"): shown under the reason for a voice's language, where
      // "choose another voice model" alone does not say which one failed.
      const detail = r.detail && r.word !== null && VOICE_LANGUAGE_WORDS.includes(r.word) ? r.detail : null;
      return detail ? (
        <>
          {text}
          <span className="block text-xs opacity-80" data-testid="film-create-line-detail">
            {detail}
          </span>
        </>
      ) : (
        text
      );
    }
    return c.blocked[r.block];
  };

  // ── what each state shows ──
  let key: { label: string; credits?: number | null; enabled: boolean; busy?: boolean; tone?: "primary" | "quiet"; onClick: () => void } | null = null;
  let note: ReactNode = null;
  let actions: ReactNode[] = [];

  switch (state.at) {
    case "idle": {
      const q = state.quote;
      key = { label: k.create, credits: q.exempt ? null : q.total, enabled: true, onClick: press };
      if (q.exempt) note = k.exemptNote;
      break;
    }
    case "blocked": {
      const onlyNoQuote = state.reasons.length === 1 && state.reasons[0].kind === "no_quote";
      key = onlyNoQuote ? { label: k.getPrice, enabled: true, onClick: recheck } : { label: k.create, credits: null, enabled: false, onClick: press };
      const lines = state.reasons.map(blockLine).filter((l) => l !== null);
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
      if (!onlyNoQuote) {
        const seen = new Set<BlockRemedy | "fix">();
        for (const r of state.reasons) {
          const rem = blockRemedy(r);
          // A line the person fixes in the project: the editor is the way forward, "Check again" once it is fixed.
          if (fixHref && r.kind === "unpriced" && r.word !== null && startRemedy(r.word) === "fix_and_requote") {
            if (seen.has("fix")) continue;
            seen.add("fix");
            actions.unshift(<span key="fix" className="flex flex-col gap-2">{fixLink()}{smallKey("recheck", k.checkAgain, recheck, "secondary")}</span>);
            continue;
          }
          if (seen.has(rem)) continue;
          seen.add(rem);
          const a = blockAction(rem, state.quote);
          if (a) actions.push(<span key={rem}>{a}</span>);
        }
      }
      break;
    }
    case "confirming":
      // One primary per view: the confirmation's own key (Pixel M5).
      break;
    case "starting":
      key = { label: c.starting, enabled: false, busy: true, onClick: press };
      note = slow ? k.stillWorking : null;
      break;
    case "requoting":
      key = { label: k.requoting, enabled: false, busy: true, onClick: press };
      note = slow ? k.stillWorking : null;
      break;
    case "started":
      note = inPlace ? k.startedInPlace : state.replayed ? c.replayed : k.startedNote;
      if (progressHref && !inPlace) actions = [<Link key="progress" href={progressHref} className={keyClass("primary")} data-primary>{k.openProgress}</Link>];
      break;
    case "refused":
    case "requote_failed": {
      const q = state.at === "refused" ? state.quote : state.from;
      const text = reasonText(state.word);
      const r = remedyActions(state.word, state.remedy, q);
      if (r.key) key = { label: r.key.label, enabled: r.key.enabled !== false && !cooling, onClick: press };
      actions = r.actions;
      // An unknown word still offers a way out: a new price and a person to ask.
      if (text === null && state.remedy !== "support") actions = [...actions, supportLink("secondary")];
      note = (
        <>
          {state.at === "requote_failed" && <span className="block">{k.requoteFailed}</span>}
          {!isProviderDown(state.word) && (
            <span className="block" data-testid="film-create-refusal">
              {text ?? c.startFailed.other}
            </span>
          )}
          {state.detail && (
            <span className="block text-xs opacity-80" data-testid="film-create-detail">
              {state.detail}
            </span>
          )}
          {cooling && state.retryAfter !== null && <span className="block">{fmt(k.retryIn, { n: Math.max(1, Math.ceil(state.retryAfter / 60)) })}</span>}
        </>
      );
      break;
    }
    // No answer is not a refusal: the start may have gone through, so it never says "nothing was held" (rule 5).
    case "network_error":
      key = { label: k.tryAgain, enabled: true, onClick: press };
      note = c.startNoAnswer;
      break;
    case "session_expired":
      // Nothing reached the database. The sign-in is the primary; the retry waits until the person is back (Pixel L4).
      actions = [<SessionExpired key="session" signInHref="/login" draftKept compact />];
      key = { label: k.tryAgain, enabled: canResume, tone: "quiet", onClick: press };
      break;
  }

  // A held key never presses twice: the browser's repeat of Enter or Space on the key is dropped before it becomes a click.
  const noRepeat = (e: ReactKeyboardEvent) => {
    if (e.repeat) e.preventDefault();
  };

  // After an async answer, focus that sat on a key that is gone or disabled (the page body, or this region itself) goes to the way
  // forward: the primary action, else the first usable key or link, else the region with a visible ring (Pixel H1).
  useEffect(() => {
    const root = rootRef.current;
    if (!root || state.at === "confirming") return;
    const a = document.activeElement;
    const lost = !a || a === document.body || a === root;
    if (!lost) return;
    const usable = (el: Element | null): el is HTMLElement => !!el && !(el as HTMLButtonElement).disabled;
    const primary = [...root.querySelectorAll("[data-primary]")].find(usable);
    const first = [...root.querySelectorAll("button, a[href]")].find(usable);
    (primary ?? first ?? root).focus();
  }, [state.at]);

  const change = state.at === "confirming" ? state.change : null;
  const changeText =
    change === null
      ? null
      : creditsText(change.delta > 0 ? k.changedUp : change.delta < 0 ? k.changedDown : k.changedSame, change.to, locale, {
          from: formatCredits(change.from, locale),
          d: formatCredits(Math.abs(change.delta), locale),
        });

  return (
    <div ref={rootRef} tabIndex={-1} className={["flex min-w-0 max-w-full flex-col gap-2 rounded-md", FOCUS_RING, className].filter(Boolean).join(" ")} data-testid="film-create" data-state={state.at}>
      {key && (
        <PriceButton
          label={key.label}
          credits={key.credits ?? null}
          unit={typeof key.credits === "number" ? unit(key.credits) : undefined}
          locale={locale}
          size="md"
          tone={key.tone}
          className={`whitespace-nowrap ${FOCUS_RING}`}
          onClick={key.onClick}
          onKeyDown={noRepeat}
          disabled={!key.enabled}
          aria-busy={key.busy ?? false}
          aria-describedby={note ? noteId : undefined}
          data-primary={key.tone !== "quiet" || undefined}
          data-testid="film-create-key"
        />
      )}
      {/* Always in the page, so the first message is announced too (Pixel M6). */}
      <div id={noteId} className="min-w-0 break-words text-sm" role="status" aria-live="polite" data-testid="film-create-note">
        {note}
      </div>
      {actions.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2" data-testid="film-create-actions">
          {actions}
        </div>
      )}
      {state.at === "confirming" && (
        <ConfirmPanel
          title={k.confirmTitle}
          change={changeText}
          body={state.quote.exempt ? k.exemptNote : state.quote.total === null ? k.priceUnknown : creditsText(c.confirmBody, state.quote.total, locale)}
          cancel={c.cancel}
          confirm={state.quote.exempt || state.quote.total === null ? k.confirmExempt : creditsText(c.confirm, state.quote.total, locale)}
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
    <div role="group" aria-labelledby={titleId} className="flex min-w-0 flex-col gap-2 rounded-md border border-[var(--color-border)] p-3 text-sm" onKeyDown={onKey} data-testid="film-create-confirm">
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
        <button type="button" ref={first} className={keyClass("quiet")} onClick={onCancel} data-testid="film-create-cancel">
          {cancel}
        </button>
        <button type="button" className={`${keyClass("primary")} max-w-full`} onClick={onConfirm} data-testid="film-create-confirm-key">
          {confirm}
        </button>
      </div>
    </div>
  );
}
