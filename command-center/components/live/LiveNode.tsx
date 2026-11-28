"use client";

/**
 * One card on the live canvas (LIVE_CREATION_PLAN §2, item 4): a script, a shot, a cast sheet, a still, a clip, a voice, the
 * film. It draws every state a step can be in and nothing else: it reads no data, starts nothing and spends nothing. The board
 * (S3's StoryBoard) maps the server's events onto these props.
 *
 * Honesty rules the card enforces, whatever it is given (CLAUDE.md rules 3 and 5):
 * - A price chip appears only when `price` is a finite number the backend computed. null is "no price", never 0.
 * - A progress bar appears only for a provider's measured fraction in [0, 1]. Anything else (a percent passed by mistake,
 *   a -1 "unknown") is not a measurement, and the card shows elapsed time instead of a wrong bar.
 * - A queue position appears only when the provider reported one.
 * - The light running round the edge is drawn only in the working state, which the caller sets from a real event.
 * - A retry with no finite backend price cannot be pressed, and says so.
 * - A machine's words (prompt, model, timer) are set in mono, so they never read as the person's.
 *
 * Built for a board of 10–60 cards that re-reads every few seconds: every prop is a primitive (or a short list of names), the
 * two callbacks take the card's id so the board passes one stable function to all of them, and the card is memoized. The
 * elapsed timer is its own leaf on one shared clock, so a tick re-renders a few characters, not the card.
 */
import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n/core";
import { creditUnit, formatCredits } from "@/lib/credits";
import { cn } from "@/lib/cn";
import { BorderBeam, TextShimmer } from "@/components/ui/effects";
import { Button, buttonClass } from "@/components/ds/Button";
import { RevealText } from "./RevealText";
import { formatElapsed, useElapsed } from "./useElapsed";
import { LANDED_GLOW_MS, MEDIA_OF, isAppPath, landDelay, type LiveNodeKind, type LiveNodeState, type LivePhase } from "./model";
import "./live.css";

export type { LiveNodeKind, LiveNodeState, LivePhase, LiveMediaType } from "./model";

export interface LiveNodeProps {
  /** The board's id for this card: passed back to onOpen and onRetry. */
  id: string;
  kind: LiveNodeKind;
  state: LiveNodeState;
  /** The person-facing name: a beat's title, a character's name, "The harbour at dawn". */
  title: string;
  /** The shot this card belongs to (a shot, or a still or clip made for one), 1-based. */
  shot?: number | null;
  /** The checked prompt or line, in mono. */
  prompt?: string | null;
  /** True when `prompt` has just arrived in front of the person: it is revealed. False on a refresh: shown at once. */
  revealPrompt?: boolean;
  model?: string | null;
  /** Working: what the job is doing, as the server said. */
  phase?: LivePhase | null;
  /** When the job started, from the server's row (epoch ms). Without it no timer is shown. */
  startedAt?: number | null;
  /** A fraction in [0, 1], ONLY when the provider measured it. */
  progress?: number | null;
  /** The provider's own queue position, when it reports one. */
  queuePosition?: number | null;
  /** Credits, as the backend computed them. */
  price?: number | null;
  /** Arrived: the picture to show (a still, a sheet, a clip's poster frame). Keep it stable across re-reads. */
  mediaSrc?: string | null;
  mediaAlt?: string | null;
  /** Failed: the cause and the remedy, already in the reader's words (the caller maps the error code). */
  failureCause?: string | null;
  failureRemedy?: string | null;
  /**
   * Failed: the backend's price for a retry of this step only. undefined: no retry is offered. null (or not finite): a retry
   * exists but has no price, so its key cannot be pressed and says "price unavailable".
   */
  retryPrice?: number | null;
  retryBusy?: boolean;
  /** Disabled: why, in the reader's words. Without it the card says the reason was not recorded (never a blank). */
  reason?: string | null;
  /** Insufficient: how many more credits are needed (a backend number), and the app path where they are added. */
  shortfallCredits?: number | null;
  topUpHref?: string | null;
  /** The characters in this shot, by name: chips under the body. */
  cast?: readonly string[] | null;
  /** A person's mark (lime): this card is the one they chose or are looking at. */
  selected?: boolean;
  /** Opens the card's details. The whole card is the target; its own keys stay above it. */
  onOpen?: (id: string) => void;
  onRetry?: (id: string) => void;
  /** Its place in a group that lands together: sets the stagger. */
  order?: number;
  /** Skip every motion over 200 ms (the board's "show all"). */
  instant?: boolean;
  /**
   * Announce a watched arrival in this card's own live region. Off by default: a board of many cards should announce once,
   * in one region, with names ("3 stills ready: …"), because a burst of identical per-card messages is merged or dropped by
   * some screen readers. The specimen, or a board of one, turns it on.
   */
  announce?: boolean;
  /** The heading level of the card's title in the page's outline. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

function useLandedGlow(state: LiveNodeState): boolean {
  // Only a change seen on this screen celebrates: a card first read as arrived (a refresh) gets no glow, because nothing
  // happened in front of anyone (the same rule as the Studio canvas's finish ring, #968).
  const seen = useRef<LiveNodeState | null>(null);
  const [lit, setLit] = useState(false);
  useEffect(() => {
    const before = seen.current;
    seen.current = state;
    if (state === "arrived" && (before === "working" || before === "queued")) {
      setLit(true);
      const id = setTimeout(() => setLit(false), LANDED_GLOW_MS);
      return () => clearTimeout(id);
    }
    if (state !== "arrived") setLit(false);
  }, [state]);
  return lit;
}

/** The timer, as its own leaf: one shared clock re-renders this span, not the card. */
function Elapsed({ startedAt, label }: { startedAt: number | null | undefined; label: string }) {
  const seconds = useElapsed(startedAt, true);
  if (seconds == null) return null;
  const time = formatElapsed(seconds);
  return (
    <span className="live-node-time ds-mono">
      <span className="ds-sr-only">{fmt(label, { time })}</span>
      <span aria-hidden>{time}</span>
    </span>
  );
}

/**
 * An arrived picture, keyed by its source by the caller: a new take starts unloaded and gets its own fade-in. A picture that
 * fails to load (a signed link that expired while the canvas stayed open) says so; it is never an empty wash under "Ready".
 */
function LiveMedia({ src, alt, failedText }: { src: string; alt: string; failedText: string }) {
  const [phase, setPhase] = useState<"loading" | "loaded" | "failed">("loading");
  const img = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    // A cached picture can finish before React attaches onLoad.
    const el = img.current;
    if (el?.complete && el.naturalWidth > 0) setPhase("loaded");
  }, []);
  return (
    <div className="live-node-media" data-loaded={phase === "loaded" ? "true" : undefined}>
      {phase === "failed" ? (
        <p className="live-node-media-note ds-t-caption">{failedText}</p>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived media URL; next/image would proxy it.
        <img ref={img} src={src} alt={alt} onLoad={() => setPhase("loaded")} onError={() => setPhase("failed")} />
      )}
    </div>
  );
}

