"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Mic, Square, RotateCcw, Trash2, Plus, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatMediaBytes } from "@/lib/media";
import type { EditorAsset } from "@/lib/editor";
import { useVoiceRecorder } from "@/components/voice/useVoiceRecorder";
import {
  VOICEOVER_BITS_PER_SECOND,
  VOICEOVER_MAX_SECONDS,
  VOICEOVER_MIN_SECONDS,
  VOICEOVER_TOLERANCE_SECONDS,
  takeName,
  uploadVoiceOver,
  voiceTakeType,
  type VoiceOverResult,
} from "@/lib/editor-voiceover";

/** 44 px tall at every width (WCAG 2.5.5): these are pressed mid-take, often on a phone. */
const btn = "btn-quiet inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 px-3 text-sm";
const primary = "btn-primary inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 px-4 text-sm";
const note = "m-0 text-xs text-[var(--color-muted)]";

/** 0 -> "0:00", 75 -> "1:15", 600 -> "10:00". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Outcomes after which the take is the server's (sent, or registered): it is not offered for another upload. */
const SENT = new Set<string>(["still_checking", "not_audio", "full"]);

type Phase =
  | { at: "record" }
  | { at: "uploading" }
  | { at: "checking" }
  | { at: "added"; name: string; position: number }
  | { at: "error"; result: Extract<VoiceOverResult, { ok: false }> };

export interface VoiceOverRecorderProps {
  orgId: string;
  /** Whether the project has room for another sound now (lib/editor.ts canAddSound). */
  canAdd: boolean;
  /** Where the take would start, read when "Add to timeline" is pressed (the playhead, as Add sound uses it). */
  position: () => number;
  /** Put the registered take on the timeline at `position`. False = there was no room (it stays in the library). */
  onAdd: (asset: EditorAsset, position: number) => boolean;
  onClose: () => void;
  /** Tests: the upload, without the network. */
  upload?: typeof uploadVoiceOver;
}

/**
 * "Record voice-over": the microphone is asked for only when Record is pressed (never on opening the panel), the take
 * can be heard, re-taken or thrown away, and "Add to timeline" sends it through the media library's ordinary upload and
 * places it once the server has registered it (lib/editor-voiceover.ts). Leaving the page, closing the panel or
 * hiding the page mid-take stops the recorder and releases the microphone. Hidden (another tab, a minimised window,
 * a locked phone) STOPS the take and keeps it to hear and add; left (pagehide, unmount) throws it away.
 */
