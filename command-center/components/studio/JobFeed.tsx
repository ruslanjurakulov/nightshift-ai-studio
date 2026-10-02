"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, AudioLines, Check, Clapperboard, Copy, CopyPlus, ExternalLink, FolderOpen, ImagePlus, Play, ScanText, TriangleAlert, type LucideIcon } from "lucide-react";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { Timecode } from "@/components/ui/Timecode";
import { ContactSheet, Frame } from "@/components/ui/ContactSheet";
import { BeforeAfter } from "@/components/studio/BeforeAfter";
import { TOOL_ICONS } from "@/components/studio/toolIcons";
import { SendToEditor, isSendKind } from "@/components/editor/SendToEditor";
import { useLibraryImages } from "@/components/studio/useLibraryImages";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import type { CreativeError } from "@/lib/creative/operations";
import { deskFor, deskHref } from "@/lib/creative/desks";
import {
  addDismissed,
  apiErrorMessage,
  asCreativeError,
  cardAspect,
  coerceJobs,
  compareSources,
  creditsLine,
  fellBackLine,
  jobModel,
  describeResult,
  edgeFacts,
  failureReason,
  isActiveStatus,
  isDubLanguage,
  isStudioCapability,
  isUnsuccessful,
  kindLabel,
  outputKind,
  prefillFromJob,
  readDismissed,
  resultHref,
  similarPrefill,
  sourceFromJob,
  statusView,
  truncate,
  type StudioJob,
  type StudioModel,
  type StudioPrefill,
} from "@/lib/creative/studio";

export const FEED_POLL_MS = 5000;
const FEED_SHOWN = 20;

/**
 * How a desk lays out what it made (lib/creative/desks):
 * - `sheet`: the proof sheet of cards (outside a desk, as before).
 * - `monitor`: Video — one clip large on the program monitor, the rest as a strip to pick from.
 * - `table`: Image and Enhance — the newest picture large (before / after when it changed one), the rest as a sheet.
 * - `takes`: Voice — one row per take with its own player.
 * - `log`: the overview — every desk's work as compact rows, each linking to its desk.
 */
export type FeedVariant = "sheet" | "monitor" | "table" | "takes" | "log";

/** Seconds since an ISO time, or null when it cannot be read (never a made-up 0). */
export function elapsedSeconds(iso: string, now: number): number | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now - at) / 1000));
}

/**
 * The organization's newest generations (GET /api/creative/jobs, RLS:
 * members), as a grid of result cards. Polls every few seconds only while one
 * of them is still working, and stops when none is. A job that ended without
 * a result keeps its card until it is dismissed (on this device); its held
 * credits were already returned by the database.
 *
 * A finished result is drawn from the library (GET /api/media, read only when
 * some job has a result): its own thumbnail, or — for an edit, upscale or
 * background removal — against its source picture (before / after). "Use as
 * picture" hands a finished picture to the composer; like "Try again" it only
 * fills the form. So does "Describe" (the composer on Describe, with that
 * picture) and, on a finished description, "Make similar" (the image form with
 * its text and the picture's shape); "Copy" puts the text on the clipboard.
 *
 * On a desk (`capabilities`) only that desk's tools are listed, in the desk's
 * own layout (`variant`); the reads, the polling and every action are the same.
 */
