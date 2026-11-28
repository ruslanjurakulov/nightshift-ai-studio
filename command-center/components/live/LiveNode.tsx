"use client";

/**
 * One card on the live canvas (LIVE_CREATION_PLAN §2, item 4): a script, a shot, a cast sheet, a still, a clip, a voice, the
 * film. It draws every state a step can be in and nothing else: it reads no data, starts nothing and spends nothing. The board
 * (S3's StoryBoard) maps the server's events onto these props.
 *
 * Honesty rules the card enforces, whatever it is given (CLAUDE.md rules 3 and 5):
 * - A price chip appears only when `price` is a number the backend computed. null is "no price", never 0.
 * - A progress bar appears only when the provider itself measured one (`progress`). Otherwise the card shows elapsed time.
 * - A queue position appears only when the provider reported one.
 * - The light running round the edge is drawn only in the working state, which the caller sets from a real event.
 * - A failed retry with no backend price cannot be pressed, and says so.
 * - A machine's words (prompt, model, timer) are set in mono, so they never read as the person's.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n/core";
import { creditUnit, formatCredits } from "@/lib/credits";
import { cn } from "@/lib/cn";
import { BorderBeam, TextShimmer } from "@/components/ui/effects";
import { Button, buttonClass } from "@/components/ds/Button";
import { RevealText } from "./RevealText";
import { formatElapsed, useElapsed } from "./useElapsed";
import "./live.css";

export type LiveNodeKind = "script" | "shot" | "character" | "location" | "prop" | "still" | "clip" | "voice" | "music" | "film";
/** The data a card carries, which colours its edge and its connectors (SYSTEM.md §4: type hues are media identity only). */
export type LiveMediaType = "text" | "image" | "video" | "audio";
export type LiveNodeState = "ghost" | "queued" | "working" | "arrived" | "failed" | "disabled" | "insufficient";
export type LivePhase = "queued" | "making" | "storing";

export const MEDIA_OF: Record<LiveNodeKind, LiveMediaType> = {
  script: "text",
  shot: "text",
  character: "image",
  location: "image",
  prop: "image",
  still: "image",
  clip: "video",
  voice: "audio",
  music: "audio",
  film: "video",
};

/** Time between two cards landing (the plan's 60–120 ms band), and the most a card ever waits for its turn. */
export const LAND_STAGGER_MS = 90;
export const LAND_MAX_DELAY_MS = 540;

export function landDelay(order: number | undefined): number {
  if (order == null || !Number.isFinite(order) || order <= 0) return 0;
  return Math.min(Math.floor(order) * LAND_STAGGER_MS, LAND_MAX_DELAY_MS);
}

/** How long the one soft glow stays after a watched job arrives. */
export const LANDED_GLOW_MS = 1200;

