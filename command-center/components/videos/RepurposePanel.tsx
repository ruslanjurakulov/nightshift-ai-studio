"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Dictionary } from "@/lib/i18n";
import { fmt } from "@/lib/i18n";
import { isExtraOffRefusal } from "@/lib/credits";
import {
  canPress,
  clockText,
  encodeClips,
  failureText,
  MAX_CLIPS,
  newIdempotencyKey,
  parseQuote,
  pickedOverlap,
  reasonText,
  repurposeErrorText,
  requestText,
  scoreText,
  type ClipProposal,
  type Proposals,
  type RepurposeQuote,
  type RequestRow,
} from "@/lib/repurpose";

/**
 * "Repurpose into clips" on a video's page (migration 0080, lib/repurpose).
 *
 * Two steps, and only the second spends:
 *  1. the person ticks up to five of the proposed clips; the page then asks the
 *     server for the price (the database computes it from the video's own scene
 *     record; nothing is held);
 *  2. the confirm button SHOWS that price — "Make the clips · N credits" — and
 *     pressing it sends exactly that price as the most the person agreed to,
 *     with one idempotency key for this selection. A changed price comes back
 *     as price_changed with the new number, and nothing is held.
 *
 * The proposals say whether retention was measured; with none, they say so and
 * show "Retention not measured" per clip — never a number. The clips are made
 * by the queue worker from the full-quality master, charged only for the clips
 * that exist, and each one is a private, held video of its own.
 */
