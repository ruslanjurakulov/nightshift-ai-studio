"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { Music, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { formatCredits } from "@/lib/credits";
import { refreshCredits, useLiveCredits } from "@/lib/credits-live";
import { parseMediaId } from "@/lib/media";
import { UPSELL_LINKS } from "@/lib/upsell";
import type { EditorAsset } from "@/lib/editor";
import {
  apiErrorMessage,
  asCreativeError,
  coerceJobs,
  entitlementReason,
  errorAction,
  failureReason,
  isActiveStatus,
  modelsFor,
  newIdempotencyKey,
  wordsMax,
  type ModelLock,
  type QuoteState,
  type StudioJob,
  type StudioModel,
} from "@/lib/creative/studio";
import { clock } from "./VoiceOverRecorder";

/** 44 px targets at every width (WCAG 2.5.5), like the voice-over panel's. */
const btn = "btn-quiet inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 px-3 text-sm";
const primary = "btn-primary inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 px-4 text-sm";
const note = "m-0 text-xs text-[var(--color-muted)]";
// The editor's field look (CaptionsPanel): 16 px text on a phone, so focusing it does not zoom the page.
const field =
  "w-full min-w-0 rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-base text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]";
// The composer's pace (GeneratePanel / CaptionsPanel): a price is asked once typing pauses, a running job is read every 3 s.
const QUOTE_DELAY_MS = 400;
const POLL_MS = 3000;

/**
 * The music models the editor may offer: the Studio's own list (lib/server/creative loadStudioModels, already trimmed to what
 * sellable_models() sells here, the owner's switch and this country), narrowed to `music`. A model refused to EVERY workspace
 * (`not_on_sale`: a plan-tier entitlement creative_price never opens) is not offered at all, so the editor shows no key nobody
 * can ever press; a lock the person can lift (a first purchase, the age confirmation) is offered, and named in the panel.
 */
export function musicModelsFrom(models: readonly StudioModel[] | null | undefined): StudioModel[] {
  return modelsFor([...(models ?? [])], "music").filter((m) => m.lock !== "not_on_sale");
}

/**
 * Exactly the `music` request the backend accepts (0228's creative_params_problem and creative_price): the words and nothing
 * else. Lyria is priced per request and has no duration, lyrics, seed, negative-prompt or loop field; anything more is refused.
 */
export function musicParams(prompt: string): { prompt: string } {
  return { prompt: prompt.trim() };
}

/** Lyria's maker watermarks every file it returns (docs/research/lyria-3-5.md, SynthID): said wherever its music is made. */
function isLyria(id: string): boolean {
  return id.startsWith("google-lyria");
}

// ── a track asked for before a refresh: this tab's own record of which job to wait for ─────────────────────────────────────
// sessionStorage, keyed by project, holds only a job id and when it started. It is never trusted for more than "ask about this
// job": the job is read again through /api/creative/jobs/{id}, under the person's session and RLS (another organization's job
// reads as 404), and only what that answers is placed. Every access is wrapped: storage throws in private modes and when full,
// and the editor must work without it.
const PENDING_PREFIX = "nightshift:editor-music:";
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PendingMusic {
  jobId: string;
  startedAt: number;
}

export function readPendingMusic(projectId: string): PendingMusic | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_PREFIX + projectId);
    if (!raw) return null;
    const v = JSON.parse(raw) as { jobId?: unknown; startedAt?: unknown };
    if (typeof v.jobId !== "string" || !JOB_ID_RE.test(v.jobId)) return null;
    if (typeof v.startedAt !== "number" || !Number.isFinite(v.startedAt)) return null;
    return { jobId: v.jobId, startedAt: v.startedAt };
  } catch {
    return null;
  }
}

function writePendingMusic(projectId: string, v: PendingMusic): void {
  try {
    window.sessionStorage.setItem(PENDING_PREFIX + projectId, JSON.stringify(v));
  } catch {
    // Without storage a refresh simply does not find the job again; the track still lands in the library.
  }
}

function clearPendingMusic(projectId: string): void {
  try {
    window.sessionStorage.removeItem(PENDING_PREFIX + projectId);
  } catch {
    // Nothing to do: a stale entry is re-read and answered by the job route.
  }
}

type Run =
  | { at: "idle" }
  | { at: "confirm" }
  | { at: "starting" }
  // `adopted`: found again after a refresh, so it is read at once instead of after the first wait.
  | { at: "working"; jobId: string; since: number; adopted?: boolean }
  | { at: "reading" }
  | { at: "failed"; reason: string }
  | { at: "unreadable" }
  | { at: "full" }
  | { at: "lost" }
  | { at: "cancelled" };

