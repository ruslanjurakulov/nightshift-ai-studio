"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatClock } from "@/lib/editorExportStatus";
import type { EditorError } from "@/lib/editor";
import {
  HIRES_MAX_S,
  quoteBlocker,
  type HiresPresetId,
  type HiresQuote,
} from "@/lib/hiresExport/limits";
import { fetchHiresQuote, type EditorResult } from "./editorApi";

/** What the editor needs to know to let Export spend: every paid size quoted, nothing blocking, and the person said yes. */
export type HiresConfirmation = {
  ready: boolean;
  /** What the yes was given for: `${rev}|${frames}`. */
  key: string;
  /** The confirmed number per paid size: what the route sends as `maxCredits`. */
  maxCredits: Partial<Record<HiresPresetId, number>>;
};

type Loaded = { state: "loading" } | { state: "ok"; quote: HiresQuote } | { state: "error"; error: EditorError };

const credits = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * The price of the paid sizes the person ticked (1440p, 4K: migration 0132, NIGHTSHIFT_HIRES_EXPORT), BEFORE anything
 * is spent. Every number is the server's quote (GET .../exports/quote, quote_editor_export) for the SAVED revision:
 * nothing here prices. Export stays disabled until each ticked size is quoted, none is refused (not on sale, too long,
 * too fast for 4K, not this member's to spend, not enough credits), and the person ticks the confirmation, whose number
 * is what the route sends and the database refuses to exceed (price_changed). A change of the sizes, the revision or
 * the quote takes the confirmation back.
 *
 * States: saving first (the quote is for the saved version), loading, a quote, each refusal with its sentence, a read
 * that failed with "Get the price again". The sentences sit in a polite live region.
 */
export function HiresExportQuote({
  projectId,
  rev,
  dirty,
  frames,
  onChange,
  load = fetchHiresQuote,
}: {
  projectId: string;
  rev: number;
  /** Unsaved changes: the price would be for the version on the server, so it is not asked. */
  dirty: boolean;
  /** The paid sizes that are ticked, in the picker's order. */
  frames: readonly HiresPresetId[];
  onChange: (c: HiresConfirmation) => void;
  /** The quote call (tests pass their own). */
  load?: (id: string, rev: number, frame: HiresPresetId) => Promise<EditorResult<HiresQuote>>;
}) {
  const { t } = useI18n();
  const hx = t.editor.exportHires;
  const id = useId();
  const key = `${rev}|${frames.join(",")}`;
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [agreed, setAgreed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (dirty || frames.length === 0) return;
    let live = true;
    setLoaded(Object.fromEntries(frames.map((f) => [f, { state: "loading" } as Loaded])));
    for (const f of frames) {
      void load(projectId, rev, f).then((r) => {
        if (!live) return;
        setLoaded((prev) => ({ ...prev, [f]: r.ok ? { state: "ok", quote: r.value } : { state: "error", error: r.error } }));
      });
    }
    return () => {
      live = false;
    };
    // `key` carries rev and frames; `attempt` asks again after a failed read.
  }, [key, dirty, attempt, projectId, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const quotes = frames.map((f) => loaded[f]);
  const all = quotes.every((q): q is { state: "ok"; quote: HiresQuote } => q?.state === "ok");
  const total = all ? quotes.reduce((s, q) => s + (q.quote.exempt ? 0 : (q.quote.credits ?? 0)), 0) : null;
  const blocked = all && quotes.some((q) => quoteBlocker(q.quote) !== null);
  // The confirmation is for THIS set of quotes: anything that changes them takes it back.
  const signature = all ? `${key}|${quotes.map((q) => `${q.quote.frame}:${q.quote.credits}`).join(",")}` : null;
  const ready = !dirty && all && !blocked && signature !== null && agreed === signature;

  const maxCredits = useMemo(() => {
    const out: Partial<Record<HiresPresetId, number>> = {};
    // The database compares its price with this number in the exempt organization too (it holds nothing there).
    if (all) for (const q of quotes) out[q.quote.frame] = q.quote.credits ?? 0;
    return out;
    // `signature` changes exactly when the numbers do.
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onChange({ ready, key, maxCredits: ready ? maxCredits : {} });
  }, [ready, key, maxCredits]); // eslint-disable-line react-hooks/exhaustive-deps

  if (frames.length === 0) return null;
  const name = (f: HiresPresetId) => hx.names[f];

  const lines: { key: string; text: string; tone: "plain" | "warn" }[] = [];
  if (dirty) lines.push({ key: "save", text: hx.saveFirst, tone: "warn" });
  else
    for (const f of frames) {
      const l = loaded[f];
      if (!l || l.state === "loading") {
        lines.push({ key: f, text: fmt(hx.loading, { name: name(f) }), tone: "plain" });
        continue;
      }
      if (l.state === "error") {
        lines.push({ key: f, text: `${fmt(hx.failed, { name: name(f) })} ${t.editor.errors[l.error]}`, tone: "warn" });
        continue;
      }
      const q = l.quote;
      const why = quoteBlocker(q);
      if (why === "not_on_sale") lines.push({ key: f, text: fmt(hx.notOnSale, { name: name(f) }), tone: "warn" });
      else if (why === "hires_too_long")
        lines.push({
          key: f,
          text: fmt(hx.tooLong, { name: name(f), max: formatClock(q.maxS), length: formatClock(q.durationS) }),
          tone: "warn",
        });
      else if (why === "hires_fps")
        lines.push({ key: f, text: fmt(hx.tooFast, { name: name(f), max: q.maxFps, fps: q.fps ?? "?" }), tone: "warn" });
      else if (why === "forbidden") lines.push({ key: f, text: fmt(hx.notAllowed, { name: name(f) }), tone: "warn" });
      else if (why === "insufficient_credits")
        lines.push({
          key: f,
          text: fmt(hx.short, { name: name(f), credits: credits(q.credits ?? 0), available: credits(q.available ?? 0) }),
          tone: "warn",
        });
      else if (q.exempt) lines.push({ key: f, text: fmt(hx.exemptLine, { name: name(f) }), tone: "plain" });
      else
        lines.push({
          key: f,
          text: fmt(hx.line, {
            name: name(f),
            minutes: q.minutes,
            perMinute: credits(q.creditsPerMinute ?? 0),
            credits: credits(q.credits ?? 0),
          }),
          tone: "plain",
        });
    }
  const firstOk = quotes.find((q): q is { state: "ok"; quote: HiresQuote } => q?.state === "ok");
  const failed = !dirty && quotes.some((q) => q?.state === "error");

  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-sm" data-hires-quote="">
      <p className="m-0 text-xs text-[var(--color-muted)]">
        {fmt(hx.intro, { max1440: formatClock(HIRES_MAX_S["1440p"]), max2160: formatClock(HIRES_MAX_S["2160p"]) })}
      </p>
      <div aria-live="polite" className="flex flex-col gap-1">
        {lines.map((l) => (
          <p
            key={l.key}
            className={`m-0 break-words ${l.tone === "warn" ? "text-xs text-[var(--color-warn)]" : ""}`}
          >
            {l.text}
          </p>
        ))}
        {all && !blocked && firstOk && !firstOk.quote.exempt && firstOk.quote.available !== null ? (
          <p className="m-0 text-xs text-[var(--color-muted)]">
            {fmt(hx.available, { available: credits(firstOk.quote.available) })}
          </p>
        ) : null}
      </div>
      {failed ? (
        <button type="button" className="btn-quiet min-h-11 self-start text-sm" onClick={() => setAttempt((n) => n + 1)}>
          {hx.retry}
        </button>
      ) : null}
      {all && !blocked && signature !== null && total !== null ? (
        <>
          {total > 0 ? (
            <p id={`${id}-total`} className="m-0 text-xs text-[var(--color-muted)]">
              {fmt(hx.total, { credits: credits(total) })}
            </p>
          ) : null}
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={agreed === signature}
              onChange={(e) => setAgreed(e.target.checked ? signature : null)}
              aria-describedby={total > 0 ? `${id}-total` : undefined}
            />
            <span>{fmt(hx.confirm, { credits: credits(total) })}</span>
          </label>
        </>
      ) : null}
    </div>
  );
}
