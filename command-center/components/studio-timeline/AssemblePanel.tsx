"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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

  const assembleKey = useRef<HTMLButtonElement>(null);
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

  // The version on screen, and which quote request is the current one: an answer for an older version or an older press is
  // dropped, so the price the person confirms is always the price of what they see (Breach BR-803-01).
  const versionRef = useRef(version);
  const quoteSeq = useRef(0);

  // A new version of the project is a new price: whatever was quoted is forgotten. Not while a confirmed start is waiting for
  // its answer: the panel stays "starting" with that start's key, so a second start can never be sent under a new key while
  // the first may still go through (Breach BR-803-02).
  useEffect(() => {
    versionRef.current = version;
    quoteSeq.current += 1;
    if (starter.busy) return;
    setPhase({ at: "idle" });
    setProblem(null);
  }, [version, starter]);

  async function quote() {
    if (starter.busy) return;
    const seq = ++quoteSeq.current;
    const asked = version;
    const stale = () => seq !== quoteSeq.current || asked !== versionRef.current;
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
      if (stale()) return;
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
      if (starter.busy) return;
      quoteRef.current = q;
      starter.reset();
      setPhase(q.priced ? { at: "quoted", quote: q } : { at: "unpriced" });
    } catch {
      if (stale()) return;
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
        forgetQuote();
        setPhase({ at: "refused", reason: out.reason });
      }
    } catch (e) {
      if (e instanceof Error && e.message === "network") {
        // No answer: the start may have gone through, so the key and the quote are kept and pressing again replays the same
        // start (0171 answers the first segment), never a second one.
        setPhase({ at: "failed" });
      } else {
        // The server answered with a refusal: that quote is spent (BR-790-02), the next press asks for a new price.
        forgetQuote();
        setPhase({ at: "refused", reason: "other" });
      }
    }
  }

  /** After a refusal the old quote and its key are never sent again: the next press re-quotes. */
  function forgetQuote() {
    starter.reset();
    quoteRef.current = null;
  }

  const q = phase.at === "quoted" || phase.at === "confirm" || phase.at === "starting" ? phase.quote : null;
  const label = assembleLabel(q);
  const blocked = q?.blockedBy ?? [];
  const canStart = Boolean(q && q.startable);
  const insufficient = blocked.includes("insufficient_credits") || (phase.at === "refused" && phase.reason === "insufficient_credits");

  // The background key never starts anything: it asks for a price, then opens the confirmation. Only the dialog's own Confirm
  // calls start (Lens H2: Enter held on this key once ran quote → confirm → start with no confirmation).
  const press = () => {
    if (phase.at === "quoted" && canStart) setPhase({ at: "confirm", quote: phase.quote });
    else if (phase.at === "failed" && quoteRef.current) setPhase({ at: "confirm", quote: quoteRef.current });
    else if (phase.at !== "quoting" && phase.at !== "starting" && phase.at !== "quoted" && phase.at !== "confirm") void quote();
  };
  const noRepeat = (e: ReactKeyboardEvent) => {
    if (e.repeat) e.preventDefault();
  };

  const disabled =
    !editable ||
    phase.at === "quoting" ||
    phase.at === "starting" ||
    phase.at === "started" ||
    phase.at === "confirm" ||
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
      <button type="button" className="tl-price" ref={assembleKey} onClick={press} onKeyDown={noRepeat} disabled={disabled} aria-busy={phase.at === "quoting" || phase.at === "starting"} data-testid="assemble-key">
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
        <ConfirmDialog
          returnFocus={assembleKey.current}
          title={c.confirmTitle}
          body={fmt(c.confirmBody, { n: String(phase.quote.total) })}
          cancel={c.cancel}
          confirm={fmt(c.confirm, { n: String(phase.quote.total) })}
          onCancel={() => setPhase({ at: "quoted", quote: phase.quote })}
          onConfirm={() => void start(phase.quote)}
        />
      )}
    </div>
  );
}

/**
 * The one place a start is confirmed. Focus moves into it (on Cancel, so a held Enter cannot confirm), Tab stays inside, Escape
 * cancels, and a repeated key press is ignored: holding a key down never confirms a hold of credits.
 */
function ConfirmDialog({ returnFocus, title, body, cancel, confirm, onCancel, onConfirm }: { returnFocus: HTMLButtonElement | null; title: string; body: string; cancel: string; confirm: string; onCancel: () => void; onConfirm: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = returnFocus;
    first.current?.focus();
    return () => back?.focus?.();
  }, [returnFocus]);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.repeat) {
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const keys = [...(box.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    if (keys.length === 0) return;
    const i = keys.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.shiftKey ? (i <= 0 ? keys.length - 1 : i - 1) : i === keys.length - 1 ? 0 : i + 1;
    e.preventDefault();
    keys[next].focus();
  };
  return (
    <div className="tl-confirm" role="dialog" aria-modal="true" aria-labelledby="tl-confirm-h" data-testid="assemble-confirm" onKeyDown={onKey} ref={box}>
      <div className="tl-confirm-card">
        <h2 id="tl-confirm-h">{title}</h2>
        <p>{body}</p>
        <div className="tl-confirm-keys">
          <button type="button" className="cv-kbtn" onClick={onCancel} ref={first} data-testid="assemble-confirm-cancel">
            {cancel}
          </button>
          <button type="button" className="cv-kbtn is-primary" onClick={onConfirm} data-testid="assemble-confirm-key">
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