export interface MusicMakerProps {
  orgId: string;
  /** The project this panel places music in: a job waited for across a refresh is kept per project. */
  projectId: string;
  /** The sellable music models (musicModelsFrom); the editor mounts the panel only when there is at least one. */
  models: readonly StudioModel[];
  /** Whether the project has room for another sound now (lib/editor.ts canAddSound). */
  canAdd: boolean;
  /** Put the finished track on the timeline at the playhead as music. False = there was no room (it stays in the library). */
  onAdd: (asset: EditorAsset) => boolean;
  onClose: () => void;
}

/**
 * "Make music" in the editor's sound row: the only place Nightshift offers music (Google APIs Terms 4a, the registry's terms note
 * for google-lyria-3.5: a music tool inside the video workflow, never a bare prompt-to-song). The database prices the words
 * (/api/creative/quote, nothing held); a person confirms that price; only then is a job created, with the price as max_credits.
 * The finished audio file is read from the library and handed to the editor, which places it at the playhead. A model that stops
 * being available stops the panel: nothing else is offered instead (CLAUDE.md #4).
 */
export function MusicMaker({ orgId, projectId, models, canAdd, onAdd, onClose }: MusicMakerProps) {
  const { t, fmt, locale } = useI18n();
  const tm = t.editorMusic;
  const path = useChannelPath();
  const ids = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState("");
  // The first model this workspace can buy, else the first (its lock is named, and nothing is priced for it).
  const [modelId, setModelId] = useState(() => (models.find((m) => !m.lock) ?? models[0])?.id ?? "");
  const chosen = models.find((m) => m.id === modelId) ?? models[0] ?? null;
  const locked: ModelLock | null = chosen?.lock ?? null;
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const [requote, setRequote] = useState(0);
  const [run, setRun] = useState<Run>({ at: "idle" });
  // A refusal of the create itself (the quote's own refusals live in `quote`).
  const [refusal, setRefusal] = useState<{ code: string; detail?: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The job's last status as read (a queued job may still be cancelled) and what a cancel answered.
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  const pressing = useRef(false);
  const onAddRef = useRef(onAdd);
  onAddRef.current = onAdd;

  useEffect(() => {
    // A track this tab asked for before a refresh is waited for again, not asked (and paid for) twice.
    const pending = readPendingMusic(projectId);
    if (pending) {
      setNow(Date.now());
      setRun({ at: "working", jobId: pending.jobId, since: pending.startedAt, adopted: true });
    }
    box.current?.focus();
    // once, when the panel opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const words = prompt.trim();
  const paramsKey = JSON.stringify(musicParams(prompt));
  const busy = run.at === "starting" || run.at === "working" || run.at === "reading";
  const adopted = run.at === "working" && run.adopted === true;

  // ── the price: asked of the database only, never computed here ───────────────
  useEffect(() => {
    if (!chosen || !words || locked || busy) {
      if (!busy) setQuote({ status: "idle" });
      return;
    }
    setQuote({ status: "quoting" });
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/creative/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ org_id: orgId, capability: "music", model: chosen.id, params: JSON.parse(paramsKey) }),
          signal: ctrl.signal,
        });
        const body = (await res.json().catch(() => ({}))) as { quote?: { credits?: unknown }; error?: unknown; detail?: unknown };
        if (ctrl.signal.aborted) return;
        const credits = body.quote?.credits;
        if (res.ok && typeof credits === "number" && Number.isFinite(credits)) {
          setQuote({ status: "ready", credits });
          // "The price changed": the new price is now on the key, to be confirmed again.
          setRefusal((r) => (r?.code === "price_changed" ? null : r));
        } else
          setQuote({
            status: "error",
            code: res.ok ? "failed" : asCreativeError(body.error),
            ...(typeof body.detail === "string" ? { detail: body.detail } : {}),
          });
      } catch {
        if (!ctrl.signal.aborted) setQuote({ status: "error", code: "failed" });
      }
    }, QUOTE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // `busy` is left out on purpose: a job that ends must not re-ask a price for words that were already paid for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, chosen?.id, paramsKey, words, locked, requote]);

  // A changed word or model is a new price: a confirm given for the old one is gone.
  useEffect(() => {
    setRun((r) => (r.at === "confirm" ? { at: "idle" } : r));
    setRefusal(null);
  }, [paramsKey, modelId]);

  // ── the job: read until it ends, then the file it made ───────────────────────
  const jobId = run.at === "working" ? run.jobId : null;
  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const read = async () => {
      let job: StudioJob | undefined;
      try {
        const res = await fetch(`/api/creative/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { job?: unknown };
        if (stopped) return;
        if (res.status === 404) {
          // Not a job this session may read (or no longer one): stop waiting for it, and say so.
          stopped = true;
          clearInterval(poll);
          clearInterval(tick);
          clearPendingMusic(projectId);
          setRun({ at: "lost" });
          return;
        }
        if (!res.ok) return;
        job = coerceJobs([body.job])[0];
      } catch {
        return; // the next tick asks again
      }
      if (!job || stopped) return;
      setJobStatus(job.status);
      if (isActiveStatus(job.status)) return;
      stopped = true;
      clearInterval(poll);
      clearInterval(tick);
      // The job has ended, whichever way: a refresh must not wait for it again.
      clearPendingMusic(projectId);
      if (job.status === "cancelled") {
        setRun({ at: "cancelled" });
        return;
      }
      if (job.status !== "completed") {
        setRun({ at: "failed", reason: failureReason(t, job) });
        return;
      }
      setRun({ at: "reading" });
      const asset = await readTrack(job.result_asset_ids[0]);
      if (!asset) {
        setRun({ at: "unreadable" });
        return;
      }
      if (!onAddRef.current(asset)) {
        setRun({ at: "full" });
        return;
      }
      onClose();
    };
    const poll = setInterval(() => void read(), POLL_MS);
    if (adopted) void read();
    return () => {
      stopped = true;
      clearInterval(poll);
      clearInterval(tick);
    };
    // `t`, `onClose`, `projectId` and `adopted` are read when the job is, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  async function create() {
    if (quote.status !== "ready" || !chosen || locked || !canAdd || pressing.current) return;
    pressing.current = true;
    const priced = quote.credits;
    setRun({ at: "starting" });
    setRefusal(null);
    try {
      const res = await fetch("/api/creative/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org_id: orgId,
          capability: "music",
          model: chosen.id,
          params: musicParams(prompt),
          idempotency_key: newIdempotencyKey(),
          // The price the person confirmed: the ceiling, never more.
          max_credits: priced,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { job?: { id?: unknown }; error?: unknown; detail?: unknown };
      if (res.ok && typeof body.job?.id === "string") {
        const at = Date.now();
        setNow(at);
        writePendingMusic(projectId, { jobId: body.job.id, startedAt: at });
        setJobStatus("queued");
        setCancelNote(null);
        setRun({ at: "working", jobId: body.job.id, since: at });
        void refreshCredits(orgId);
        return;
      }
      const code = res.ok ? "failed" : asCreativeError(body.error);
      setRefusal({ code, ...(typeof body.detail === "string" ? { detail: body.detail } : {}) });
      setRun({ at: "idle" });
      if (code === "price_changed") setRequote((n) => n + 1);
      if (code === "insufficient_credits") void refreshCredits(orgId);
    } catch {
      setRefusal({ code: "failed" });
      setRun({ at: "idle" });
    } finally {
      pressing.current = false;
    }
  }

  // ── cancel: the existing job route (POST { action: "cancel" }, 0231's cancel_creative_job), which releases the hold ────────
  async function cancel() {
    if (run.at !== "working" || cancelling) return;
    const id = run.jobId;
    setCancelling(true);
    setCancelNote(null);
    try {
      const res = await fetch(`/api/creative/jobs/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      const body = (await res.json().catch(() => ({}))) as { job?: unknown; error?: unknown };
      const ended = res.ok ? coerceJobs([body.job])[0] : undefined;
      if (ended && ended.status === "cancelled") {
        clearPendingMusic(projectId);
        setRun({ at: "cancelled" });
        void refreshCredits(orgId);
      } else if (ended) {
        // It ended some other way first: the next read of the job says how.
        setJobStatus(ended.status);
      } else if (body.error === "not_cancellable") {
        setJobStatus("running");
        setCancelNote(t.captions.notCancellable);
      } else {
        setCancelNote(apiErrorMessage(t, body.error));
      }
    } catch {
      setCancelNote(apiErrorMessage(t, "failed"));
    } finally {
      setCancelling(false);
    }
  }

  const live = useLiveCredits(orgId);
  const shortBy = quote.status === "ready" && live && quote.credits > live.available ? quote.credits - live.available : null;
  const errorCode = refusal?.code ?? (quote.status === "error" ? quote.code : null);
  const errorDetail = refusal?.detail ?? (quote.status === "error" ? quote.detail : undefined);
  const entReason = errorCode === "entitlement_required" ? entitlementReason(chosen?.entitlement, errorDetail) : null;
  const lockShown = locked ?? entReason;
  // The model went away between the list and the press: the panel stops, and says nothing else is used instead.
  const gone = errorCode === "model_not_sellable" || errorCode === "model_temporarily_off";
  const canPress = quote.status === "ready" && !lockShown && canAdd && shortBy === null && !busy;

  // Why the key cannot be pressed, in the composer's own words where it has them.
  let why: ReactNode = null;
  if (!canAdd) why = tm.full;
  else if (lockShown)
    why = (
      <span data-testid="music-locked" data-lock={lockShown}>
        {t.gen.lockWhy[lockShown]}
        {lockShown === "first_purchase" ? (
          <>
            {" "}
            <Link href={path(UPSELL_LINKS.topups)} className="tap-link text-[var(--color-primary)] underline">
              {t.gen.lockBuy}
            </Link>
          </>
        ) : null}
      </span>
    );
  else if (errorCode)
    why = (
      <span data-testid="music-refused" data-code={errorCode}>
        {apiErrorMessage(t, errorCode)}
        {gone ? ` ${tm.noSubstitute}` : null}
        {errorAction(errorCode) === "credits" ? (
          <>
            {" "}
            <Link href={path("/credits")} className="tap-link text-[var(--color-primary)] underline">
              {t.gen.addCredits}
            </Link>
          </>
        ) : null}
      </span>
    );
  else if (shortBy !== null)
    why = (
      <span data-testid="music-short">
        {t.gen.needMoreNote}{" "}
        <Link href={path(UPSELL_LINKS.topups)} className="tap-link text-[var(--color-primary)] underline">
          {fmt(t.gen.needMore, { n: formatCredits(shortBy, locale) })}
        </Link>
      </span>
    );
  else if (!words) why = tm.needWords;
  else if (quote.status === "quoting") why = t.gen.quoting;
  else if (quote.status === "ready") why = t.gen.holdNote;

  const credits = quote.status === "ready" ? formatCredits(quote.credits, locale) : null;

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onClose();
  }

  // What the live region says: one sentence per change of state, never the ticking clock.
  const status =
    run.at === "starting"
      ? t.gen.starting
      : run.at === "working"
        ? tm.working
        : run.at === "reading"
          ? tm.reading
          : "";

  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="panel flex min-w-0 flex-col gap-3 p-4 sm:p-5"
      data-testid="music-maker"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={`${ids}-title`} className="m-0 text-sm font-semibold">
          {tm.title}
        </h3>
        <button type="button" onClick={onClose} className={btn} aria-label={tm.close}>
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <label htmlFor={`${ids}-prompt`} className="text-sm font-medium">
        {tm.promptLabel}
      </label>
      <textarea
        id={`${ids}-prompt`}
        ref={box}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        maxLength={wordsMax("music")}
        rows={3}
        disabled={busy}
        placeholder={tm.promptPh}
        aria-describedby={`${ids}-hint ${ids}-legal`}
        className={`${field} resize-y`}
      />
      <p id={`${ids}-hint`} className={note}>
        {tm.promptHint}
      </p>
      {/* In a new tab: leaving the editor here would drop unsaved edits (and the wait for a running track). */}
      <p id={`${ids}-legal`} className={note} data-testid="music-disclosure">
        {tm.disclosure}
        {chosen && isLyria(chosen.id) ? ` ${tm.synthId}` : ""}{" "}
        <Link href="/privacy#processors" target="_blank" rel="noopener noreferrer" className="tap-link text-[var(--color-primary)] underline">
          {t.legal.privacy}
        </Link>
        {" · "}
        <Link href="/terms#third-parties" target="_blank" rel="noopener noreferrer" className="tap-link text-[var(--color-primary)] underline">
          {t.legal.terms}
        </Link>
      </p>

      {models.length > 1 ? (
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium">{tm.model}</span>
          <select value={chosen?.id ?? ""} onChange={(e) => setModelId(e.target.value)} disabled={busy} className={`${field} min-h-11`}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : chosen ? (
        <p className="m-0 text-sm" data-testid="music-model">
          {fmt(tm.madeWith, { model: chosen.displayName })}
        </p>
      ) : null}
      {chosen?.attribution ? (
        <a href={chosen.attribution.url} target="_blank" rel="noreferrer" className={`${note} underline`}>
          {chosen.attribution.text}
        </a>
      ) : null}

      <p role="status" aria-live="polite" className="m-0 text-sm" data-testid="music-status">
        {status}
      </p>
      {run.at === "working" ? (
        <p className="m-0 font-mono text-sm tabular-nums" data-testid="music-elapsed">
          {fmt(tm.elapsed, { now: clock((now - run.since) / 1000) })}
        </p>
      ) : null}
      {run.at === "working" ? <p className={note}>{tm.workingNote}</p> : null}
      {run.at === "working" && jobStatus === "queued" ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void cancel()} disabled={cancelling} className={btn} data-testid="music-cancel">
            {t.captions.cancel}
          </button>
        </div>
      ) : null}
      {cancelNote ? (
        <p className="m-0 text-xs text-[var(--color-muted)]" data-testid="music-cancel-note">
          {cancelNote}
        </p>
      ) : null}
      {run.at === "cancelled" ? (
        <p className="m-0 text-sm" data-testid="music-cancelled">
          {t.captions.cancelled}
        </p>
      ) : null}

      {run.at === "failed" || run.at === "unreadable" || run.at === "full" || run.at === "lost" ? (
        <div role="alert" className="flex flex-col gap-1 text-sm text-[var(--color-warn)]" data-testid="music-error">
          <p className="m-0">
            {run.at === "failed" ? tm.failed : run.at === "unreadable" ? tm.unreadable : run.at === "lost" ? tm.lost : tm.fullAfter}
          </p>
          {run.at === "failed" ? <p className="m-0 text-xs">{run.reason}</p> : null}
        </div>
      ) : null}

      {run.at === "confirm" && credits !== null ? (
        <div className="flex flex-col gap-2" data-testid="music-confirm">
          <p className="m-0 text-sm">{fmt(tm.confirm, { n: credits })}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void create()} disabled={!canPress} className={primary}>
              {fmt(tm.confirmGo, { n: credits })}
            </button>
            <button type="button" onClick={() => setRun({ at: "idle" })} className={btn}>
              {tm.back}
            </button>
          </div>
        </div>
      ) : run.at === "failed" || run.at === "unreadable" || run.at === "lost" || run.at === "cancelled" ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setRun({ at: "idle" });
              setRequote((n) => n + 1);
            }}
            className={btn}
          >
            {tm.tryAgain}
          </button>
        </div>
      ) : run.at === "idle" || run.at === "full" ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setRun({ at: "confirm" })}
              disabled={!canPress || run.at === "full"}
              aria-describedby={`${ids}-why`}
              className={primary}
              data-testid="music-make"
            >
              <Music className="size-4" aria-hidden />
              {credits !== null ? fmt(tm.makePriced, { n: credits }) : tm.make}
            </button>
          </div>
          <p id={`${ids}-why`} className={note} aria-live="polite" data-testid="music-why">
            {why}
          </p>
        </div>
      ) : null}
    </section>
  );
}

