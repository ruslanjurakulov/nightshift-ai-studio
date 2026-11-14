"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { refreshCredits } from "@/lib/credits-live";
import { filmErrorFromResponse, newIdempotencyKey, type FilmError } from "@/lib/films";
import { assembleLabel, coerceQuote, coerceStart, startOnce, type FilmQuote, type StartOutcome } from "@/lib/studio/timeline";

type Phase =
  | { at: "idle" }
  | { at: "quoting" }
  | { at: "quoted"; quote: FilmQuote }
  | { at: "unpriced"; error?: FilmError }
  | { at: "confirm"; quote: FilmQuote }
  | { at: "starting"; quote: FilmQuote }
  | { at: "started"; replayed: boolean }
  | { at: "refused"; reason: Extract<StartOutcome, { ok: false }>["reason"] }
  | { at: "failed" };

/**
 * "Assemble the film": 0171's quote → the person confirms the server's number → start_film holds it (the worker captures on success
 * and refunds on failure). The browser never prices: until quote_film answered, the key carries no number (rule 5), and it only calls
 * the two routes and stops (rule 3). One idempotency key per confirmed quote, so a double press starts once.
 */
export function AssemblePanel({
  filmId,
  orgId,
  version,
  editable,
  status,
  compact = false,
  onStarted,
}: {
  filmId: string;
  /** The project's workspace: its credits balance is re-read once a start held credits. */
  orgId: string;
  version: number;
  editable: boolean;
  status: string;
  /** The phone's bottom bar: one key, the note above it only when there is something to say. */
  compact?: boolean;
  onStarted: () => void;
}) {
  const { t, fmt } = useI18n();
  const c = t.studioTimeline;
  const path = useChannelPath();
  const [phase, setPhase] = useState<Phase>({ at: "idle" });
  const [problem, setProblem] = useState<"quoteFailed" | "notEditableNow" | null>(null);

  // A new version of the project is a new price: whatever was quoted is forgotten.
  useEffect(() => {
    setPhase({ at: "idle" });
    setProblem(null);
  }, [version]);

  const quoteRef = useRef<FilmQuote | null>(null);
  const starter = useMemo(
    () =>
      startOnce(async (idem: string) => {
        const q = quoteRef.current;
        if (!q?.quoteId) return { ok: false as const, reason: "other" as const };
        let res: Response;
        try {
          res = await fetch(`/api/films/${encodeURIComponent(filmId)}/start`, {
            method: "POST",
            cache: "no-store",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ quote_id: q.quoteId, idem }),
          });
        } catch {
          throw new Error("network");
        }
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok) throw new Error(filmErrorFromResponse(res.status, json).error);
        return coerceStart((json as { start?: unknown } | null)?.start);
      }, newIdempotencyKey),
    [filmId],
  );

  async function quote() {
    setProblem(null);
    setPhase({ at: "quoting" });
    try {
      const res = await fetch(`/api/films/${encodeURIComponent(filmId)}/quote`, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const e = filmErrorFromResponse(res.status, json).error;
        // Only a missing quote_film (0171 not applied) means pricing is not live; any other refusal is a failed read, said as one.
        if (e === "not_available") setPhase({ at: "unpriced", error: e });
        else {
          setProblem(e === "film_not_editable" ? "notEditableNow" : "quoteFailed");
          setPhase({ at: "idle" });
        }
        return;
      }
      const q = coerceQuote((json as { quote?: unknown } | null)?.quote);
      if (!q) {
        setProblem("quoteFailed");
        setPhase({ at: "idle" });
        return;
      }
      quoteRef.current = q;
      starter.reset();
      setPhase(q.priced ? { at: "quoted", quote: q } : { at: "unpriced" });
    } catch {
      setProblem("quoteFailed");
      setPhase({ at: "idle" });
    }
  }

  async function start(q: FilmQuote) {
    if (starter.busy) return;
    setPhase({ at: "starting", quote: q });
    try {
      const out = await starter.run();
      if (out.ok) {
        starter.reset();
        setPhase({ at: "started", replayed: out.replayed });
        void refreshCredits(orgId);
        onStarted();
      } else {
        setPhase({ at: "refused", reason: out.reason });
      }
    } catch {
      // The key is kept: pressing again retries the same start, never a second one.
      setPhase({ at: "failed" });
    }
  }

  const q = phase.at === "quoted" || phase.at === "confirm" || phase.at === "starting" ? phase.quote : null;
  const label = assembleLabel(q);
  const blocked = q?.blockedBy ?? [];
  const canStart = Boolean(q && q.startable);
  const insufficient = blocked.includes("insufficient_credits") || (phase.at === "refused" && phase.reason === "insufficient_credits");

  const press = () => {
    if (phase.at === "quoted" && canStart) setPhase({ at: "confirm", quote: phase.quote });
    else if (phase.at === "confirm") void start(phase.quote);
    else if (phase.at === "failed" && quoteRef.current) void start(quoteRef.current);
    else if (phase.at !== "quoting" && phase.at !== "starting" && phase.at !== "quoted") void quote();
  };

  const disabled =
    !editable ||
    phase.at === "quoting" ||
    phase.at === "starting" ||
    phase.at === "started" ||
    (phase.at === "quoted" && !canStart);

  let note: React.ReactNode = null;
  if (!editable) note = fmt(c.notEditable, { status });
  else if (problem === "notEditableNow") note = fmt(c.notEditable, { status });
  else if (problem) note = c[problem];
  else if (phase.at === "unpriced") note = <><b>{c.noPrice}</b> {c.noPriceBody}</>;
  else if (phase.at === "quoted" && blocked.length) note = blocked.map((b) => c.blocked[b]).join(" ");
  else if (phase.at === "quoted" && !q?.mayStart) note = c.notAdmin;
  // The phone's bar has no room for the standing explanation: it shows a note only when something needs the person.
  else if ((phase.at === "quoted" || phase.at === "confirm") && !compact) note = c.priceNote;
  else if (phase.at === "started") note = phase.replayed ? c.replayed : c.started;
  else if (phase.at === "refused") note = c.startFailed[phase.reason];
  else if (phase.at === "failed") note = c.startFailed.other;

  const right =
    phase.at === "quoting" ? c.quoting : phase.at === "starting" ? c.starting : label.kind === "credits" ? fmt(compact ? c.creditsShort : c.credits, { n: label.total }) : c.getPrice;

  return (
    <div className={compact ? "tl-assemble is-compact" : "tl-assemble"} data-testid="assemble">
      <button type="button" className="tl-price" onClick={press} disabled={disabled} aria-busy={phase.at === "quoting" || phase.at === "starting"} data-testid="assemble-key">
        <span>{compact ? c.assembleShort : c.assemble}</span>
        <span data-testid="assemble-amount">{right}</span>
      </button>
      {note && (
        <p className="tl-note" role="status" data-testid="assemble-note">
          {note}
          {insufficient && (
            <>
              {" "}
              <Link href={path("/billing")} data-testid="assemble-add-credits">
                {c.addCredits}
              </Link>
            </>
          )}
        </p>
      )}
      {phase.at === "confirm" && (
        <div className="tl-confirm" role="dialog" aria-modal="true" aria-labelledby="tl-confirm-h" data-testid="assemble-confirm">
          <div className="tl-confirm-card">
            <h2 id="tl-confirm-h">{c.confirmTitle}</h2>
            <p>{fmt(c.confirmBody, { n: phase.quote.total ?? 0 })}</p>
            <div className="tl-confirm-keys">
              <button type="button" className="cv-kbtn" onClick={() => setPhase({ at: "quoted", quote: phase.quote })}>
                {c.cancel}
              </button>
              <button type="button" className="cv-kbtn is-primary" onClick={() => void start(phase.quote)} data-testid="assemble-confirm-key">
                {fmt(c.confirm, { n: phase.quote.total ?? 0 })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
