"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Clapperboard, ImagePlus, Mic, ScanText, Scissors, Wand2, ZoomIn, type LucideIcon } from "lucide-react";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { useLibraryImages } from "@/components/studio/useLibraryImages";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { coerceJobs, kindLabel, statusView, truncate, type StudioJob } from "@/lib/creative/studio";
import { toolHref } from "@/lib/home";

const SHOWN = 8;

export const KIND_ICON: Record<string, LucideIcon> = {
  t2i: ImagePlus,
  t2v: Clapperboard,
  i2v: Clapperboard,
  tts: Mic,
  edit: Wand2,
  upscale: ZoomIn,
  remove_bg: Scissors,
  describe: ScanText,
};

/**
 * The organization's newest generations, compact: the same read as the
 * Studio's feed (GET /api/creative/jobs, RLS: members), once, without its
 * controls — cancelling and retrying stay in the Studio, one tap away. A
 * finished picture shows itself when the library still holds it.
 */
export function RecentStrip({ orgId }: { orgId: string | null }) {
  const { t } = useI18n();
  const path = useChannelPath();
  const [jobs, setJobs] = useState<StudioJob[] | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "failed" | "unavailable">(orgId ? "loading" : "unavailable");

  useEffect(() => {
    if (!orgId) return;
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/creative/jobs?org_id=${encodeURIComponent(orgId)}`, { cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { jobs?: unknown; error?: unknown };
        if (!live) return;
        if (res.ok) {
          setJobs(coerceJobs(body.jobs).slice(0, SHOWN));
          setState("ok");
        } else setState(body.error === "creative_unavailable" ? "unavailable" : "failed");
      } catch {
        if (live) setState("failed");
      }
    })();
    return () => {
      live = false;
    };
  }, [orgId]);

  const pictures = (jobs ?? []).filter((j) => j.status === "completed" && j.result_asset_ids.length > 0);
  const library = useLibraryImages(orgId ?? "", { enabled: Boolean(orgId) && pictures.length > 0, key: pictures.map((j) => j.id).join(",") });
  const thumbs = new Map(library.images.map((i) => [i.id, i.thumbUrl ?? i.viewUrl ?? null]));

  return (
    <section aria-labelledby="home-recent" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="home-recent" className="t-panel">
          {t.home.recentTitle}
        </h2>
        <Link href={path("/create")} className="tap-link text-[13px] text-[var(--color-primary)] hover:underline">
          {t.home.recentAll}
        </Link>
      </div>

      {state === "loading" && (
        <div className="flex gap-3 overflow-hidden" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-[148px] w-[180px] shrink-0 rounded-[var(--ns-r-panel)]" />
          ))}
        </div>
      )}
      {state === "failed" && <p className="text-[13px] text-[var(--color-warn)]">{t.home.recentFailed}</p>}
      {state === "unavailable" && <p className="text-[13px] text-[var(--color-muted)]">{t.home.recentUnavailable}</p>}

      {state === "ok" && jobs && jobs.length === 0 && (
        <div className="flex flex-col items-start gap-3 rounded-[var(--ns-r-panel)] border border-dashed border-[var(--color-border)] p-5 sm:flex-row sm:items-center">
          <span
            aria-hidden
            className="grid size-11 shrink-0 place-items-center rounded-[var(--ns-r-panel)] bg-[var(--color-panel-2)] text-[var(--color-primary)]"
          >
            <ImagePlus className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-[var(--color-fg)]">{t.home.recentEmptyTitle}</p>
            <p className="text-[13px] text-[var(--color-muted)]">{t.home.recentEmptyBody}</p>
          </div>
          <Link href={path(toolHref("t2i"))} className="btn-quiet text-[13px]">
            {t.home.recentEmptyCta}
          </Link>
        </div>
      )}

      {state === "ok" && jobs && jobs.length > 0 && (
        <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
          {jobs.map((job) => {
            const sv = statusView(t, job.status);
            const Icon = KIND_ICON[job.capability] ?? ImagePlus;
            const thumb = job.status === "completed" ? thumbs.get(job.result_asset_ids[0] ?? "") ?? null : null;
            const prompt = typeof job.params.prompt === "string" ? job.params.prompt : "";
            return (
              <li key={job.id} className="w-[180px] shrink-0 snap-start" data-status={job.status}>
                <Link
                  href={path("/create")}
                  className="flex h-full flex-col overflow-hidden rounded-[var(--ns-r-panel)] border border-[var(--color-border)] bg-[var(--color-panel)] transition-colors hover:border-[color-mix(in_srgb,var(--color-primary)_40%,var(--color-border))]"
                >
                  <div className="relative grid aspect-[16/10] place-items-center bg-[var(--color-panel-2)] text-[var(--color-muted)]">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a signed library URL, not a static asset
                      <img src={thumb} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
                    ) : (
                      <Icon aria-hidden className="size-6" />
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5 p-2.5">
                    <span className="truncate text-[12px] font-medium text-[var(--color-fg)]">{kindLabel(t, job.capability)}</span>
                    <StatusLamp tone={sv.tone} label={sv.label} live={sv.live} />
                    {prompt && <p className="line-clamp-2 text-[12px] leading-snug text-[var(--color-muted)]">{truncate(prompt, 80)}</p>}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