export function JobFeed({
  orgId,
  models = [],
  refreshKey = 0,
  onRetry,
  onUseAsSource,
  onDescribe,
  onMakeSimilar,
  capabilities,
  variant = "sheet",
  title,
  emptyTitle,
  emptyBody,
  limit = FEED_SHOWN,
  onLoaded,
}: {
  /** Every read that succeeds hands its jobs up (the overview lights the desks that are working). */
  onLoaded?: (jobs: StudioJob[]) => void;
  orgId: string;
  models?: StudioModel[];
  /** Bumped by the panel after a job is created: reload now. */
  refreshKey?: number;
  onRetry?: (prefill: StudioPrefill) => void;
  /** A finished picture's library id, for the composer's picture tools. */
  onUseAsSource?: (assetId: string) => void;
  /** A finished picture's library id, for the composer's Describe (fills it; the press there is priced). */
  onDescribe?: (assetId: string) => void;
  /** A description's text into the image form (fills it; nothing is made from here). */
  onMakeSimilar?: (prefill: StudioPrefill) => void;
  /** Only these tools' jobs (a desk's). Absent: every job. */
  capabilities?: readonly string[];
  variant?: FeedVariant;
  /** The heading over the results (default "Your generations"). */
  title?: string;
  /** The empty state's words, written for the desk. */
  emptyTitle?: string;
  emptyBody?: string;
  /** How many to show (default 20). */
  limit?: number;
}) {
  const { t, locale, fmt } = useI18n();
  const path = useChannelPath();
  const [jobs, setJobs] = useState<StudioJob[] | null>(null);
  const [state, setState] = useState<"ok" | "failed" | "unavailable">("ok");
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<{ id: string; code: CreativeError } | null>(null);
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null);
  const [featuredId, setFeaturedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);
  const capabilityKey = capabilities ? capabilities.join(",") : "";
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ id, ok: true });
    } catch {
      // No clipboard (an insecure origin, a denied permission): the text is
      // on the card, selectable, and the message says so.
      setCopied({ id, ok: false });
    }
  }

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      // A desk asks the server for its own tools, so older work on it is not pushed out by other desks'.
      const only = capabilityKey ? `&capability=${encodeURIComponent(capabilityKey)}` : "";
      const res = await fetch(`/api/creative/jobs?org_id=${encodeURIComponent(orgId)}${only}`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { jobs?: unknown; error?: unknown };
      if (mine !== seq.current) return;
      if (res.ok) {
        const list = coerceJobs(body.jobs);
        setJobs(list);
        setState("ok");
        onLoadedRef.current?.(list);
      } else {
        setState(body.error === "creative_unavailable" ? "unavailable" : "failed");
        setJobs((j) => j ?? []);
      }
    } catch {
      if (mine !== seq.current) return;
      setState("failed");
      setJobs((j) => j ?? []);
    }
  }, [orgId, capabilityKey]);

  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const active = state !== "unavailable" && (jobs ?? []).some((j) => isActiveStatus(j.status));
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => void load(), FEED_POLL_MS);
    return () => clearInterval(id);
  }, [active, load]);

  // The time since a working job was asked for: a clock, so it ticks only while one is working.
  const timed = variant !== "sheet" && active;
  useEffect(() => {
    if (!timed) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timed]);

  async function cancel(id: string) {
    setCancelling(id);
    setCancelError(null);
    try {
      const res = await fetch(`/api/creative/jobs/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        setCancelError({ id, code: asCreativeError(body.error) });
      }
    } catch {
      setCancelError({ id, code: "failed" });
    } finally {
      setCancelling(null);
      void load();
    }
  }

  const names = new Map(models.map((m) => [m.id, m.displayName]));
  const mine = (j: StudioJob) => !capabilities || capabilities.includes(j.capability);
  const shown = (jobs ?? []).filter((j) => mine(j) && !dismissed.includes(j.id)).slice(0, limit);
  const pairs = new Map(
    shown.flatMap((j) => {
      const p = compareSources(j);
      return p ? [[j.id, p] as const] : [];
    }),
  );
  // The library is read only when a card has something in it to draw.
  const results = shown.flatMap((j) => (j.status === "completed" && j.result_asset_ids[0] ? [j.result_asset_ids[0]] : []));
  // A description is drawn over the picture it describes.
  const described = shown.flatMap((j) =>
    j.capability === "describe" && !isUnsuccessful(j.status) && typeof j.params.source_asset_id === "string"
      ? [j.params.source_asset_id]
      : [],
  );
  const libraryKey = [...[...pairs.values()].map((p) => p.after), ...results, ...described].join(",");
  const library = useLibraryImages(orgId, { enabled: libraryKey !== "", key: libraryKey });
  const pictures = new Map(library.images.map((i) => [i.id, i.viewUrl ?? i.thumbUrl]));
  const chip = "studio-chip tap";
  // Square keys on the picture: named for screen readers and on hover; 44px on a phone.
  const onMedia = "studio-on-media tap-icon press grid size-9 place-items-center rounded-[var(--ns-r-key)] max-sm:size-11";

  // The one shown large on a monitor or a light table: the one picked, else the newest.
  const featured = variant === "monitor" || variant === "table" ? (shown.find((j) => j.id === featuredId) ?? shown[0] ?? null) : null;

  /** What a job looks like: everything a card, the monitor and a strip frame draw from. */
  function look(job: StudioJob) {
    const prompt = typeof job.params.prompt === "string" ? job.params.prompt : "";
    const done = job.status === "completed";
    const href = done ? resultHref(job) : null;
    const pair = pairs.get(job.id);
    const before = pair ? pictures.get(pair.before) : null;
    const after = pair ? pictures.get(pair.after) : null;
    const kind = outputKind(job.capability);
    const preview = done && job.result_asset_ids[0] ? library.previews.get(job.result_asset_ids[0]) : undefined;
    const describedPic =
      job.capability === "describe" && typeof job.params.source_asset_id === "string"
        ? library.previews.get(job.params.source_asset_id)
        : undefined;
    const alt = prompt ? truncate(prompt, 80) : kindLabel(t, job.capability);
    const Icon: LucideIcon = isStudioCapability(job.capability) ? TOOL_ICONS[job.capability] : Clapperboard;
    return { prompt, done, href, before, after, kind, preview, describedPic, alt, Icon };
  }

  function media(job: StudioJob, { large = false, thumb = false }: { large?: boolean; thumb?: boolean } = {}): ReactNode {
    const { done, href, before, after, kind, preview, describedPic, alt, Icon } = look(job);
    if (large && isActiveStatus(job.status)) {
      // Nothing to show yet: the monitor says what it is doing and for how long, in its own light.
      const sv = statusView(t, job.status);
      const s = elapsedSeconds(job.created_at, now);
      return (
        <span className="desk-stage-wait">
          <span aria-hidden className="ns-lamp" data-tone={sv.tone} data-live={sv.live ? "true" : undefined} data-size="md" />
          <span className="desk-stage-wait-word">{sv.label}</span>
          {s !== null && <Timecode value={s} format="duration" label={fmt(t.desk.sinceSpoken, { n: s })} className="desk-stage-wait-tc" />}
        </span>
      );
    }
    if (thumb && after) {
      // A row's thumbnail is too small to compare: the result alone.
      // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived library links
      return <img src={after} alt={kindLabel(t, job.capability)} loading="lazy" className="h-full w-full object-cover" />;
    }
    if (kind === "text" && (describedPic?.thumbUrl || describedPic?.viewUrl)) {
      return (
        // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived library links
        <img
          src={((large ? describedPic.viewUrl : null) ?? describedPic.thumbUrl ?? describedPic.viewUrl) as string}
          alt={t.gen.describedPicture}
          loading="lazy"
          className={`h-full w-full ${large ? "object-contain" : "object-cover"}${isActiveStatus(job.status) ? " opacity-60" : ""}`}
        />
      );
    }
    if (before && after) return <BeforeAfter bare before={before} after={after} alt={kindLabel(t, job.capability)} />;
    if (done && kind === "image" && (preview?.thumbUrl || preview?.viewUrl || href)) {
      const src = (large ? (preview?.viewUrl ?? preview?.thumbUrl ?? href) : (preview?.thumbUrl ?? preview?.viewUrl ?? href)) as string;
      return (
        // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived library links
        <img src={src} alt={alt} loading="lazy" className={`h-full w-full ${large ? "object-contain" : "object-cover"}`} />
      );
    }
    if (done && kind === "video" && large && (href || preview?.viewUrl)) {
      // On the monitor a finished clip plays, with the browser's own controls.
      return (
        <video
          src={(href ?? preview?.viewUrl) as string}
          poster={preview?.thumbUrl ?? undefined}
          controls
          playsInline
          preload="metadata"
          aria-label={alt}
          className="h-full w-full bg-[var(--ns-film)] object-contain"
        />
      );
    }
    if (done && kind === "video" && (preview?.thumbUrl || href)) {
      return preview?.thumbUrl ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
          <img src={preview.thumbUrl} alt={alt} loading="lazy" className="h-full w-full object-cover" />
          <span aria-hidden className="studio-on-media absolute left-1/2 top-1/2 grid size-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-[var(--ns-r-key)]">
            <Play className="size-4" />
          </span>
        </>
      ) : (
        <video src={href as string} muted playsInline preload="metadata" aria-label={alt} className="h-full w-full object-cover" />
      );
    }
    return (
      <span
        className={`flex h-full w-full flex-col items-center justify-center gap-2 text-[var(--color-muted)]${isActiveStatus(job.status) && !large ? " skeleton rounded-none" : ""}`}
      >
        {isUnsuccessful(job.status) ? (
          <TriangleAlert aria-hidden className="size-6" strokeWidth={1.5} />
        ) : isActiveStatus(job.status) ? (
          <span aria-hidden className="ns-lamp" data-tone="run" data-live="true" data-size="md" />
        ) : kind === "audio" ? (
          <AudioLines aria-hidden className="size-7" strokeWidth={1.5} />
        ) : kind === "text" ? (
          <ScanText aria-hidden className="size-7" strokeWidth={1.5} />
        ) : (
          <Icon aria-hidden className="size-6" strokeWidth={1.5} />
        )}
      </span>
    );
  }

  /** The buttons on a finished result: describe, use as picture, send to the editor, open. */
  function resultActions(job: StudioJob, className = "studio-card-actions absolute bottom-2 right-2 z-10 flex gap-1.5"): ReactNode {
    const { done, href, kind } = look(job);
    if (!done || kind === "text") return null;
    const asSource = onUseAsSource ? sourceFromJob(job) : null;
    const toDescribe = onDescribe ? sourceFromJob(job) : null;
    return (
      <div className={className}>
        {toDescribe && (
          <button
            type="button"
            className={onMedia}
            aria-label={t.gen.describeAction}
            title={t.gen.describeAction}
            onClick={() => onDescribe?.(toDescribe)}
          >
            <ScanText aria-hidden className="size-4" />
          </button>
        )}
        {asSource && (
          <button
            type="button"
            className={onMedia}
            aria-label={t.gen.useAsSource}
            title={t.gen.useAsSource}
            onClick={() => onUseAsSource?.(asSource)}
          >
            <ImagePlus aria-hidden className="size-4" />
          </button>
        )}
        {isSendKind(kind) && job.result_asset_ids[0] && (
          <SendToEditor orgId={orgId} assetId={job.result_asset_ids[0]} kind={kind} variant="icon" className={onMedia} />
        )}
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className={onMedia} aria-label={t.gen.open} title={t.gen.open}>
            <ExternalLink aria-hidden className="size-4" />
          </a>
        ) : (
          <Link href={path("/library")} className={onMedia} aria-label={t.gen.openLibrary} title={t.gen.openLibrary}>
            <FolderOpen aria-hidden className="size-4" />
          </Link>
        )}
      </div>
    );
  }

  /** The description's text and its two actions (Describe results only). */
  function descriptionBlock(job: StudioJob): ReactNode {
    const description = describeResult(job);
    if (!description) return null;
    return (
      <div className="flex flex-col gap-2">
        <p className="sr-only">{t.gen.descriptionLabel}</p>
        <p
          lang={description.language}
          className="select-text whitespace-pre-wrap break-words rounded-[var(--ns-r-key)] bg-[var(--studio-field)] p-2.5 text-[13px] leading-relaxed text-[var(--color-fg)]"
          data-testid="describe-text"
        >
          {description.text}
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${chip} gap-1.5`} onClick={() => void copy(job.id, description.text)}>
            {copied?.id === job.id && copied.ok ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
            {copied?.id === job.id && copied.ok ? t.gen.copied : t.gen.copy}
          </button>
          {onMakeSimilar && (
            <button
              type="button"
              className={`${chip} gap-1.5`}
              title={t.gen.makeSimilarHint}
              aria-describedby={`similar-hint-${job.id}`}
              onClick={() => onMakeSimilar(similarPrefill(description))}
            >
              <CopyPlus aria-hidden className="size-3.5" />
              {t.gen.makeSimilar}
            </button>
          )}
        </div>
        <span id={`similar-hint-${job.id}`} className="sr-only">
          {t.gen.makeSimilarHint}
        </span>
        <p className="min-h-[1em] text-[12px]" aria-live="polite">
          {copied?.id === job.id && !copied.ok && <span className="text-[var(--color-warn)]">{t.gen.copyFailed}</span>}
        </p>
      </div>
    );
  }

  /** Model and credits, the failure and its remedy, and Cancel / Try again / Dismiss. */
  function facts(job: StudioJob): ReactNode {
    const retry = isUnsuccessful(job.status) ? prefillFromJob(job) : null;
    return (
      <>
        {job.capability === "dub" && isDubLanguage(job.params.target_language) && (
          <p className="text-[13px] leading-snug text-[var(--color-fg)]" lang={job.params.target_language}>
            → {t.gen.languages[job.params.target_language]}
          </p>
        )}
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[11px] text-[var(--color-muted)]">
          <span className="min-w-0 truncate">{names.get(jobModel(job)) ?? jobModel(job)}</span>
          <span aria-hidden>·</span>
          <span className="mono">{creditsLine(t, job, locale)}</span>
        </p>
        {fellBackLine(t, job, names) && (
          <p className="text-[11px] leading-snug text-[var(--color-muted)]" data-testid="job-fell-back">
            {fellBackLine(t, job, names)}
          </p>
        )}
        {isUnsuccessful(job.status) && (
          <p className="text-[12px] text-[var(--color-muted)]">
            {failureReason(t, job)} {t.gen.returnedNote}
          </p>
        )}
        {cancelError?.id === job.id && <p className="text-[12px] text-[var(--color-fail)]">{apiErrorMessage(t, cancelError.code)}</p>}
        {(job.status === "queued" || retry || isUnsuccessful(job.status)) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {job.status === "queued" && (
              <button type="button" className={chip} disabled={cancelling === job.id} onClick={() => void cancel(job.id)}>
                {cancelling === job.id ? t.gen.cancelling : t.gen.cancel}
              </button>
            )}
            {retry && onRetry && (
              <button type="button" className={chip} onClick={() => onRetry(retry)}>
                {t.gen.tryAgain}
              </button>
            )}
            {isUnsuccessful(job.status) && (
              <button type="button" className={chip} onClick={() => setDismissed(addDismissed(job.id, dismissed))}>
                {t.gen.dismiss}
              </button>
            )}
          </div>
        )}
      </>
    );
  }

  /** Waiting or making: how long since it was asked for, as a counter (never a guessed progress). */
  function since(job: StudioJob): ReactNode {
    if (!isActiveStatus(job.status)) return null;
    const s = elapsedSeconds(job.created_at, now);
    if (s === null) return null;
    return (
      <span className="desk-since">
        {t.desk.since}{" "}
        <Timecode value={s} format="duration" label={fmt(t.desk.sinceSpoken, { n: s })} />
      </span>
    );
  }

  /** A frame on the proof sheet (components/ui/ContactSheet): the picture on film, its facts printed on the edge. */
  function card(job: StudioJob): ReactNode {
    const sv = statusView(t, job.status);
    const { prompt, before, after } = look(job);
    return (
      <Frame
        key={job.id}
        className="studio-card"
        data-status={job.status}
        edge={edgeFacts(t, job, locale)}
        aspect={before && after ? undefined : cardAspect(job)}
        body={
          <div className="flex flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-[12px] font-semibold text-[var(--color-fg)]">{kindLabel(t, job.capability)}</span>
              <span className="ml-auto shrink-0">
                <StatusLamp tone={sv.tone} label={sv.label} live={sv.live} />
              </span>
            </div>
            {prompt && <p className="studio-clamp-2 break-words text-[13px] leading-snug text-[var(--color-fg)]">{truncate(prompt)}</p>}
            {descriptionBlock(job)}
            {facts(job)}
          </div>
        }
      >
        {media(job)}
        {resultActions(job)}
      </Frame>
    );
  }

  /** The big one: the program monitor (Video) or the light table (Image, Enhance). */
  function stage(job: StudioJob | null): ReactNode {
    if (!job) return null;
    const sv = statusView(t, job.status);
    const { prompt, kind } = look(job);
    const aspect = variant === "monitor" ? cardAspect(job) : undefined;
    return (
      <figure className="desk-stage" data-variant={variant} data-status={job.status} data-testid="desk-stage">
        <div className="desk-stage-screen" style={aspect && kind === "video" ? { aspectRatio: aspect } : undefined}>
          {media(job, { large: true })}
          {/* The state over a finished or failed picture (a working one says it in the middle;
              a before / after carries its own two labels there). */}
          {!isActiveStatus(job.status) && !pairs.has(job.id) && (
            <div className="desk-stage-tally" aria-hidden>
              <StatusLamp tone={sv.tone} label={sv.label} live={sv.live} />
            </div>
          )}
          {resultActions(job, "desk-stage-actions")}
        </div>
        <figcaption className="desk-stage-slate">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="desk-stage-kind">{kindLabel(t, job.capability)}</span>
            <StatusLamp tone={sv.tone} label={sv.label} live={sv.live} />
            {since(job)}
          </div>
          {prompt && <p className="break-words text-[14px] leading-snug text-[var(--color-fg)]">{truncate(prompt, 240)}</p>}
          {descriptionBlock(job)}
          {facts(job)}
        </figcaption>
      </figure>
    );
  }

  /** A frame on the strip under the monitor: pressing it puts that clip on the monitor. */
  function stripFrame(job: StudioJob): ReactNode {
    const sv = statusView(t, job.status);
    const on = featured?.id === job.id;
    const { prompt } = look(job);
    return (
      <li key={job.id} className="desk-strip-item">
        <button
          type="button"
          aria-pressed={on}
          onClick={() => setFeaturedId(job.id)}
          className="desk-strip-frame"
          title={t.desk.showOnStage}
          data-status={job.status}
        >
          <span className="desk-strip-pic">{media(job, { thumb: true })}</span>
          <span className="flex min-w-0 items-center gap-1.5 px-1.5 py-1">
            <span aria-hidden className="ns-lamp" data-tone={sv.tone} data-live={sv.live ? "true" : undefined} />
            <span className="min-w-0 truncate text-[11px] text-[var(--color-fg)]">{prompt ? truncate(prompt, 40) : kindLabel(t, job.capability)}</span>
          </span>
          <span className="sr-only">
            {sv.label}. {t.desk.showOnStage}
          </span>
        </button>
      </li>
    );
  }

  /** A take: the state, the words it spoke or the recording it changed, a player once it is ready. */
  function take(job: StudioJob, n: number): ReactNode {
    const sv = statusView(t, job.status);
    const { prompt, done, href, preview } = look(job);
    const src = done ? (href ?? preview?.viewUrl ?? null) : null;
    return (
      <li key={job.id} className="desk-take" data-status={job.status}>
        <span aria-hidden className="desk-take-no ns-tc">
          {String(n).padStart(2, "0")}
        </span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[13px] font-semibold text-[var(--color-fg)]">{kindLabel(t, job.capability)}</span>
            <StatusLamp tone={sv.tone} label={sv.label} live={sv.live} />
            {since(job)}
          </div>
          {prompt && <p className="studio-clamp-2 break-words text-[13px] leading-snug text-[var(--color-fg)]">{truncate(prompt, 200)}</p>}
          {src ? (
            <audio controls preload="none" src={src} className="desk-take-audio" aria-label={fmt(t.desk.playTake, { n })} />
          ) : done ? (
            <Link href={path("/library")} className="tap-link w-fit text-[12px] text-[var(--color-primary)] underline">
              {t.gen.openLibrary}
            </Link>
          ) : null}
          {facts(job)}
        </div>
        {done && job.result_asset_ids[0] && (
          <div className="desk-take-side">
            <SendToEditor orgId={orgId} assetId={job.result_asset_ids[0]} kind="audio" variant="icon" className={onMedia} />
          </div>
        )}
      </li>
    );
  }

  /** The overview's row: what, which desk, its state and credits, and a way to its desk. */
  function logRow(job: StudioJob): ReactNode {
    const sv = statusView(t, job.status);
    const { prompt, Icon } = look(job);
    const desk = isStudioCapability(job.capability) ? deskFor(job.capability) : null;
    return (
      <li key={job.id} className="desk-log-row" data-status={job.status}>
        <span className="desk-log-pic">{media(job, { thumb: true })}</span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-[var(--color-fg)]">
            <Icon aria-hidden className="size-3.5 shrink-0 text-[var(--color-muted)]" strokeWidth={1.75} />
            <span className="truncate">{kindLabel(t, job.capability)}</span>
          </span>
          {prompt && <span className="truncate text-[12px] text-[var(--color-muted)]">{truncate(prompt, 90)}</span>}
          {isUnsuccessful(job.status) && <span className="text-[12px] text-[var(--color-muted)]">{failureReason(t, job)}</span>}
        </span>
        <span className="desk-log-state">
          <StatusLamp tone={sv.tone} label={sv.label} live={sv.live} />
          <span className="mono text-[11px] text-[var(--color-muted)]">{creditsLine(t, job, locale)}</span>
        </span>
        {desk && (
          <Link href={path(deskHref(desk))} className="desk-log-go" aria-label={fmt(t.desk.openOnDesk, { desk: t.desk.names[desk] })}>
            <span className="hidden sm:inline">{t.desk.names[desk]}</span>
            <ArrowUpRight aria-hidden className="size-4" />
          </Link>
        )}
      </li>
    );
  }

  const heading = title ?? t.gen.feedTitle;
  const loading = jobs === null;
  const empty = jobs !== null && shown.length === 0 && state === "ok";
  const rest = featured ? shown.filter((j) => j.id !== featured.id) : shown;

  return (
    <section className="@container flex min-w-0 flex-col gap-3" aria-labelledby="gen-feed-title" data-variant={variant}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="gen-feed-title" className="ns-eyebrow">
          {heading}
        </h2>
        {active && (
          <span className="text-[12px] text-[var(--color-muted)]" aria-live="polite">
            {t.gen.working}
          </span>
        )}
      </div>

      {state === "unavailable" ? (
        <p className="studio-field p-4 text-[13px] text-[var(--color-muted)]">{t.gen.unavailable}</p>
      ) : (
        <>
          {state === "failed" && <p className="text-[12px] text-[var(--color-warn)]">{t.gen.loadFailed}</p>}
          {loading &&
            (variant === "takes" || variant === "log" ? (
              <div className="flex flex-col gap-2" aria-busy="true" aria-label={t.gen.feedLoading}>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton h-16 w-full rounded-[var(--ns-r-key)]" />
                ))}
              </div>
            ) : (
              <ContactSheet label={t.gen.feedLoading} min={200} ragged>
                {["16 / 9", "1 / 1", "9 / 16", "16 / 9"].map((a, i) => (
                  <Frame key={i} aspect={a} aria-busy="true">
                    <div className="skeleton h-full w-full rounded-none" />
                  </Frame>
                ))}
              </ContactSheet>
            ))}
          {empty && (
            <div className="desk-empty" data-variant={variant}>
              <span aria-hidden className="desk-empty-mark">
                <Clapperboard className="size-6" strokeWidth={1.75} />
              </span>
              <p className="text-[15px] font-semibold text-[var(--color-fg)]">{emptyTitle ?? t.gen.emptyTitle}</p>
              <p className="max-w-[52ch] text-[13px] text-[var(--color-muted)]">{emptyBody ?? t.gen.empty}</p>
            </div>
          )}
          {shown.length > 0 && variant === "sheet" && (
            <ContactSheet label={heading} min={200} ragged>
              {shown.map(card)}
            </ContactSheet>
          )}
          {shown.length > 0 && variant === "monitor" && (
            <>
              {stage(featured)}
              {shown.length > 1 && (
                <ul className="desk-strip" aria-label={t.desk.stripLabel}>
                  {shown.map(stripFrame)}
                </ul>
              )}
            </>
          )}
          {shown.length > 0 && variant === "table" && (
            <>
              {stage(featured)}
              {rest.length > 0 && (
                <ContactSheet label={heading} min={200} ragged>
                  {rest.map(card)}
                </ContactSheet>
              )}
            </>
          )}
          {shown.length > 0 && variant === "takes" && <ol className="flex flex-col gap-2">{shown.map((j, i) => take(j, shown.length - i))}</ol>}
          {shown.length > 0 && variant === "log" && <ol className="desk-log">{shown.map(logRow)}</ol>}
        </>
      )}
    </section>
  );
}
