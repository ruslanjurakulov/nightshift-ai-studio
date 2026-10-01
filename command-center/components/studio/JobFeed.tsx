"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AudioLines, Check, Clapperboard, Copy, CopyPlus, ExternalLink, FolderOpen, ImagePlus, Play, ScanText, TriangleAlert, type LucideIcon } from "lucide-react";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { ContactSheet, Frame } from "@/components/ui/ContactSheet";
import { BeforeAfter } from "@/components/studio/BeforeAfter";
import { TOOL_ICONS } from "@/components/studio/toolIcons";
import { SendToEditor, isSendKind } from "@/components/editor/SendToEditor";
import { useLibraryImages } from "@/components/studio/useLibraryImages";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import type { CreativeError } from "@/lib/creative/operations";
import {
  addDismissed,
  apiErrorMessage,
  asCreativeError,
  cardAspect,
  coerceJobs,
  compareSources,
  creditsLine,
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
 */
export function JobFeed({
  orgId,
  models = [],
  refreshKey = 0,
  onRetry,
  onUseAsSource,
  onDescribe,
  onMakeSimilar,
}: {
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
}) {
  const { t, locale } = useI18n();
  const path = useChannelPath();
  const [jobs, setJobs] = useState<StudioJob[] | null>(null);
  const [state, setState] = useState<"ok" | "failed" | "unavailable">("ok");
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<{ id: string; code: CreativeError } | null>(null);
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null);
  const seq = useRef(0);

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
      const res = await fetch(`/api/creative/jobs?org_id=${encodeURIComponent(orgId)}`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { jobs?: unknown; error?: unknown };
      if (mine !== seq.current) return;
      if (res.ok) {
        setJobs(coerceJobs(body.jobs));
        setState("ok");
      } else {
        setState(body.error === "creative_unavailable" ? "unavailable" : "failed");
        setJobs((j) => j ?? []);
      }
    } catch {
      if (mine !== seq.current) return;
      setState("failed");
      setJobs((j) => j ?? []);
    }
  }, [orgId]);

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
  const shown = (jobs ?? []).filter((j) => !dismissed.includes(j.id)).slice(0, FEED_SHOWN);
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

  return (
    <section className="@container flex min-w-0 flex-col gap-3" aria-labelledby="gen-feed-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="gen-feed-title" className="ns-eyebrow">
          {t.gen.feedTitle}
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
          {jobs === null && (
            <ContactSheet label={t.gen.feedLoading} min={200} ragged>
              {["16 / 9", "1 / 1", "9 / 16", "16 / 9"].map((a, i) => (
                <Frame key={i} aspect={a} aria-busy="true">
                  <div className="skeleton h-full w-full rounded-none" />
                </Frame>
              ))}
            </ContactSheet>
          )}
          {jobs !== null && shown.length === 0 && state === "ok" && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--ns-r-panel)] border border-dashed border-[var(--ns-rule-strong)] bg-[var(--studio-canvas)] px-6 py-16 text-center">
              <span
                aria-hidden
                className="grid size-12 place-items-center rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] text-[var(--color-muted)]"
              >
                <Clapperboard className="size-6" strokeWidth={1.75} />
              </span>
              <p className="text-[15px] font-semibold text-[var(--color-fg)]">{t.gen.emptyTitle}</p>
              <p className="max-w-[44ch] text-[13px] text-[var(--color-muted)]">{t.gen.empty}</p>
            </div>
          )}
          {shown.length > 0 && (
            <ContactSheet label={t.gen.feedTitle} min={200} ragged>
              {shown.map((job) => {
                const sv = statusView(t, job.status);
                const prompt = typeof job.params.prompt === "string" ? job.params.prompt : "";
                const done = job.status === "completed";
                const href = done ? resultHref(job) : null;
                const retry = isUnsuccessful(job.status) ? prefillFromJob(job) : null;
                const asSource = done && onUseAsSource ? sourceFromJob(job) : null;
                const toDescribe = done && onDescribe ? sourceFromJob(job) : null;
                const description = describeResult(job);
                const describedPic =
                  job.capability === "describe" && typeof job.params.source_asset_id === "string"
                    ? library.previews.get(job.params.source_asset_id)
                    : undefined;
                const pair = pairs.get(job.id);
                const before = pair ? pictures.get(pair.before) : null;
                const after = pair ? pictures.get(pair.after) : null;
                const kind = outputKind(job.capability);
                const preview = done && job.result_asset_ids[0] ? library.previews.get(job.result_asset_ids[0]) : undefined;
                const alt = prompt ? truncate(prompt, 80) : kindLabel(t, job.capability);
                const Icon: LucideIcon = isStudioCapability(job.capability) ? TOOL_ICONS[job.capability] : Clapperboard;

                let media: ReactNode;
                if (kind === "text" && (describedPic?.thumbUrl || describedPic?.viewUrl)) {
                  media = (
                    // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived library links
                    <img
                      src={(describedPic.thumbUrl ?? describedPic.viewUrl) as string}
                      alt={t.gen.describedPicture}
                      loading="lazy"
                      className={`h-full w-full object-cover${isActiveStatus(job.status) ? " opacity-60" : ""}`}
                    />
                  );
                } else if (before && after) {
                  media = <BeforeAfter bare before={before} after={after} alt={kindLabel(t, job.capability)} />;
                } else if (done && kind === "image" && (preview?.thumbUrl || preview?.viewUrl || href)) {
                  media = (
                    // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived library links
                    <img
                      src={(preview?.thumbUrl ?? preview?.viewUrl ?? href) as string}
                      alt={alt}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  );
                } else if (done && kind === "video" && (preview?.thumbUrl || href)) {
                  media = preview?.thumbUrl ? (
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
                } else {
                  media = (
                    <span
                      className={`flex h-full w-full flex-col items-center justify-center gap-2 text-[var(--color-muted)]${isActiveStatus(job.status) ? " skeleton rounded-none" : ""}`}
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
                        {description && (
                          <div className="flex flex-col gap-2">
                            <p className="sr-only">{t.gen.descriptionLabel}</p>
                            <p
                              lang={description.language}
                              className="select-text whitespace-pre-wrap break-words rounded-[10px] bg-[var(--studio-field)] p-2.5 text-[13px] leading-relaxed text-[var(--color-fg)]"
                              data-testid="describe-text"
                            >
                              {description.text}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <button type="button" className={`${chip} gap-1.5`} onClick={() => void copy(job.id, description.text)}>
                                {copied?.id === job.id && copied.ok ? (
                                  <Check aria-hidden className="size-3.5" />
                                ) : (
                                  <Copy aria-hidden className="size-3.5" />
                                )}
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
                              {copied?.id === job.id && !copied.ok && (
                                <span className="text-[var(--color-warn)]">{t.gen.copyFailed}</span>
                              )}
                            </p>
                          </div>
                        )}
                        {job.capability === "dub" && isDubLanguage(job.params.target_language) && (
                          <p className="text-[13px] leading-snug text-[var(--color-fg)]" lang={job.params.target_language}>
                            → {t.gen.languages[job.params.target_language]}
                          </p>
                        )}
                        <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[11px] text-[var(--color-muted)]">
                          <span className="min-w-0 truncate">{names.get(job.requested_model) ?? job.requested_model}</span>
                          <span aria-hidden>·</span>
                          <span className="mono">{creditsLine(t, job, locale)}</span>
                        </p>
                        {isUnsuccessful(job.status) && (
                          <p className="text-[12px] text-[var(--color-muted)]">
                            {failureReason(t, job)} {t.gen.returnedNote}
                          </p>
                        )}
                        {cancelError?.id === job.id && (
                          <p className="text-[12px] text-[var(--color-fail)]">{apiErrorMessage(t, cancelError.code)}</p>
                        )}
                        {(job.status === "queued" || retry || isUnsuccessful(job.status)) && (
                          <div className="flex flex-wrap gap-2 pt-1">
                            {job.status === "queued" && (
                              <button
                                type="button"
                                className={chip}
                                disabled={cancelling === job.id}
                                onClick={() => void cancel(job.id)}
                              >
                                {cancelling === job.id ? t.gen.cancelling : t.gen.cancel}
                              </button>
                            )}
                            {retry && onRetry && (
                              <button type="button" className={chip} onClick={() => onRetry(retry)}>
                                {t.gen.tryAgain}
                              </button>
                            )}
                            {isUnsuccessful(job.status) && (
                              <button
                                type="button"
                                className={chip}
                                onClick={() => setDismissed(addDismissed(job.id, dismissed))}
                              >
                                {t.gen.dismiss}
                              </button>
                            )}
                          </div>
                        )}
                    
                      </div>
                    }
                  >
                      {media}
                      {done && kind !== "text" && (
                        <div className="studio-card-actions absolute bottom-2 right-2 z-10 flex gap-1.5">
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
                      )}
                  </Frame>
                );
              })}
            </ContactSheet>
          )}
        </>
      )}
    </section>
  );
}
