"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Dictionary } from "@/lib/i18n";
import { fmt } from "@/lib/i18n";
import {
  canPress,
  MAX_PROMPT,
  newIdempotencyKey,
  parseQuote,
  reasonText,
  regenErrorText,
  rowText,
  type RegenQuote,
  type RegenRow,
  type RegenSource,
} from "@/lib/sceneRegenerate";

/**
 * One scene's "Regenerate scene" (migration 0076, lib/sceneRegenerate).
 *
 * Two steps, and only the second spends:
 *  1. "Regenerate scene" opens the panel and asks the server for the price
 *     (the database computes it; nothing is held);
 *  2. the confirm button SHOWS that price — "Regenerate · N credits" — and
 *     pressing it sends exactly that price as the most the person agreed to,
 *     with one idempotency key for this press. A changed price comes back as
 *     price_changed with the new number, and nothing is held.
 *
 * The source is the scene's own (the same generator, or stock). Stock for a
 * generated scene is a separate, explicit tick — never a fallback. The
 * latest regeneration of this scene is shown with its status; a failed one
 * says nothing was charged and the scene is unchanged; a finished one says the
 * previous take is kept and the new cut waits for review.
 */
export function RegenerateSceneButton({
  videoId,
  sceneId,
  latest,
  labels,
}: {
  videoId: string;
  sceneId: string;
  /** The newest regeneration of this scene, if any. */
  latest: RegenRow | null;
  labels: Dictionary["sceneRegen"];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<RegenSource>("same");
  const [prompt, setPrompt] = useState("");
  const [quote, setQuote] = useState<RegenQuote | null>(null);
  const [queue, setQueue] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quoteFailed, setQuoteFailed] = useState(false);
  // One key per intended press: a press that never reached the server is
  // retried with the same key; anything that changes the request gets a new one.
  const keyRef = useRef<string | null>(null);
  // Latest request wins (BR-L-029): a slower answer for the other source
  // must never put its price on the button.
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const inProgress = latest?.status === "queued" || latest?.status === "running";
  const base = `/api/videos/${encodeURIComponent(videoId)}/scenes/${encodeURIComponent(sceneId)}/regenerate`;

  const loadQuote = useCallback(
    async (src: RegenSource) => {
      const seq = ++seqRef.current;
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setQuote(null);
      setQuoteFailed(false);
      try {
        const res = await fetch(`${base}?source=${src}`, { cache: "no-store", signal: ctrl.signal });
        const body = (await res.json().catch(() => null)) as { quote?: unknown; queue?: boolean } | null;
        if (seq !== seqRef.current) return;
        if (!res.ok || !body) {
          setQuoteFailed(true);
        } else {
          setQuote(parseQuote(body.quote));
          setQueue(body.queue !== false);
        }
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
    if (open) void loadQuote(source);
  }, [open, source, loadQuote]);

  // A closed panel, or a gone component, takes no late answer.
  useEffect(() => {
    if (!open) {
      seqRef.current += 1;
      abortRef.current?.abort();
    }
  }, [open]);
  useEffect(() => () => abortRef.current?.abort(), []);

  function freshKey() {
    keyRef.current = newIdempotencyKey();
  }

  function openPanel() {
    setOpen(true);
    setError(null);
    setSource("same");
    setPrompt("");
    freshKey();
  }

  async function press() {
    if (!quote || !canPress(quote) || busy || loading) return;
    if (!keyRef.current) freshKey();
    setBusy(true);
    setError(null);
    let reached = false;
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_credits: quote.status === "priced" ? quote.credits : null,
          idempotency_key: keyRef.current,
          source,
          prompt: prompt.trim() || null,
        }),
      });
      reached = true;
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        setError(regenErrorText(body, labels));
        // A refusal held nothing; the next press is a new one.
        freshKey();
        if (body?.error === "price_changed") void loadQuote(source);
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      // The press may not have arrived: keep the key, so pressing again is
      // the same press and can never hold twice.
      if (!reached) setError(labels.errors.failed);
    } finally {
      setBusy(false);
    }
  }

  const stockOffered = !!quote && (quote.hadGenerated || source === "stock");
  const priceLabel =
    quote?.status === "priced" && quote.credits !== null
      ? fmt(labels.priceButton, { credits: String(quote.credits) })
      : labels.includedButton;

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {latest && (
        <p
          className={`m-0 text-[11px] leading-relaxed ${
            latest.status === "failed"
              ? "text-[var(--color-warn)]"
              : latest.status === "succeeded"
                ? "text-[var(--color-ok)]"
                : "text-[var(--color-muted)]"
          }`}
          role="status"
        >
          {rowText(latest, labels)}
        </p>
      )}
      {!open && !inProgress && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={openPanel} className="btn-sky is-quiet pill px-3 py-1 text-[11px]">
            {labels.action}
          </button>
          <span className="mono text-[10px] text-[var(--color-muted)]">{sceneId}</span>
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-2 rounded-[var(--ns-r-panel)] border border-[var(--color-border)] p-3">
          {loading && <p className="m-0 text-[11px] text-[var(--color-muted)]">{labels.loading}</p>}
          {!loading && quoteFailed && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="m-0 text-[11px] text-[var(--color-warn)]">{labels.quoteFailed}</p>
              <button type="button" className="btn-quiet px-2 text-[11px]" onClick={() => void loadQuote(source)}>
                {labels.retry}
              </button>
            </div>
          )}
          {!loading && quote && (
            <>
              {quote.status !== "unavailable" && (
                <p className="m-0 text-[11px] text-[var(--color-muted)]">
                  {source === "stock" || quote.sourceKind === "stock" ? labels.sameStock : labels.sameGenerated}
                </p>
              )}
              {stockOffered && (
                <label className="flex items-start gap-2 text-[11px] text-[var(--color-fg)]">
                  <input
                    type="checkbox"
                    checked={source === "stock"}
                    disabled={busy || loading}
                    onChange={(e) => {
                      setSource(e.target.checked ? "stock" : "same");
                      setError(null);
                      freshKey();
                    }}
                  />
                  <span>{labels.stockChoice}</span>
                </label>
              )}
              {quote.status === "unavailable" && (
                <p className="m-0 text-[11px] leading-relaxed text-[var(--color-warn)]">{reasonText(quote.reason, labels)}</p>
              )}
              {quote.status === "unpriced" && (
                <p className="m-0 text-[11px] leading-relaxed text-[var(--color-warn)]">{labels.unpriced}</p>
              )}
              {quote.status !== "unavailable" && quote.status !== "unpriced" && !quote.mayStart && (
                <p className="m-0 text-[11px] leading-relaxed text-[var(--color-muted)]">{labels.noPermission}</p>
              )}
              {canPress(quote) && !queue && (
                <p className="m-0 text-[11px] leading-relaxed text-[var(--color-muted)]">{labels.errors.queueRequired}</p>
              )}
              {canPress(quote) && queue && (
                <>
                  <label className="flex flex-col gap-1 text-[11px] text-[var(--color-muted)]">
                    <span>{labels.promptLabel}</span>
                    <textarea
                      value={prompt}
                      maxLength={MAX_PROMPT}
                      rows={2}
                      disabled={busy}
                      onChange={(e) => {
                        setPrompt(e.target.value);
                        freshKey();
                      }}
                      className="w-full rounded-[var(--ns-r-chip)] border border-[var(--color-border)] bg-[var(--color-panel)] p-2 text-[12px] text-[var(--color-fg)]"
                    />
                    <span>{labels.promptHint}</span>
                  </label>
                  <p className="m-0 text-[11px] leading-relaxed text-[var(--color-muted)]">{labels.hint}</p>
                </>
              )}
            </>
          )}
          {error && (
            <p className="m-0 text-[11px] text-[var(--color-fail)]" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {quote && canPress(quote) && queue && !loading && (
              <button
                type="button"
                disabled={busy || loading}
                onClick={press}
                className="btn-sky is-solid pill px-3 py-1 text-[11px] disabled:opacity-40"
              >
                {busy ? labels.pressing : priceLabel}
              </button>
            )}
            <button type="button" className="btn-quiet px-2 text-[11px]" disabled={busy} onClick={() => setOpen(false)}>
              {labels.close}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