export function VoiceOverRecorder({ orgId, canAdd, position, onAdd, onClose, upload = uploadVoiceOver }: VoiceOverRecorderProps) {
  const { t } = useI18n();
  const tv = t.editor.voiceOver;
  const tm = t.media;
  const ids = useId();
  const rec = useVoiceRecorder({
    minSeconds: VOICEOVER_MIN_SECONDS,
    maxSeconds: VOICEOVER_MAX_SECONDS,
    toleranceSeconds: VOICEOVER_TOLERANCE_SECONDS,
    typeFor: voiceTakeType,
    meter: true,
    audioBitsPerSecond: VOICEOVER_BITS_PER_SECOND,
  });
  const [phase, setPhase] = useState<Phase>({ at: "record" });
  const aborter = useRef<AbortController | null>(null);
  const cancelRef = useRef(rec.cancel);
  cancelRef.current = rec.cancel;
  const stopRef = useRef(rec.stop);
  stopRef.current = rec.stop;
  const onAddRef = useRef(onAdd);
  onAddRef.current = onAdd;

  // A page that is being left (or put in the back/forward cache) stops recording at once; unmounting does too (the
  // hook's own clean-up). The wait for the server ends with the page; the upload, once sent, is the server's.
  useEffect(() => {
    const leave = () => cancelRef.current();
    // A hidden page is not a recording anyone is watching: the take so far is kept and the microphone released.
    // stop() does nothing unless a take is running.
    const hidden = () => {
      if (document.visibilityState === "hidden") stopRef.current();
    };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hidden);
      aborter.current?.abort();
    };
  }, []);

  const busy = phase.at === "uploading" || phase.at === "checking";
  const max = clock(VOICEOVER_MAX_SECONDS);

  async function add() {
    const take = rec.take;
    if (!take || busy) return;
    const at = position();
    const ctrl = new AbortController();
    aborter.current = ctrl;
    setPhase({ at: "uploading" });
    const out = await upload({
      orgId,
      blob: take.blob,
      type: take.type,
      name: takeName(new Date(), take.ext),
      signal: ctrl.signal,
      // The PUT has finished once the first status read is asked for: say so.
      sleep: (ms) => {
        if (!ctrl.signal.aborted) setPhase((p) => (p.at === "uploading" ? { at: "checking" } : p));
        return new Promise((r) => setTimeout(r, ms));
      },
    });
    if (ctrl.signal.aborted) return;
    if (!out.ok) {
      // Sent already (or registered): the take must not be offered again, or a second press would upload it twice.
      if (SENT.has(out.error)) rec.reset();
      setPhase({ at: "error", result: out });
      return;
    }
    if (!onAddRef.current(out.asset, at)) {
      rec.reset();
      setPhase({ at: "error", result: { ok: false, error: "full" } });
      return;
    }
    // The take is now the library's: the local copy is let go (and its object URL revoked) by the hook.
    rec.reset();
    setPhase({ at: "added", name: out.asset.name ?? "", position: at });
  }

  function errorText(r: Extract<VoiceOverResult, { ok: false }>): { head: string; detail: string | null } {
    const e = r.error;
    if (e === "full") return { head: tv.full, detail: null };
    if (e === "too_large") {
      const limit = formatMediaBytes(r.maxBytes ?? null) || "—";
      return { head: fmt(tv.tooLarge, { max: limit }), detail: null };
    }
    if (e === "rejected") {
      const reasons = tm.reasons as Record<string, string>;
      return { head: tv.rejected, detail: r.reason ? (reasons[r.reason] ?? reasons.other) : reasons.other };
    }
    if (e === "expired") return { head: tv.expired, detail: null };
    if (e === "still_checking") return { head: tv.stillChecking, detail: null };
    if (e === "not_audio") return { head: tv.notAudio, detail: null };
    const errors = tm.errors as Record<string, string>;
    return { head: tv.uploadFailed, detail: errors[e] ? fmt(errors[e], { max: formatMediaBytes(r.maxBytes ?? null) || "—" }) : errors.failed };
  }

  // What the live region says: one sentence per change of state, never the ticking clock.
  let status = "";
  let alert: { head: string; detail: string | null } | null = null;
  if (phase.at === "uploading") status = tv.uploading;
  else if (phase.at === "checking") status = tv.checking;
  else if (phase.at === "added") status = fmt(tv.added, { at: clock(phase.position), name: phase.name });
  else if (phase.at === "error") alert = errorText(phase.result);
  else if (rec.state === "requesting") status = tv.requesting;
  else if (rec.state === "recording") status = tv.recording;
  else if (rec.state === "recorded" && rec.take)
    status = `${fmt(tv.recorded, { length: clock(rec.take.seconds) })}${rec.hitMax ? ` ${fmt(tv.hitMax, { max })}` : ""}`;
  else if (rec.state === "unsupported") alert = { head: tv.unsupported, detail: null };
  else if (rec.state === "blockedBySite") alert = { head: tv.blockedBySite, detail: null };
  else if (rec.state === "denied") alert = { head: tv.denied, detail: null };
  else if (rec.state === "noDevice") alert = { head: tv.noDevice, detail: null };
  else if (rec.state === "failed") alert = { head: tv.failed, detail: null };
  else if (rec.state === "tooShort")
    alert = { head: fmt(tv.tooShort, { length: clock(rec.shortBy ?? 0), min: clock(VOICEOVER_MIN_SECONDS) }), detail: null };
  else if (rec.state === "tooLong") alert = { head: fmt(tv.tooLong, { max }), detail: null };

  const startOver = () => {
    setPhase({ at: "record" });
    void rec.start();
  };

  return (
    <section aria-labelledby={`${ids}-title`} className="panel flex flex-col gap-3 p-4 sm:p-5" data-testid="voiceover">
      <div className="flex items-center justify-between gap-2">
        <h3 id={`${ids}-title`} className="m-0 text-sm font-semibold">
          {tv.title}
        </h3>
        <button type="button" onClick={onClose} className={btn} aria-label={tv.close}>
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <p className={note}>{fmt(tv.hint, { max })}</p>

      {rec.state === "recording" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <span className="inline-block size-2.5 shrink-0 rounded-full bg-[var(--color-danger,#d33)]" aria-hidden />
            <span className="font-mono text-sm tabular-nums" data-testid="voiceover-elapsed">
              {fmt(tv.elapsed, { now: clock(rec.seconds), max })}
            </span>
          </div>
          {rec.level !== null ? (
            <div
              role="meter"
              aria-label={tv.level}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(rec.level * 100)}
              className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-border)]"
            >
              <div className="h-full bg-[var(--color-primary)] transition-[width] duration-100" style={{ width: `${Math.round(rec.level * 100)}%` }} />
            </div>
          ) : null}
        </div>
      ) : null}

      {rec.state === "recorded" && rec.take && phase.at !== "added" ? (
        <audio
          controls
          src={rec.take.url}
          aria-label={tv.preview}
          className="w-full"
          preload="metadata"
          // Space and the arrows belong to the player while it has focus, not to the timeline's shortcuts (on window).
          onKeyDown={(e) => {
            if (e.key === " " || e.key.startsWith("Arrow")) e.stopPropagation();
          }}
        />
      ) : null}

      {/* Announced politely as the state changes; an error is an alert. */}
      <p role="status" aria-live="polite" className="m-0 text-sm" data-testid="voiceover-status">
        {status}
      </p>
      {alert ? (
        <div role="alert" className="flex flex-col gap-1 text-sm text-[var(--color-warn)]" data-testid="voiceover-error">
          <p className="m-0">{alert.head}</p>
          {alert.detail ? <p className="m-0 text-xs">{alert.detail}</p> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {rec.state === "recording" ? (
          <>
            <button type="button" onClick={rec.stop} className={primary}>
              <Square className="size-4" aria-hidden />
              {tv.stop}
            </button>
            <button type="button" onClick={rec.cancel} className={btn}>
              {tv.cancel}
            </button>
          </>
        ) : rec.state === "requesting" ? (
          <button type="button" onClick={rec.cancel} className={btn}>
            {tv.cancel}
          </button>
        ) : rec.state === "recorded" && rec.take && phase.at !== "added" ? (
          <>
            <button
              type="button"
              onClick={() => void add()}
              disabled={busy || !canAdd}
              aria-describedby={canAdd ? `${ids}-at` : `${ids}-full`}
              className={primary}
            >
              <Plus className="size-4" aria-hidden />
              {tv.add}
            </button>
            <button type="button" onClick={startOver} disabled={busy} className={btn}>
              <RotateCcw className="size-4" aria-hidden />
              {tv.retake}
            </button>
            <button
              type="button"
              onClick={() => {
                setPhase({ at: "record" });
                rec.reset();
              }}
              disabled={busy}
              className={btn}
            >
              <Trash2 className="size-4" aria-hidden />
              {tv.discard}
            </button>
          </>
        ) : rec.state === "unsupported" ? null : rec.state === "blockedBySite" ? (
          <button type="button" onClick={() => window.location.reload()} className={btn}>
            {tv.reload}
          </button>
        ) : (
          <button type="button" onClick={startOver} className={primary}>
            <Mic className="size-4" aria-hidden />
            {rec.state === "idle" ? tv.record : rec.state === "tooShort" || rec.state === "tooLong" ? tv.recordAgain : tv.tryAgain}
          </button>
        )}
      </div>
      {rec.state === "recorded" && rec.take && phase.at !== "added" ? (
        canAdd ? (
          <p id={`${ids}-at`} className={note}>
            {fmt(tv.addAt, { at: clock(position()) })}
          </p>
        ) : (
          <p id={`${ids}-full`} className={note}>
            {tv.full}
          </p>
        )
      ) : null}
    </section>
  );
}
