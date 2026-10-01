"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AudioLines, ExternalLink, FolderOpen, ImagePlus, Play, Sparkles, TriangleAlert } from "lucide-react";
import { StatusPill } from "@/components/ui";
import { BeforeAfter } from "@/components/studio/BeforeAfter";
import { TOOL_ICONS } from "@/components/studio/toolIcons";
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
  failureReason,
  isActiveStatus,
  isStudioCapability,
  isUnsuccessful,
  kindLabel,
  outputKind,
  prefillFromJob,
  readDismissed,
  resultHref,
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
 * fills the form.
 */
export function JobFeed({
  orgId,
  models = [],
  refreshKey = 0,
  onRetry,
  onUseAsSource,
}: {
  orgId: string;
  models?: StudioModel[];
  /** Bumped by the panel after a job is created: reload now. */
  refreshKey?: number;
  onRetry?: (prefill: StudioPrefill) => void;
  /** A finished picture's library id, for the composer's picture tools. */
  onUseAsSource?: (assetId: string) => void;
}) {
  const { t, locale } = useI18n();
  const path = useChannelPath();
  const [jobs, setJobs] = useState<StudioJob[] | null>(null);
  const [state, setState] = useState<"ok" | "failed" | "unavailable">("ok");
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<{ id: string; code: CreativeError } | null>(null);
  const seq = useRef(0);

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
  const libraryKey = [...[...pairs.values()].map((p) => p.after), ...results].join(",");
  const library = useLibraryImages(orgId, { enabled: libraryKey !== "", key: libraryKey });
  const pictures = new Map(library.images.map((i) => [i.id, i.viewUrl ?? i.thumbUrl]));
  const chip = "studio-chip tap";
  // Round icon buttons on the picture: named for screen readers and on hover.
  const onMedia = "studio-on-media tap-icon press grid size-9 place-items-center rounded-full";

  return (
    <section className="@container flex min-w-0 flex-col gap-3" aria-labelledby="gen-feed-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="gen-feed-title" className="text-[15px] font-semibold text-[var(--color-fg)]">
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
            <div className="columns-2 gap-3 @lg:columns-3 @4xl:columns-4" aria-busy="true" aria-label={t.gen.feedLoading}>
              {["16 / 9", "1 / 1", "9 / 16", "16 / 9"].map((a, i) => (
                <div key={i} className="skeleton mb-3 w-full rounded-[16px]" style={{ aspectRatio: a }} />
              ))}
            </div>
          )}
          {jobs !== null && shown.length === 0 && state === "ok" && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-[20px] border border-dashed border-[var(--color-border)] bg-[var(--studio-canvas)] px-6 py-16 text-center">
              <span
                aria-hidden
                className="grid size-12 place-items-center rounded-[14px] bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)] text-[var(--color-primary)]"
              >
                <Sparkles className="size-6" strokeWidth={1.75} />
              </span>
              <p className="text-[15px] font-semibold text-[var(--color-fg)]">{t.gen.emptyTitle}</p>
              <p className="max-w-[44ch] text-[13px] text-[var(--color-muted)]">{t.gen.empty}</p>
            </div>
          )}
          {shown.length > 0 && (
            <ul className="columns-2 gap-3 @lg:columns-3 @4xl:columns-4">
              {shown.map((job) => {
                const sv = statusView(t, job.status);
                const prompt = typeof job.params.prompt === "string" ? job.params.prompt : "";
                const done = job.status === "completed";
                const href = done ? resultHref(job) : null;
                const retry = isUnsuccessful(job.status) ? prefillFromJob(job) : null;
                const asSource = done && onUseAsSource ? sourceFromJob(job) : null;
                const pair = pairs.get(job.id);
                const before = pair ? pictures.get(pair.before) : null;
                const after = pair ? pictures.get(pair.after) : null;
                const kind = outputKind(job.capability);
                const preview = done && job.result_asset_ids[0] ? library.previews.get(job.result_asset_ids[0]) : undefined;
                const alt = prompt ? truncate(prompt, 80) : kindLabel(t, job.capability);
                const Icon = isStudioCapability(job.capability) ? TOOL_ICONS[job.capability] : Sparkles;

                let media: ReactNode;
                if (before && after) {
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
                      <span aria-hidden className="studio-on-media absolute left-1/2 top-1/2 grid size-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full">
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
                        <Sparkles aria-hidden className="pulse size-6 text-[var(--color-primary)]" strokeWidth={1.5} />
                      ) : kind === "audio" ? (
                        <AudioLines aria-hidden className="size-7" strokeWidth={1.5} />
                      ) : (
                        <Icon aria-hidden className="size-6" strokeWidth={1.5} />
                      )}
                    </span>
                  );
                }

                return (
                  <li
                    key={job.id}
                    className="studio-card mb-3 flex break-inside-avoid flex-col overflow-hidden rounded-[16px] border border-[var(--color-border)] bg-[var(--color-panel)]"
                    data-status={job.status}
                  >
                    <div
                      className="relative overflow-hidden bg-[var(--studio-field)]"
                      style={before && after ? undefined : { aspectRatio: cardAspect(job) }}
                    >
                      {media}
                      {done && (
                        <div className="studio-card-actions absolute bottom-2 right-2 z-10 flex gap-1.5">
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
                    </div>

                    <div className="flex flex-col gap-1.5 p-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-[12px] font-semibold text-[var(--color-fg)]">{kindLabel(t, job.capability)}</span>
                        <span className="ml-auto shrink-0">
                          <StatusPill tone={sv.tone} label={sv.label} live={sv.live} />
                        </span>
                      </div>
                      {prompt && <p className="studio-clamp-2 break-words text-[13px] leading-snug text-[var(--color-fg)]">{truncate(prompt)}</p>}
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
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