function LiveNodeView(props: LiveNodeProps) {
  const {
    id,
    kind,
    state,
    title,
    shot,
    prompt,
    revealPrompt = false,
    model,
    phase,
    startedAt,
    progress,
    queuePosition,
    price,
    mediaSrc,
    mediaAlt,
    failureCause,
    failureRemedy,
    retryPrice,
    retryBusy = false,
    reason,
    shortfallCredits,
    topUpHref,
    cast,
    selected = false,
    onOpen,
    onRetry,
    order,
    instant = false,
    announce = false,
    headingLevel = 3,
    className,
  } = props;
  const { t, locale } = useI18n();
  const l = t.liveNodes;
  const titleId = useId();
  const working = state === "working";
  const landed = useLandedGlow(state);
  const mediaType = MEDIA_OF[kind];
  const H = `h${headingLevel}` as const;

  const n = typeof shot === "number" && Number.isFinite(shot) && shot > 0 ? String(Math.floor(shot)).padStart(2, "0") : null;
  const kindLabel =
    kind === "shot" ? (n ? fmt(l.kind.shot, { n }) : l.kind.shotUnnumbered) : n ? fmt(l.kind.ofShot, { kind: l.kind[kind], n }) : l.kind[kind];
  const credits = (c: number) => fmt(l.price, { n: formatCredits(c, locale), unit: creditUnit(c, locale, t.shell.creditUnit) });
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const measured = finite(progress) && progress >= 0 && progress <= 1 ? Math.round(progress * 100) : null;
  const statusWord = working && phase ? l.phase[phase] : l.state[state];
  const retryPriced = finite(retryPrice);
  const topUp = topUpHref && isAppPath(topUpHref) ? topUpHref : null;

  return (
    <article
      aria-labelledby={titleId}
      data-state={state}
      data-media={mediaType}
      data-kind={kind}
      data-selected={selected ? "true" : undefined}
      data-landed={landed ? "true" : undefined}
      data-instant={instant ? "true" : undefined}
      className={cn("live-node", className)}
      style={{ "--live-delay": `${instant ? 0 : landDelay(order)}ms` } as CSSProperties}
    >
      <BorderBeam active={working} size={120} duration={3.5} width={1.5} />
      <header className="live-node-head">
        <span className="live-node-kind ds-t-label">
          <span className="live-node-dot" aria-hidden />
          {kindLabel}
        </span>
        {finite(price) ? (
          <span className="live-node-price ds-mono">
            <span className="ds-sr-only">{l.priceLabel}: </span>
            {credits(price)}
          </span>
        ) : null}
      </header>

      <H className="live-node-title ds-t-heading-sm">
        {onOpen ? (
          // The title is the button's name: "Mara, the keeper", not "Open Mara…", so the heading and the card keep their name.
          <button type="button" className="live-node-open nodrag nopan" onClick={() => onOpen(id)}>
            <span id={titleId}>{title}</span>
          </button>
        ) : (
          <span id={titleId}>{title}</span>
        )}
      </H>

      {mediaType !== "text" && (state === "arrived" || state === "working" || state === "queued") ? (
        state === "arrived" && mediaSrc ? (
          <LiveMedia key={mediaSrc} src={mediaSrc} alt={mediaAlt ?? fmt(l.resultAlt, { name: title })} failedText={l.mediaFailed} />
        ) : (
          <div className="live-node-media" aria-hidden />
        )
      ) : null}

      {prompt ? (
        <div className="live-node-prompt">
          <span className="live-node-meta ds-t-label">
            {l.prompt} · {l.written}
          </span>
          <div className="live-node-prompt-text ds-mono">
            <RevealText as="span" text={prompt} reveal={revealPrompt} instant={instant} />
          </div>
        </div>
      ) : null}

      <div className="live-node-status">
        {/* The colour sits on the wrapper: on the shimmer itself an unlayered colour would paint over its band of light. */}
        <span className="live-node-word">
          {working ? <TextShimmer active>{statusWord}</TextShimmer> : statusWord}
        </span>
        {working ? <Elapsed startedAt={startedAt} label={l.elapsed} /> : null}
        {model ? (
          <span className="live-node-model ds-mono">
            <span className="ds-sr-only">{l.model}: </span>
            {model}
          </span>
        ) : null}
      </div>

      {(working || state === "queued") && finite(queuePosition) && queuePosition > 0 ? (
        <p className="live-node-note ds-t-caption">{fmt(l.queuePosition, { n: queuePosition })}</p>
      ) : null}

      {working && measured != null ? (
        <div
          className="live-node-progress"
          role="progressbar"
          aria-label={l.progressLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={measured}
          aria-valuetext={fmt(l.measured, { pct: measured })}
          style={{ "--live-progress": `${measured}%` } as CSSProperties}
        >
          <span aria-hidden />
        </div>
      ) : null}

      {state === "failed" && (failureCause || failureRemedy) ? (
        <dl className="live-node-fail ds-t-caption">
          {failureCause ? (
            <>
              <dt>{l.failed.cause}</dt>
              <dd>{failureCause}</dd>
            </>
          ) : null}
          {failureRemedy ? (
            <>
              <dt>{l.failed.remedy}</dt>
              <dd>{failureRemedy}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {state === "failed" && retryPrice !== undefined ? (
        <Button
          variant="secondary"
          className="live-node-key nodrag nopan"
          disabled={!retryPriced}
          loading={retryBusy}
          busyLabel={l.failed.retrying}
          onClick={retryPriced && onRetry ? () => onRetry(id) : undefined}
        >
          {retryPriced ? fmt(l.failed.retry, { n: formatCredits(retryPrice, locale), unit: creditUnit(retryPrice, locale, t.shell.creditUnit) }) : l.failed.retryUnpriced}
        </Button>
      ) : null}

      {state === "disabled" ? <p className="live-node-note ds-t-caption">{reason || l.disabledNoReason}</p> : null}

      {state === "insufficient" ? (
        <div className="live-node-short">
          {finite(shortfallCredits) && shortfallCredits > 0 ? (
            <p className="ds-t-caption">
              {fmt(l.insufficient.shortfall, {
                n: formatCredits(shortfallCredits, locale),
                unit: creditUnit(shortfallCredits, locale, t.shell.creditUnit),
              })}
            </p>
          ) : null}
          {topUp ? (
            <Link className={buttonClass({ variant: "secondary", className: "live-node-key nodrag nopan" })} href={topUp}>
              {l.insufficient.topUp}
            </Link>
          ) : null}
        </div>
      ) : null}

      {cast && cast.length > 0 ? (
        <ul className="live-node-cast" aria-label={l.cast}>
          {cast.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : null}

      {/* Present from the first render, so a screen reader hears the arrival: a live region inserted with its words in it
          is often not announced. It speaks only for an arrival watched on this screen, and only when the board asks. */}
      {announce ? (
        <span className="ds-sr-only" role="status">
          {state === "arrived" && landed ? fmt(l.ready, { kind: kindLabel, name: title }) : ""}
        </span>
      ) : null}
    </article>
  );
}

function sameNames(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

/** Re-renders only when a prop really changed: every prop is compared by value, the cast list name by name. */
export const LiveNode = memo(LiveNodeView, (prev, next) => {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof LiveNodeProps>;
  for (const k of keys) {
    if (k === "cast") {
      if (!sameNames(prev.cast, next.cast)) return false;
    } else if (!Object.is(prev[k], next[k])) return false;
  }
  return true;
});