export function RepurposePanel({
  videoId,
  proposals,
  queue,
  requests,
  hrefs,
  labels,
  extraOffNote,
}: {
  videoId: string;
  proposals: Proposals;
  /** Clips are made on the queue backend only (the worker holds the master). */
  queue: boolean;
  /** This video's requests, newest first. */
  requests: RequestRow[];
  /** clip video id → its page. */
  hrefs: Record<string, string>;
  labels: Dictionary["repurpose"];
  /** Said after a "not enough credits" refusal that came from the extra-credits switch (0094). */
  extraOffNote?: string;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<number[]>([]); // proposal ranks
  const [quote, setQuote] = useState<RepurposeQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quoteFailed, setQuoteFailed] = useState(false);
  // One key per intended press: a press that never reached the server is
  // retried with the same key; anything that changes the request gets a new one.
  const keyRef = useRef<string | null>(null);
  // Latest request wins: a slower answer for an earlier selection must never
  // put its price on the button.
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const latest = requests[0] ?? null;
  const inProgress = latest?.status === "queued" || latest?.status === "running";
  const base = `/api/videos/${encodeURIComponent(videoId)}/repurpose`;

  const chosen: ClipProposal[] = useMemo(
    () => proposals.clips.filter((c) => picked.includes(c.rank)).sort((a, b) => a.startS - b.startS),
    [proposals.clips, picked],
  );
  const overlap = pickedOverlap(chosen);
  const refs = useMemo(() => chosen.map((c) => ({ first: c.first, last: c.last })), [chosen]);
  const refsKey = encodeClips(refs);

  const loadQuote = useCallback(
    async (key: string) => {
      const seq = ++seqRef.current;
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setQuote(null);
      setQuoteFailed(false);
      try {
        const res = await fetch(`${base}?clips=${encodeURIComponent(key)}`, { cache: "no-store", signal: ctrl.signal });
        const body = (await res.json().catch(() => null)) as { quote?: unknown } | null;
        if (seq !== seqRef.current) return;
        if (!res.ok || !body) setQuoteFailed(true);
        else setQuote(parseQuote(body.quote));
      } catch {
        if (seq !== seqRef.current) return;
        setQuoteFailed(true);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [base],
  );

  useEffect(() => {
    if (refsKey && !overlap && !inProgress) {
      void loadQuote(refsKey);
    } else {
      seqRef.current += 1;
      abortRef.current?.abort();
      setQuote(null);
      setLoading(false);
      setQuoteFailed(false);
    }
  }, [refsKey, overlap, inProgress, loadQuote]);
  useEffect(() => () => abortRef.current?.abort(), []);

  function toggle(rank: number) {
    setError(null);
    keyRef.current = newIdempotencyKey();
    setPicked((cur) => (cur.includes(rank) ? cur.filter((r) => r !== rank) : cur.length >= MAX_CLIPS ? cur : [...cur, rank]));
  }

  async function press() {
    if (!quote || !canPress(quote) || busy || loading || overlap) return;
    if (!keyRef.current) keyRef.current = newIdempotencyKey();
    setBusy(true);
    setError(null);
    let reached = false;
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clips: refs,
          max_credits: quote.status === "priced" ? quote.credits : null,
          idempotency_key: keyRef.current,
        }),
      });
      reached = true;
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        setError(isExtraOffRefusal(body) && extraOffNote ? `${repurposeErrorText(body, labels)} ${extraOffNote}` : repurposeErrorText(body, labels));
        // A refusal held nothing; the next press is a new one.
        keyRef.current = newIdempotencyKey();
        if (body?.error === "price_changed") void loadQuote(refsKey);
        return;
      }
      setPicked([]);
      router.refresh();
    } catch {
      // The press may not have arrived: keep the key, so pressing again is
      // the same press and can never hold twice.
      if (!reached) setError(labels.errors.failed);
    } finally {
      setBusy(false);
    }
  }

  const priceLabel =
    quote?.status === "priced" && quote.credits !== null
      ? fmt(labels.priceButton, { credits: String(quote.credits) })
      : labels.includedButton;

  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="m-0 text-[12px] leading-relaxed text-[var(--color-muted)]">{labels.lead}</p>

      {latest && (
        <p
          className={`m-0 text-[12px] leading-relaxed ${
            latest.status === "failed" || latest.status === "partial"
              ? "text-[var(--color-warn)]"
              : latest.status === "succeeded"
                ? "text-[var(--color-ok)]"
                : "text-[var(--color-muted)]"
          }`}
          role="status"
        >
          {requestText(latest, labels)}
        </p>
      )}

      {proposals.clips.length === 0 ? (
        <p className="m-0 text-[12px] text-[var(--color-muted)]">{labels.noProposals}</p>
      ) : (
        <>
          <p className="m-0 text-[11px] text-[var(--color-muted)]">
            {proposals.retention === "measured" ? labels.retentionMeasured : labels.retentionNotMeasured}
          </p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {proposals.clips.map((c) => {
              const on = picked.includes(c.rank);
              const full = !on && picked.length >= MAX_CLIPS;
              return (
                <li key={c.rank}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-[var(--ns-r-chip)] border border-[var(--color-border)] p-2 text-[12px]">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={busy || inProgress || full}
                      onChange={() => toggle(c.rank)}
                      aria-label={fmt(labels.rank, { rank: String(c.rank) })}
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-semibold text-[var(--color-fg)]">
                        {fmt(labels.rank, { rank: String(c.rank) })} ·{" "}
                        {fmt(labels.range, { from: clockText(c.startS), to: clockText(c.endS) })} ·{" "}
                        {fmt(labels.seconds, { s: String(Math.round(c.durationS)) })}
                      </span>
                      <span className="mono text-[10px] text-[var(--color-muted)]">
                        {fmt(labels.scenes, { first: c.first, last: c.last })}
                      </span>
                      <span className="text-[11px] text-[var(--color-muted)]">{scoreText(c, labels)}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          {!inProgress && (
            <div className="flex flex-col gap-2 rounded-[var(--ns-r-panel)] border border-[var(--color-border)] p-3">
              <p className="m-0 text-[11px] text-[var(--color-muted)]">
                {picked.length === 0 ? labels.pickHint : fmt(labels.selected, { n: String(picked.length) })}
              </p>
              {overlap && (
                <p className="m-0 text-[11px] leading-relaxed text-[var(--color-warn)]" role="alert">
                  {labels.overlap}
                </p>
              )}
              {loading && <p className="m-0 text-[11px] text-[var(--color-muted)]">{labels.loading}</p>}
              {!loading && quoteFailed && (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="m-0 text-[11px] text-[var(--color-warn)]">{labels.quoteFailed}</p>
                  <button type="button" className="btn-quiet px-2 text-[11px]" onClick={() => void loadQuote(refsKey)}>
                    {labels.retry}
                  </button>
                </div>
              )}
              {!loading && quote && quote.status === "unavailable" && (
                <p className="m-0 text-[11px] leading-relaxed text-[var(--color-warn)]">{reasonText(quote.reason, labels)}</p>
              )}
              {!loading && quote && quote.status === "unpriced" && (
                <p className="m-0 text-[11px] leading-relaxed text-[var(--color-warn)]">{labels.unpriced}</p>
              )}
              {!loading && quote && quote.status !== "unavailable" && quote.status !== "unpriced" && !quote.mayStart && (
                <p className="m-0 text-[11px] leading-relaxed text-[var(--color-muted)]">{labels.noPermission}</p>
              )}
              {!loading && quote && canPress(quote) && !queue && (
                <p className="m-0 text-[11px] leading-relaxed text-[var(--color-muted)]">{labels.errors.queueRequired}</p>
              )}
              {!loading && quote && canPress(quote) && queue && (
                <p className="m-0 text-[11px] leading-relaxed text-[var(--color-muted)]">
                  {quote.clipCredits !== null ? `${fmt(labels.perClip, { credits: String(quote.clipCredits) })} · ` : ""}
                  {labels.hint}
                </p>
              )}
              {error && (
                <p className="m-0 text-[11px] text-[var(--color-fail)]" role="alert">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy || loading || overlap || !quote || !canPress(quote) || !queue}
                  onClick={press}
                  className="btn-sky is-solid pill px-3 py-1 text-[11px] disabled:opacity-40"
                >
                  {busy ? labels.pressing : priceLabel}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {requests.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">{labels.requestsTitle}</div>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {requests.slice(0, 3).map((r) => (
              <li key={r.id} className="flex flex-col gap-1 rounded-[var(--ns-r-chip)] border border-[var(--color-border)] p-2 text-[11px]">
                <span className="text-[var(--color-muted)]">{requestText(r, labels)}</span>
                {r.clips.map((c) => (
                  <span key={c.ordinal} className="flex flex-wrap items-center gap-2">
                    <span className="mono text-[10px] text-[var(--color-muted)]">
                      {fmt(labels.range, { from: clockText(c.startS), to: clockText(c.endS) })}
                    </span>
                    <span className={c.status === "failed" ? "text-[var(--color-warn)]" : "text-[var(--color-fg)]"}>
                      {c.status === "rendered" ? labels.clipMade : c.status === "failed" ? labels.clipFailed : labels.clipQueued}
                    </span>
                    {c.status === "failed" && <span className="text-[var(--color-muted)]">{failureText(c.errorCode, labels)}</span>}
                    {c.status === "rendered" && c.clipVideoId && hrefs[c.clipVideoId] && (
                      <Link href={hrefs[c.clipVideoId]} className="tap-link mono text-[11px] text-[var(--color-primary)] hover:underline">
                        {labels.openClip}
                      </Link>
                    )}
                    {c.status === "rendered" && c.captions && (
                      <span className="text-[10px] text-[var(--color-muted)]">{labels.captionsReady}</span>
                    )}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