export interface LiveNodeProps {
  kind: LiveNodeKind;
  state: LiveNodeState;
  /** The person-facing name: a beat's title, a character's name, "Scene 4: the harbour". */
  title: string;
  /** Shot number for `shot` (and a still or clip that belongs to one), 1-based. */
  shot?: number;
  /** The checked prompt or line, in mono. */
  prompt?: string | null;
  /** True when `prompt` has just arrived in front of the person: it is revealed. False on a refresh: shown at once. */
  revealPrompt?: boolean;
  model?: string | null;
  /** Working: what the job is doing, as the server said. */
  phase?: LivePhase | null;
  /** When the job started, from the server's row (epoch ms). Without it no timer is shown. */
  startedAt?: number | null;
  /** 0..1, ONLY when the provider measured it. */
  progress?: number | null;
  /** The provider's own queue position, when it reports one. */
  queuePosition?: number | null;
  /** Credits, as the backend computed them. */
  price?: number | null;
  /** Arrived: the picture to show (a still, a sheet, a clip's poster frame). */
  media?: { src: string; alt?: string } | null;
  /** Failed: the cause and the remedy, already in the reader's words (the caller maps the error code). */
  failure?: { cause: string; remedy: string } | null;
  /** Failed: a priced retry of this step only. The card never prices it: `price` null makes it unpressable. */
  retry?: { price: number | null; onRetry: () => void; busy?: boolean } | null;
  /** Disabled: why, in the reader's words. Required in that state: a disabled card never hides its reason. */
  reason?: string | null;
  /** Insufficient: how many more credits are needed (a backend number) and where to add them. */
  shortfall?: { credits: number | null; topUpHref: string } | null;
  /** A person's mark (lime): this card is the one they chose or are looking at. */
  selected?: boolean;
  /** Opens the card's details. The whole card is the target; the card's own keys stay above it. */
  onOpen?: () => void;
  /** Its place in a group that lands together: sets the stagger. */
  order?: number;
  /** Skip every motion over 200 ms (the board's "show all"). */
  instant?: boolean;
  /** Extra content under the body (S3's avatar chips of the characters in a shot). */
  children?: ReactNode;
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

export function LiveNode(props: LiveNodeProps) {
  const {
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
    media,
    failure,
    retry,
    reason,
    shortfall,
    selected = false,
    onOpen,
    order,
    instant = false,
    children,
    className,
  } = props;
  const { t, locale } = useI18n();
  const l = t.liveNodes;
  const titleId = useId();
  const working = state === "working";
  const elapsed = useElapsed(startedAt, working);
  const landed = useLandedGlow(state);
  const [mediaLoaded, setMediaLoaded] = useState(false);
  const mediaType = MEDIA_OF[kind];

  const kindLabel = kind === "shot" && shot != null ? fmt(l.kind.shot, { n: String(shot).padStart(2, "0") }) : kind === "shot" ? l.kind.shot.replace(/\s*\{n\}/, "") : l.kind[kind];
  const credits = (n: number) => fmt(l.price, { n: formatCredits(n, locale), unit: creditUnit(n, locale, t.shell.creditUnit) });
  const measured = typeof progress === "number" && Number.isFinite(progress) ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : null;
  const statusWord = working && phase ? l.phase[phase] : l.state[state];

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
        {typeof price === "number" && Number.isFinite(price) ? (
          <span className="live-node-price ds-mono">
            <span className="ds-sr-only">{l.priceLabel}: </span>
            {credits(price)}
          </span>
        ) : null}
      </header>

      <h3 id={titleId} className="live-node-title ds-t-heading-sm">
        {onOpen ? (
          <button type="button" className="live-node-open" onClick={onOpen} aria-label={fmt(l.open, { name: title })}>
            {title}
          </button>
        ) : (
          title
        )}
      </h3>

      {mediaType !== "text" && (state === "arrived" || state === "working" || state === "queued") ? (
        <div className="live-node-media" data-loaded={media && mediaLoaded ? "true" : undefined}>
          {state === "arrived" && media ? (
            // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived media URL; next/image would proxy it.
            <img
              src={media.src}
              alt={media.alt ?? fmt(l.resultAlt, { name: title })}
              onLoad={() => setMediaLoaded(true)}
              ref={(el) => {
                // A cached picture can finish before React attaches onLoad.
                if (el?.complete && el.naturalWidth > 0) setMediaLoaded(true);
              }}
            />
          ) : null}
        </div>
      ) : null}

      {prompt ? (
        <div className="live-node-prompt">
          <span className="live-node-meta ds-t-label">
            {l.prompt} · {l.written}
          </span>
          <RevealText text={prompt} reveal={revealPrompt} instant={instant} className="live-node-prompt-text ds-mono" />
        </div>
      ) : null}

      <div className="live-node-status" data-tone={state}>
        {working ? (
          <TextShimmer active className="live-node-word">
            {statusWord}
          </TextShimmer>
        ) : (
          <span className="live-node-word">{statusWord}</span>
        )}
        {working && elapsed != null ? (
          <span className="live-node-time ds-mono">
            <span className="ds-sr-only">{fmt(l.elapsed, { time: formatElapsed(elapsed) })}</span>
            <span aria-hidden>{formatElapsed(elapsed)}</span>
          </span>
        ) : null}
        {model ? (
          <span className="live-node-model ds-mono">
            <span className="ds-sr-only">{l.model}: </span>
            {model}
          </span>
        ) : null}
      </div>

      {(working || state === "queued") && typeof queuePosition === "number" && queuePosition > 0 ? (
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

      {state === "failed" && failure ? (
        <dl className="live-node-fail ds-t-caption">
          <dt>{l.failed.cause}</dt>
          <dd>{failure.cause}</dd>
          <dt>{l.failed.remedy}</dt>
          <dd>{failure.remedy}</dd>
        </dl>
      ) : null}
      {state === "failed" && retry ? (
        <Button
          variant="secondary"
          className="live-node-key"
          disabled={retry.price == null}
          loading={retry.busy === true}
          busyLabel={l.failed.retrying}
          onClick={retry.price == null ? undefined : retry.onRetry}
        >
          {retry.price == null
            ? l.failed.retryUnpriced
            : fmt(l.failed.retry, { n: formatCredits(retry.price, locale), unit: creditUnit(retry.price, locale, t.shell.creditUnit) })}
        </Button>
      ) : null}

      {state === "disabled" && reason ? <p className="live-node-note ds-t-caption">{reason}</p> : null}

      {state === "insufficient" && shortfall ? (
        <div className="live-node-short">
          {typeof shortfall.credits === "number" && shortfall.credits > 0 ? (
            <p className="ds-t-caption">
              {fmt(l.insufficient.shortfall, {
                n: formatCredits(shortfall.credits, locale),
                unit: creditUnit(shortfall.credits, locale, t.shell.creditUnit),
              })}
            </p>
          ) : null}
          <a className={buttonClass({ variant: "secondary", className: "live-node-key" })} href={shortfall.topUpHref}>
            {l.insufficient.topUp}
          </a>
        </div>
      ) : null}

      {/* Present from the first render, so a screen reader hears the arrival: a live region inserted with its words in it
          is often not announced. It speaks only for an arrival watched on this screen. */}
      <span className="ds-sr-only" role="status">
        {state === "arrived" && landed ? fmt(l.ready, { kind: kindLabel }) : ""}
      </span>

      {children}
    </article>
  );
}
