"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Captions as CaptionsIcon, Download, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { formatTime, type EditorAsset, type EditorModel } from "@/lib/editor";
import {
  CAPTION_LANGUAGES,
  CAPTION_PRESETS,
  DEFAULT_PRESET,
  buildSrt,
  buildVtt,
  captionFileName,
  captionParams,
  captionsFromTrack,
  captionsOf,
  coerceCaptionJobs,
  coerceTrack,
  coerceTrackSummary,
  cueWarnings,
  defaultCaptionLanguage,
  playedClips,
  presetMatching,
  recordingProblem,
  removeCue,
  setCaptionStyle,
  setCaptions,
  styleFor,
  updateCue,
  type CaptionJob,
  type CaptionLanguage,
  type CaptionPresetId,
  type CaptionTrack,
  type CaptionTrackSummary,
} from "@/lib/captions";
import {
  apiErrorMessage,
  asCreativeError,
  errorAction,
  newIdempotencyKey,
  isActiveStatus,
  type QuoteState,
} from "@/lib/creative/studio";

const QUOTE_DELAY_MS = 400;
const POLL_MS = 3000;
/** The cue list shows this many at a time: a half-hour talk has hundreds. */
const CUES_SHOWN = 40;

const fieldClass =
  "pill w-full border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-[16px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]";
const quietBtn =
  "btn-sky is-quiet pill inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px]";

/** One transcription model a member may be sold (sellable_models, 0035). */
export interface CaptionModelOption {
  id: string;
  displayName: string;
  /** The spoken languages it was proven and priced for (spec.languages). */
  languages: string[];
}

interface Recording {
  id: string;
  name: string | null;
  durationS: number | null;
  kind: "video" | "audio" | "image";
  /** Some clip of the timeline plays this recording's sound. */
  heard: boolean;
}

/** The recordings the timeline uses: videos (heard only when a clip's sound is on) and sounds. */
export function recordingsOf(model: EditorModel, assets: Record<string, EditorAsset>): Recording[] {
  const ids: string[] = [];
  for (const c of model.clips) if (!ids.includes(c.asset_id)) ids.push(c.asset_id);
  for (const s of model.sounds) if (!ids.includes(s.asset_id)) ids.push(s.asset_id);
  const out: Recording[] = [];
  for (const id of ids) {
    const a = assets[id];
    if (a && a.kind === "image") continue;
    out.push({
      id,
      name: a?.name ?? null,
      durationS: a?.durationS ?? null,
      kind: a?.kind ?? "video",
      heard: playedClips(model, id).length > 0,
    });
  }
  return out;
}

function CueRow({
  n,
  text,
  start,
  end,
  warning,
  onText,
  onTimes,
  onDelete,
}: {
  n: number;
  text: string;
  start: number;
  end: number;
  warning: "empty" | "too_long" | null;
  onText: (v: string) => void;
  onTimes: (s: number, e: number) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const tc = t.captions;
  // Typed numbers are committed on blur or Enter: a half-typed "1." must not
  // be clamped into the neighbouring cue while the person is still typing.
  // The words too: one undo step per edited caption, not one per keystroke.
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const [s, setS] = useState(String(start));
  const [e, setE] = useState(String(end));
  useEffect(() => setS(String(start)), [start]);
  useEffect(() => setE(String(end)), [end]);
  const commit = () => {
    const ns = Number(s);
    const ne = Number(e);
    if (Number.isFinite(ns) && Number.isFinite(ne)) onTimes(ns, ne);
    else {
      setS(String(start));
      setE(String(end));
    }
  };
  const key = (ev: React.KeyboardEvent) => {
    if (ev.key === "Enter") commit();
  };
  return (
    <li className="flex flex-col gap-1.5 border-t border-[var(--color-border)] pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-2">
        <textarea
          value={draft}
          rows={2}
          maxLength={500}
          aria-label={tc.cueText.replace("{n}", String(n))}
          onChange={(ev) => setDraft(ev.target.value)}
          onBlur={() => {
            if (draft !== text) onText(draft);
          }}
          onKeyDown={(ev) => {
            // Ctrl/Cmd+S here would save the model WITHOUT the words typed so
            // far: commit them first and let the next press save.
            if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
              ev.preventDefault();
              ev.stopPropagation();
              if (draft !== text) onText(draft);
            }
          }}
          className={`${fieldClass} min-w-0 flex-1 resize-y`}
        />
        <button type="button" onClick={onDelete} aria-label={tc.deleteCue} className={quietBtn}>
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-[var(--color-muted)]">
          {tc.cueStart}
          <input
            inputMode="decimal"
            value={s}
            onChange={(ev) => setS(ev.target.value)}
            onBlur={commit}
            onKeyDown={key}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--color-muted)]">
          {tc.cueEnd}
          <input
            inputMode="decimal"
            value={e}
            onChange={(ev) => setE(ev.target.value)}
            onBlur={commit}
            onKeyDown={key}
            className={fieldClass}
          />
        </label>
      </div>
      {warning === "empty" ? (
        <p role="alert" className="m-0 text-[12px] text-[var(--color-fail)]">
          {tc.cueEmpty}
        </p>
      ) : null}
    </li>
  );
}

