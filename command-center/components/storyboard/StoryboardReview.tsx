"use client";

import Link from "next/link";
import { useId, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { StatusPill } from "@/components/ui";
import {
  minutesLabel,
  storyboardErrorText,
  type StoryboardQuote,
  type StoryboardStatus,
  type StoryboardView,
} from "@/lib/storyboardReview";

const STATUS_TONE: Record<StoryboardStatus, "ok" | "run" | "warn" | "idle"> = {
  ready: "warn",
  approved: "run",
  rendered: "ok",
  discarded: "idle",
  unknown: "idle",
};

/**
 * One waiting run's storyboard (migration 0057): the scene cards, and ONE
 * price for the render in a footer that stays in reach while the cards
 * scroll. "Approve & render · N credits" is the only control here that
 * spends, and it sends the price it shows; "Discard" spends nothing. Both
 * re-check everything on the server — this screen only asks.
 *
 * Read-only cards in this slice: editing, deleting and reordering scenes are
 * a follow-up (the server already keeps the stored cards bounded and frozen
 * once approved).
 */
export function StoryboardReview({
  storyboard,
  quote,
  canRun,
  backHref,
  bottomBar = true,
}: {
  storyboard: StoryboardView;
  quote: StoryboardQuote;
  /** May this person start runs on the channel (the Run now rule)? Presentation only. */
  canRun: boolean;
  backHref: string;
  /** Customers have a phone tab bar the footer sits above. */
  bottomBar?: boolean;
}) {
  const { t } = useI18n();
  const ts = t.storyboardReview;
  const router = useRouter();
  const [status, setStatus] = useState<StoryboardStatus>(storyboard.status);
  const [price, setPrice] = useState<StoryboardQuote>(quote);
  const [busy, setBusy] = useState<"approve" | "discard" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const noteId = useId();

  const scenes = storyboard.scenes;
  const total = fmt(ts.total, { n: scenes.length, m: minutesLabel(storyboard.durationS) });
  const statusLabel =
    status === "ready"
      ? ts.statusReady
      : status === "approved"
        ? ts.statusApproved
        : status === "rendered"
          ? ts.statusRendered
          : status === "discarded"
            ? ts.statusDiscarded
            : ts.statusUnknown;
  const waiting = status === "ready";
  const priced = price.kind === "paid" || price.kind === "included";
  const canApprove = waiting && canRun && priced && busy === null && scenes.length > 0;

  async function post(action: "approve" | "discard"): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
    const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" } };
    if (action === "approve") init.body = JSON.stringify(price.kind === "paid" ? { max_credits: price.credits } : {});
    else init.body = "{}";
    try {
      const res = await fetch(`/api/storyboards/${storyboard.id}/${action}`, init);
      let body: Record<string, unknown> | null = null;
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      return { ok: res.ok, body };
    } catch {
      return { ok: false, body: null };
    }
  }

  async function approve() {
    if (!canApprove) return;
    setBusy("approve");
    setError(null);
    const { ok, body } = await post("approve");
    setBusy(null);
    if (ok) {
      setStatus("approved");
      setNotice(ts.approvedNote);
      router.refresh();
      return;
    }
    // A new price is shown, never pressed for the person: the next press
    // carries it, and only if they press again.
    if (body?.error === "price_changed" && typeof body.credits === "number") setPrice({ kind: "paid", credits: body.credits });
    if (body?.error === "storyboard_not_ready") router.refresh();
    setError(storyboardErrorText(body, ts));
  }

  async function discard() {
    if (!waiting || !canRun || busy) return;
    setBusy("discard");
    setError(null);
    const { ok, body } = await post("discard");
    setBusy(null);
    setConfirming(false);
    if (ok) {
      setStatus("discarded");
      setNotice(ts.discardedNote);
      router.refresh();
      return;
    }
    if (body?.error === "storyboard_not_ready") router.refresh();
    setError(storyboardErrorText(body, ts));
    discardRef.current?.focus();
  }

  const dock = { "--sb-dock-offset": bottomBar ? "64px" : "0px" } as CSSProperties;
  const approveLabel =
    busy === "approve"
      ? ts.approving
      : price.kind === "paid"
        ? fmt(ts.approve, { credits: price.credits })
        : ts.approveIncluded;

  return (
    <div className="flex flex-col gap-4" style={dock} data-testid="storyboard-review">
      <div>
        <Link href={backHref} className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-fg)]">
          ← {ts.back}
        </Link>
      </div>

      <header className="panel flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <StatusPill tone={STATUS_TONE[status]} label={statusLabel} />
          <span className="text-[12px] text-[var(--color-muted)]">{total}</span>
        </div>
        <h2 className="m-0 text-[17px] font-semibold leading-snug text-[var(--color-fg)] [overflow-wrap:anywhere]">
          {storyboard.title ?? storyboard.topic}
        </h2>
        {storyboard.title && storyboard.topic && (
          <p className="m-0 text-[13px] text-[var(--color-muted)] [overflow-wrap:anywhere]">{storyboard.topic}</p>
        )}
        {waiting && <p className="m-0 text-[12px] text-[var(--color-muted)]">{ts.planNote}</p>}
      </header>

      <p role="status" aria-live="polite" className="m-0 text-[13px] text-[var(--color-ok)] empty:hidden">
        {notice ?? (status === "approved" ? ts.approvedNote : status === "rendered" ? ts.renderedNote : status === "discarded" ? ts.discardedNote : "")}
      </p>

      {scenes.length === 0 ? (
        <p className="panel m-0 p-4 text-[13px] text-[var(--color-muted)]">{ts.noScenes}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label={ts.title}>
          {scenes.map((s) => (
            <li key={s.n} className="panel flex flex-col gap-2 p-4" data-testid="storyboard-scene">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="m-0 text-[13px] font-semibold text-[var(--color-fg)]">{fmt(ts.scene, { n: s.n })}</h3>
                <span className="mono text-[11px] text-[var(--color-muted)]">
                  <span className="sr-only">{ts.length}: </span>
                  {fmt(ts.seconds, { n: s.durationS })}
                </span>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">{ts.narration}</div>
                <p className="m-0 mt-1 whitespace-pre-line text-[14px] leading-relaxed text-[var(--color-fg)] [overflow-wrap:anywhere]">
                  {s.narration}
                </p>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">{ts.visual}</div>
                <p className="m-0 mt-1 text-[13px] leading-relaxed text-[var(--color-muted)] [overflow-wrap:anywhere]">
                  {s.visual || ts.noVisual}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}

      {waiting && (
        <div className="sb-dock flex flex-col gap-2" data-testid="storyboard-dock">
          {error && (
            <p role="alert" className="m-0 text-[13px] text-[var(--color-fail)]">
              {error}
            </p>
          )}
          <p id={noteId} className="m-0 text-[12px] leading-relaxed text-[var(--color-muted)]">
            {!canRun
              ? ts.notAllowed
              : price.kind === "paid"
                ? ts.priceNote
                : price.kind === "included"
                  ? ts.includedNote
                  : ts.noPrice}{" "}
            {canRun && priced ? ts.publishNote : ""}
          </p>
          {confirming ? (
            <div className="flex flex-col gap-2" role="group" aria-label={ts.discardConfirm}>
              <p className="m-0 text-[13px] text-[var(--color-fg)]">{ts.discardConfirm}</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  ref={keepRef}
                  type="button"
                  className="btn-quiet"
                  onClick={() => {
                    setConfirming(false);
                    requestAnimationFrame(() => discardRef.current?.focus());
                  }}
                  disabled={busy !== null}
                >
                  {ts.discardNo}
                </button>
                <button
                  type="button"
                  className="btn-quiet"
                  style={{ borderColor: "var(--color-fail)", color: "var(--color-fail)" }}
                  onClick={discard}
                  disabled={busy !== null}
                >
                  {busy === "discard" ? ts.discarding : ts.discardYes}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-[auto_1fr] items-stretch gap-2">
              <button
                ref={discardRef}
                type="button"
                className="btn-quiet"
                onClick={() => {
                  setConfirming(true);
                  setError(null);
                  requestAnimationFrame(() => keepRef.current?.focus());
                }}
                disabled={!canRun || busy !== null}
              >
                {ts.discard}
              </button>
              <button
                type="button"
                className="studio-cta"
                onClick={approve}
                disabled={!canApprove}
                aria-describedby={noteId}
                aria-busy={busy === "approve"}
              >
                {approveLabel}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