/** The finished file, as the library holds it: an audio file of this organization with a measured length, or nothing. */
async function readTrack(raw: unknown): Promise<EditorAsset | null> {
  const id = parseMediaId(raw);
  if (!id) return null;
  try {
    const res = await fetch(`/api/media/${id}`, { cache: "no-store" });
    if (!res.ok) return null;
    const b = (await res.json().catch(() => ({}))) as {
      asset?: { id?: unknown; kind?: unknown; mime?: unknown; name?: unknown; durationS?: unknown };
      urls?: { original?: unknown };
    };
    const a = b.asset ?? {};
    const duration = typeof a.durationS === "number" && Number.isFinite(a.durationS) && a.durationS > 0 ? a.durationS : null;
    // The library's own reading of the file (media_assets.kind and mime), never the job's word for it.
    if (parseMediaId(a.id) !== id || a.kind !== "audio" || typeof a.mime !== "string" || !a.mime.startsWith("audio/") || duration === null)
      return null;
    const view = typeof b.urls?.original === "string" && b.urls.original.startsWith("/api/media/file/") ? b.urls.original : null;
    return { id, kind: "audio", name: typeof a.name === "string" ? a.name : null, durationS: duration, width: null, height: null, viewUrl: view, thumbUrl: null };
  } catch {
    return null;
  }
}