function download(name: string, mime: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Auto-captions in the editor (migration 0072).
 *
 *   1. pick a recording of the timeline and the language spoken in it;
 *   2. the database prices the transcript (/api/creative/quote); the price is
 *      on the button and pressing it — and nothing else — makes a job, with
 *      that price as `max_credits` and one idempotency key per press;
 *   3. the finished transcript (words with times) is read back; a transcript
 *      already made is free to use again;
 *   4. cues are made from it IN THE BROWSER (language- and look-aware), laid
 *      on the timeline through the clips' own trims and speeds, and are then
 *      ordinary editor data: edit, restyle, delete — all free, all saved only
 *      when the project is;
 *   5. SRT / WebVTT files download from the same cues.
 *
 * Nothing here publishes, re-renders or spends by itself.
 */
export function CaptionsPanel({
  orgId,
  projectTitle,
  model,
  assets,
  models,
  pictureEnd,
  onChange,
}: {
  orgId: string;
  projectTitle: string;
  model: EditorModel;
  assets: Record<string, EditorAsset>;
  models: readonly CaptionModelOption[];
  pictureEnd: number;
  onChange: (next: EditorModel) => void;
}) {
  const { t, fmt, locale } = useI18n();
  const tc = t.captions;
  const path = useChannelPath();

  const recordings = useMemo(() => recordingsOf(model, assets), [model, assets]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const picked = recordings.find((r) => r.id === sourceId) ?? recordings.find((r) => recordingProblem(r) === null) ?? recordings[0] ?? null;
  const [language, setLanguage] = useState<CaptionLanguage | "detect">(() => defaultCaptionLanguage(locale));
  const [modelId, setModelId] = useState<string>(models[0]?.id ?? "");
  const [preset, setPreset] = useState<CaptionPresetId>(
    () => presetMatching(captionsOf(model)?.style, model.width, model.height) ?? DEFAULT_PRESET,
  );
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const [requote, setRequote] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<CaptionJob | null>(null);
  // Captions being made in this organization for recordings that are not in this project:
  // found here too, so a started job is never a job nobody can see or stop.
  const [others, setOthers] = useState<CaptionJob[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [tracks, setTracks] = useState<CaptionTrackSummary[] | null>(null);
  const [tracksError, setTracksError] = useState(false);
  const [track, setTrack] = useState<CaptionTrack | null>(null);
  const [loadingTrack, setLoadingTrack] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [shown, setShown] = useState(CUES_SHOWN);

  const chosen = models.find((m) => m.id === modelId) ?? models[0] ?? null;
  // A language the picked model was not proven for is not offered: back to "detect it".
  const spoken: CaptionLanguage | null = language !== "detect" && chosen?.languages.includes(language) ? language : null;
  const problem = picked ? recordingProblem(picked) : "unknown";
  const canQuote = Boolean(picked && chosen && problem === null && orgId);
  const paramsKey = picked ? JSON.stringify(captionParams(picked.id, spoken)) : "";

  // ── the price (asked of the database; nothing is held) ──────────────────────
  useEffect(() => {
    if (!canQuote || !chosen || !paramsKey) {
      setQuote({ status: "idle" });
      return;
    }
    setQuote({ status: "quoting" });
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/creative/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ org_id: orgId, capability: "captions", model: chosen.id, params: JSON.parse(paramsKey) }),
          signal: ctrl.signal,
        });
        const body = (await res.json().catch(() => ({}))) as { quote?: { credits?: unknown }; error?: unknown };
        const credits = body.quote?.credits;
        if (res.ok && typeof credits === "number" && Number.isFinite(credits)) setQuote({ status: "ready", credits });
        else setQuote({ status: "error", code: asCreativeError(body.error) });
      } catch {
        if (!ctrl.signal.aborted) setQuote({ status: "error", code: "failed" });
      }
    }, QUOTE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [canQuote, chosen, paramsKey, orgId, requote]);

  // ── transcripts already made for this recording (free to read) ───────────────
  const loadTracks = useCallback(async (assetId: string, signal?: AbortSignal) => {
    try {
      const res = await fetch(`/api/captions/tracks?asset_id=${encodeURIComponent(assetId)}`, { signal, cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { tracks?: unknown };
      if (!res.ok) {
        setTracksError(true);
        setTracks([]);
        return;
      }
      setTracksError(false);
      setTracks((Array.isArray(body.tracks) ? body.tracks : []).flatMap((r) => coerceTrackSummary(r) ?? []));
    } catch {
      if (!signal?.aborted) {
        setTracksError(true);
        setTracks([]);
      }
    }
  }, []);

  const pickedId = picked?.id ?? null;
  useEffect(() => {
    // Without an organization (or a model to be sold) the feature is not on here: stay silent.
    if (!pickedId || !orgId) return;
    setTracks(null);
    setTrack(null);
    const ctrl = new AbortController();
    void loadTracks(pickedId, ctrl.signal);
    return () => ctrl.abort();
  }, [pickedId, orgId, loadTracks]);

  async function pickTrack(id: string) {
    setLoadingTrack(id);
    setNotice(null);
    try {
      const res = await fetch(`/api/captions/tracks/${encodeURIComponent(id)}`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { track?: unknown };
      const next = res.ok ? coerceTrack(body.track) : null;
      if (next) setTrack(next);
      else setNotice(tc.transcriptFailed);
    } catch {
      setNotice(tc.transcriptFailed);
    } finally {
      setLoadingTrack(null);
    }
  }

  async function removeTrack(id: string) {
    if (!window.confirm(tc.removeConfirm)) return;
    const res = await fetch(`/api/captions/tracks/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) {
      setTracks((l) => (l ? l.filter((x) => x.id !== id) : l));
      setTrack((cur) => (cur?.id === id ? null : cur));
      setNotice(tc.transcriptRemoved);
    } else {
      setNotice(tc.transcriptFailed);
    }
  }

  // ── a job on its way: found again after a refresh, polled until it ends ──────
  const ids = useRef(new Set<string>());
  ids.current = new Set(recordings.map((r) => r.id));
  useEffect(() => {
    if (!orgId) return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/api/creative/jobs?org_id=${encodeURIComponent(orgId)}`, { signal: ctrl.signal, cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { jobs?: unknown };
        if (!res.ok) return;
        const active = coerceCaptionJobs(body.jobs).filter((j) => isActiveStatus(j.status));
        const mine = active.find((j) => j.sourceAssetId !== null && ids.current.has(j.sourceAssetId));
        if (mine) {
          setJob(mine);
          if (mine.sourceAssetId) setSourceId(mine.sourceAssetId);
        }
        setOthers(active.filter((j) => j !== mine && !(j.sourceAssetId !== null && ids.current.has(j.sourceAssetId))));
      } catch {
        /* the panel works without it: a refresh just does not find a running job */
      }
    })();
    return () => ctrl.abort();
  }, [orgId]);

  const jobId = job?.id ?? null;
  const jobActive = job ? isActiveStatus(job.status) : false;
  useEffect(() => {
    if (!jobId || !jobActive) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/creative/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { job?: unknown };
        if (stopped || !res.ok) return;
        const next = coerceCaptionJobs([body.job])[0];
        if (!next) return;
        setJob(next);
        if (!isActiveStatus(next.status)) {
          if (next.status === "completed" && next.trackId) {
            if (next.sourceAssetId) await loadTracks(next.sourceAssetId);
            await pickTrack(next.trackId);
          }
        }
      } catch {
        /* the next tick asks again */
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // pickTrack and loadTracks only set state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, jobActive]);

  // ── cancelling a job the provider has not started: the database releases the hold ──
  async function cancel(id: string) {
    if (cancelling) return;
    setCancelling(id);
    setNotice(null);
    try {
      const res = await fetch(`/api/creative/jobs/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      const body = (await res.json().catch(() => ({}))) as { job?: unknown; error?: unknown };
      const ended = res.ok ? coerceCaptionJobs([body.job])[0] : undefined;
      if (ended) {
        setJob((cur) => (cur?.id === id ? ended : cur));
        setOthers((l) => l.filter((j) => j.id !== id));
        setNotice(tc.cancelled);
      } else if (body.error === "not_cancellable") {
        setNotice(tc.notCancellable);
      } else {
        setErrorCode(asCreativeError(body.error));
      }
    } catch {
      setErrorCode("failed");
    } finally {
      setCancelling(null);
    }
  }

  // ── the priced press: the only thing here that spends ────────────────────────
  async function start() {
    if (quote.status !== "ready" || submitting || !chosen || !picked || problem !== null) return;
    setSubmitting(true);
    setErrorCode(null);
    setNotice(null);
    try {
      const res = await fetch("/api/creative/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org_id: orgId,
          capability: "captions",
          model: chosen.id,
          params: captionParams(picked.id, spoken),
          idempotency_key: newIdempotencyKey(),
          max_credits: quote.credits,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { job?: unknown; error?: unknown };
      const made = res.ok ? coerceCaptionJobs([body.job])[0] : undefined;
      if (made) setJob(made);
      else {
        const code = asCreativeError(body.error);
        setErrorCode(code);
        if (code === "price_changed") setRequote((n) => n + 1);
      }
    } catch {
      setErrorCode("failed");
    } finally {
      setSubmitting(false);
    }
  }

  // ── the captions on the timeline (free) ───────────────────────────────────────
  const current = captionsOf(model);
  const cues = current?.cues ?? [];
  const warnings = cueWarnings(cues);
  const activeTrack = track;

  function put() {
    if (!activeTrack || !picked) return;
    const made = captionsFromTrack(model, activeTrack, picked.id, preset, pictureEnd);
    if (!made) {
      setNotice(tc.nothingHeard);
      return;
    }
    setArmed(false);
    setShown(CUES_SHOWN);
    onChange(setCaptions(model, made));
    setNotice(fmt(tc.added, { n: made.cues.length }));
  }

  function choosePreset(id: CaptionPresetId) {
    setPreset(id);
    // An existing set of captions only changes its look: the person's edits to the words stay.
    if (current) onChange(setCaptionStyle(model, styleFor(id, model.width, model.height)));
  }

  const downloadLanguage = activeTrack?.language ?? spoken ?? "und";
  const fileTitle = projectTitle.trim() || tc.defaultFile;
  const burnedLook = presetMatching(current?.style, model.width, model.height);

  const status = job
    ? isActiveStatus(job.status)
      ? "working"
      : job.status === "completed"
        ? "ready"
        : "failed"
    : null;
  const failReason = job && status === "failed" ? t.gen.reasons[(job.errorCode === "no_speech" ? "no_speech" : "generic")] : null;
  const priceLabel =
    quote.status === "quoting"
      ? tc.quoting
      : quote.status === "ready"
        ? fmt(tc.makePriced, { n: String(quote.credits) })
        : tc.make;
  const quoteErrorCode = errorCode ?? (quote.status === "error" ? quote.code : null);
  const action = quoteErrorCode ? errorAction(quoteErrorCode) : null;

  return (
    <section aria-labelledby="captions-heading" className="panel flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <CaptionsIcon className="size-4 text-[var(--color-primary)]" aria-hidden />
        <h2 id="captions-heading" className="m-0 text-[15px] font-semibold">
          {tc.heading}
        </h2>
      </div>
      <p className="m-0 text-[12px] text-[var(--color-muted)]">{tc.intro}</p>

      {others.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <h3 className="m-0 text-[13px] font-semibold">{tc.othersHeading}</h3>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {others.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--color-muted)]">
                <span className="min-w-0 flex-1">{tc.otherRunning}</span>
                <button type="button" onClick={() => void cancel(j.id)} disabled={cancelling === j.id} className={quietBtn}>
                  {tc.cancel}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {models.length === 0 ? (
        <p className="m-0 text-[13px] text-[var(--color-muted)]">{tc.noModels}</p>
      ) : recordings.length === 0 ? (
        <p className="m-0 text-[13px] text-[var(--color-muted)]">{tc.noRecordings}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
              {tc.sourceLabel}
              <select
                value={picked?.id ?? ""}
                onChange={(e) => {
                  setSourceId(e.target.value);
                  setJob(null);
                  setErrorCode(null);
                }}
                className={fieldClass}
              >
                {recordings.map((r) => (
                  <option key={r.id} value={r.id}>
                    {fmt(tc.sourceOption, { name: r.name ?? tc.untitledRecording, length: formatTime(r.durationS ?? 0) })}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
              {tc.languageLabel}
              <select value={spoken ?? "detect"} onChange={(e) => setLanguage(e.target.value as CaptionLanguage | "detect")} className={fieldClass}>
                {CAPTION_LANGUAGES.filter((l) => chosen?.languages.includes(l)).map((l) => (
                  <option key={l} value={l}>
                    {tc.languages[l]}
                  </option>
                ))}
                <option value="detect">{tc.detect}</option>
              </select>
            </label>
            {models.length > 1 ? (
              <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
                {tc.modelLabel}
                <select value={chosen?.id ?? ""} onChange={(e) => setModelId(e.target.value)} className={fieldClass}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>

          {picked && !picked.heard && picked.kind === "video" ? (
            <p className="m-0 text-[12px] text-[var(--color-muted)]">{tc.muted}</p>
          ) : null}
          {problem === "too_long" ? <p role="alert" className="m-0 text-[12px] text-[var(--color-fail)]">{tc.tooLong}</p> : null}
          {problem === "unknown" || problem === "not_recording" ? (
            <p role="alert" className="m-0 text-[12px] text-[var(--color-fail)]">{tc.unknownLength}</p>
          ) : null}

          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => void start()}
              disabled={quote.status !== "ready" || submitting || jobActive}
              aria-busy={submitting || quote.status === "quoting"}
              className="btn-sky is-solid pill self-start px-4 py-2 text-[13px]"
            >
              {submitting ? tc.starting : priceLabel}
            </button>
            <p className="m-0 text-[11px] text-[var(--color-muted)]">{tc.priceNote}</p>
            {quoteErrorCode ? (
              <div role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--color-fail)]">
                <span>{apiErrorMessage(t, quoteErrorCode)}</span>
                {action === "credits" ? (
                  <Link href={path("/credits")} className="text-[var(--color-primary)] underline-offset-4 hover:underline">
                    {tc.addCredits}
                  </Link>
                ) : null}
                {action === "requote" || quoteErrorCode === "failed" ? (
                  <button type="button" onClick={() => { setErrorCode(null); setRequote((n) => n + 1); }} className={quietBtn}>
                    {tc.retry}
                  </button>
                ) : null}
              </div>
            ) : null}
            <div aria-live="polite" className="text-[13px]">
              {status === "working" ? (
                <span className="inline-flex flex-wrap items-center gap-2 text-[var(--color-warn)]">
                  {tc.working}
                  {job ? (
                    <button type="button" onClick={() => void cancel(job.id)} disabled={cancelling === job.id} className={quietBtn}>
                      {tc.cancel}
                    </button>
                  ) : null}
                </span>
              ) : status === "ready" && activeTrack ? (
                <span className="text-[var(--color-ok)]">
                  {fmt(tc.ready, { words: activeTrack.wordCount, lang: tc.languages[activeTrack.language as CaptionLanguage] ?? tc.lang.und })}
                </span>
              ) : status === "failed" ? (
                <span className="text-[var(--color-fail)]">
                  {tc.failed} {failReason}
                </span>
              ) : null}
            </div>
          </div>

          {/* transcripts already made: free to use again */}
          <div className="flex flex-col gap-2">
            <h3 className="m-0 text-[13px] font-semibold">{tc.earlier}</h3>
            {tracks === null ? (
              <p className="m-0 text-[12px] text-[var(--color-muted)]" role="status">…</p>
            ) : tracksError ? (
              <p className="m-0 text-[12px] text-[var(--color-fail)]">{tc.transcriptFailed}</p>
            ) : tracks.length === 0 ? null : (
              <>
                <p className="m-0 text-[11px] text-[var(--color-muted)]">{tc.earlierNote}</p>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {tracks.map((x) => (
                    <li key={x.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                      <span className="min-w-0 flex-1 text-[var(--color-fg)]">
                        {fmt(tc.transcriptMeta, {
                          lang: tc.languages[x.language as CaptionLanguage] ?? tc.lang.und,
                          words: x.wordCount,
                          when: x.createdAt ? new Date(x.createdAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "",
                        })}
                      </span>
                      <button
                        type="button"
                        onClick={() => void pickTrack(x.id)}
                        disabled={loadingTrack === x.id}
                        aria-pressed={activeTrack?.id === x.id}
                        className={quietBtn}
                      >
                        {tc.useTranscript}
                      </button>
                      <button type="button" onClick={() => void removeTrack(x.id)} className={quietBtn} aria-label={tc.removeTranscript}>
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {/* the look and the captions on the video: free */}
          <div className="flex flex-col gap-2">
            <h3 className="m-0 text-[13px] font-semibold">{tc.lookHeading}</h3>
            <div role="radiogroup" aria-label={tc.lookHeading} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {CAPTION_PRESETS.map((p) => {
                const on = (current ? burnedLook : preset) === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => choosePreset(p.id)}
                    className={`flex flex-col gap-0.5 rounded-xl border p-2 text-left text-[12px] ${
                      on ? "border-[var(--color-primary)]" : "border-[var(--color-border)]"
                    }`}
                  >
                    <span className="font-semibold" style={{ color: p.style.color, textShadow: "0 0 2px #000, 0 0 3px #000" }}>
                      {tc.presets[p.id]}
                    </span>
                    <span className="text-[11px] text-[var(--color-muted)]">{tc.presetNotes[p.id]}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {armed ? (
                <>
                  <span className="text-[12px] text-[var(--color-muted)]">{tc.rebuildWarn}</span>
                  <button type="button" onClick={put} className="btn-sky is-solid pill px-3 py-1.5 text-[12px]">
                    {tc.rebuild}
                  </button>
                  <button type="button" onClick={() => setArmed(false)} className={quietBtn}>
                    {t.editor.close}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => (current ? setArmed(true) : put())}
                  disabled={!activeTrack}
                  className="btn-sky is-solid pill px-3 py-1.5 text-[12px]"
                >
                  {current ? tc.rebuild : tc.put}
                </button>
              )}
            </div>
            {notice ? (
              <p role="status" className="m-0 text-[12px] text-[var(--color-muted)]">
                {notice}
              </p>
            ) : null}
          </div>
        </>
      )}

      {/* the captions the project holds: edit, delete, download */}
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-[13px] font-semibold">{fmt(tc.cuesHeading, { n: cues.length })}</h3>
        {cues.length === 0 ? (
          <p className="m-0 text-[12px] text-[var(--color-muted)]">{tc.noCues}</p>
        ) : (
          <>
            <p className="m-0 text-[11px] text-[var(--color-muted)]">{tc.burnedNote}</p>
            <ul className="m-0 flex max-h-[420px] list-none flex-col gap-2 overflow-y-auto p-0 pr-1">
              {cues.slice(0, shown).map((c, i) => (
                <CueRow
                  key={c.id}
                  n={i + 1}
                  text={c.text}
                  start={c.start_s}
                  end={c.end_s}
                  warning={warnings[c.id] === "empty" || warnings[c.id] === "too_long" ? warnings[c.id] : null}
                  onText={(v) => onChange(updateCue(model, c.id, { text: v }))}
                  onTimes={(s, e) => onChange(updateCue(model, c.id, { start_s: s, end_s: e }))}
                  onDelete={() => onChange(removeCue(model, c.id))}
                />
              ))}
            </ul>
            {cues.length > shown ? (
              <button type="button" onClick={() => setShown((n) => n + CUES_SHOWN)} className={`${quietBtn} self-start`}>
                +{Math.min(CUES_SHOWN, cues.length - shown)}
              </button>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <h3 className="m-0 text-[13px] font-semibold">{tc.downloadHeading}</h3>
              <p className="m-0 text-[11px] text-[var(--color-muted)]">{tc.downloadNote}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => download(captionFileName(fileTitle, downloadLanguage, "srt"), "application/x-subrip", buildSrt(cues))}
                  className={quietBtn}
                >
                  <Download className="size-3.5" aria-hidden />
                  {tc.downloadSrt}
                </button>
                <button
                  type="button"
                  onClick={() => download(captionFileName(fileTitle, downloadLanguage, "vtt"), "text/vtt", buildVtt(cues))}
                  className={quietBtn}
                >
                  <Download className="size-3.5" aria-hidden />
                  {tc.downloadVtt}
                </button>
                <button type="button" onClick={() => onChange(setCaptions(model, null))} className={quietBtn}>
                  <Trash2 className="size-3.5" aria-hidden />
                  {tc.clear}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
