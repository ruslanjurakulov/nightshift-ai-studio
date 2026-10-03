"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Check,
  CalendarClock,
  Clapperboard,
  Film,
  ImagePlus,
  Inbox,
  Mic,
  Plus,
  Scissors,
  Wand2,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { QUICK_ACTIONS, toolHref, type HomeChannel, type HomeVideo, type QuickActionId } from "@/lib/home";
import { HomeComposer, type ComposerChannel, type ComposerHandle } from "@/components/home/HomeComposer";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { Timecode } from "@/components/ui/Timecode";
import { RecentStrip } from "@/components/home/RecentStrip";
import { AssistantPlanner } from "@/components/assistant/AssistantPlanner";
import type { StudioModel } from "@/lib/creative/studio";
import "@/components/create/flow.css";

const QUICK_ICON: Record<QuickActionId, LucideIcon> = {
  image: ImagePlus,
  video: Clapperboard,
  voice: Mic,
  edit: Wand2,
  upscale: ZoomIn,
  cutout: Scissors,
};

/**
 * Home ("Bosh sahifa"): a calm "what next" page.
 *
 * One primary thing: the guided card sequence for the next video (`run`, the
 * same CreateStudio the Create page shows, so it shows its price and asks once
 * before anything starts). Above it, only what needs a decision, in plain
 * words. Below it, the person's videos as cards and the other things Nightshift
 * makes, one line each. Nothing on this screen starts, prices or spends
 * anything by itself: the tiles only open forms, and the run form asks first.
 *
 * Without `run` (no channel to make it for, or a hand-off only) the older
 * composer stays: it only links to the run form with the topic filled in.
 */
export function HomeHub({
  channels,
  currentSlug,
  orgId,
  allPrivate,
  assistant,
  run,
  videos = null,
}: {
  channels: HomeChannel[];
  /** The channel in the URL — the composer's first choice. */
  currentSlug: string | null;
  /** The open organization, for the recent generations; null without one. */
  orgId: string | null;
  /** True when every connected channel keeps videos private until approved. */
  allPrivate: boolean;
  /**
   * The Assistant: one goal → a priced plan → one confirm. Absent: not shown.
   * It prices only once a plan is made and spends nothing before Start.
   */
  assistant?: { models: StudioModel[]; canRun: boolean; runConfigured: boolean };
  /** The guided create flow for the channel in view (server-rendered by the page). */
  run?: ReactNode;
  /** The newest videos across the channels; null = the read failed or was not made. */
  videos?: HomeVideo[] | null;
}) {
  const { t } = useI18n();
  const path = useChannelPath();
  const composer = useRef<ComposerHandle>(null);
  const runnable: ComposerChannel[] = channels
    .filter((c) => c.standing !== "draft")
    .map((c) => ({ slug: c.slug, name: c.name, autoPublish: c.autoPublish }));
  const plannerChannels = useMemo(
    () =>
      channels
        .filter((c) => c.standing !== "draft")
        .map((c) => ({ id: c.id, slug: c.slug, name: c.name, language: c.language })),
    [channels],
  );

  // What needs the person, in plain words: finished videos waiting for them, clips being made.
  const waiting = channels.reduce((n, c) => n + (c.waiting ?? 0), 0);
  const target = channels.find((c) => c.slug === currentSlug && c.standing !== "draft") ?? channels.find((c) => c.standing !== "draft");

  return (
    <div className="flex flex-col gap-8 sm:gap-10">
      {/* ── The one thing to do ───────────────────────────────────────── */}
      <section aria-labelledby="home-hero" className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h1 id="home-hero" className="text-3xl font-semibold leading-[1.2] tracking-[-0.02em] text-[var(--color-fg)] sm:text-4xl">
            {t.home.heroTitle}
          </h1>
          <p className="max-w-[60ch] text-base leading-relaxed text-[var(--color-muted)]">{t.home.heroLead}</p>
        </div>

        {waiting > 0 && (
          <div className="flex flex-col gap-3" data-testid="home-status">
            {waiting > 0 && (
              <div className="fl-card sm:!flex-row sm:items-center sm:justify-between" data-tone="waiting">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-lg font-semibold leading-snug text-[var(--color-fg)]">
                    {waiting === 1 ? t.home.waitingOne : fmt(t.home.waitingMany, { n: waiting })}
                  </p>
                  <p className="fl-hint">{t.home.waitingBody}</p>
                </div>
                <Link href={path("/videos")} className="btn-quiet shrink-0 sm:self-center">
                  {t.home.reviewNow}
                </Link>
              </div>
            )}
          </div>
        )}

        {run ? (
          <div className="flex flex-col gap-3">
            {target && channels.filter((c) => c.standing !== "draft").length > 1 && (
              <p className="px-1 text-sm text-[var(--color-muted)]">{fmt(t.home.forChannel, { name: target.name })}</p>
            )}
            {run}
            <ul className="flex flex-wrap gap-x-5 gap-y-2 px-1 text-sm text-[var(--color-muted)]">
              {[t.home.promisePrice, t.home.promiseRefund, allPrivate ? t.home.promisePrivate : t.home.promiseGate].map((p) => (
                <li key={p} className="flex items-center gap-1.5">
                  <Check aria-hidden className="size-3.5 text-[var(--color-ok)]" />
                  {p}
                </li>
              ))}
            </ul>
          </div>
        ) : runnable.length === 0 ? (
          <div className="fl-card items-start">
            <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-[var(--ns-r-panel)] bg-[var(--color-panel-2)] text-[var(--color-primary)]">
              <Film className="size-5" />
            </span>
            <div className="flex flex-col gap-1">
              <h2 className="fl-q">{t.home.noChannelsTitle}</h2>
              <p className="text-base text-[var(--color-muted)]">{t.home.noChannel}</p>
            </div>
            <Link href={path("/channels/new")} className="studio-cta fl-go sm:!w-auto sm:px-8">
              <Plus aria-hidden className="size-4" />
              {t.home.connect}
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <HomeComposer ref={composer} channels={runnable} currentSlug={currentSlug} />
            <ul className="flex flex-wrap gap-x-5 gap-y-2 px-1 text-sm text-[var(--color-muted)]">
              {[t.home.promisePrice, t.home.promiseRefund, allPrivate ? t.home.promisePrivate : t.home.promiseGate].map((p) => (
                <li key={p} className="flex items-center gap-1.5">
                  <Check aria-hidden className="size-3.5 text-[var(--color-ok)]" />
                  {p}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ── Your videos, as cards ─────────────────────────────────────── */}
      {channels.length > 0 && videos !== null && (
        <section aria-labelledby="home-videos" className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="home-videos" className="fl-q">
              {t.home.videosTitle}
            </h2>
            {videos.length > 0 && (
              <Link href={path("/videos")} className="tap-link inline-flex min-h-11 min-w-11 items-center justify-end text-sm text-[var(--color-primary)] hover:underline">
                {t.home.videosAll}
              </Link>
            )}
          </div>
          {videos.length === 0 ? (
            <p className="fl-card fl-hint">{t.home.videosEmpty}</p>
          ) : (
            <ul className="home-cards">
              {videos.map((v) => (
                <li key={`${v.slug}:${v.id}`}>
                  <Link href={`/${encodeURIComponent(v.slug)}/videos/${encodeURIComponent(v.id)}`} className="fl-card home-video press" data-state={v.state}>
                    <span className="home-video-title">{v.title || "—"}</span>
                    <StatusLamp tone={v.state === "waiting" ? "warn" : "ok"} label={t.home.videoState[v.state]} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ── The other things Nightshift makes, one line each ───────────── */}
      <section aria-labelledby="home-quick" className="flex flex-col gap-3">
        <h2 id="home-quick" className="fl-q">
          {t.home.quickTitle}
        </h2>
        <ul className="home-quick">
          {QUICK_ACTIONS.map((a) => {
            const Icon = QUICK_ICON[a.id];
            return (
              <li key={a.id}>
                <Link href={path(toolHref(a.tool))} className="home-quick-link press">
                  <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-[var(--ns-r-key)] bg-[var(--ns-key)] text-[var(--color-muted)]">
                    <Icon className="size-[18px]" strokeWidth={1.75} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-base font-medium leading-snug text-[var(--color-fg)]">{t.home.quick[a.id].title}</span>
                    <span className="text-sm leading-snug text-[var(--color-muted)]">{t.home.quick[a.id].sub}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <RecentStrip orgId={orgId} />

      {/* ── Your channels ─────────────────────────────────────────────── */}
      {channels.length > 0 && (
        <section aria-labelledby="home-channels" className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 id="home-channels" className="fl-q">
                {t.home.channelsTitle}
              </h2>
              <p className="text-sm text-[var(--color-muted)]">{t.home.channelsHint}</p>
            </div>
            <Link href={path("/channels/new")} className="tap-link shrink-0 text-sm text-[var(--color-primary)] hover:underline">
              {t.home.addChannel}
            </Link>
          </div>
          <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
            {channels.map((c) => (
              <ChannelCard key={c.id} c={c} />
            ))}
          </ul>
        </section>
      )}

      {assistant && (
        <details className="fl-more home-assistant">
          <summary>{t.home.assistantMore}</summary>
          <div className="pt-3">
            <AssistantPlanner
              orgId={orgId}
              models={assistant.models}
              channels={plannerChannels}
              currentSlug={currentSlug}
              canRun={assistant.canRun}
              runConfigured={assistant.runConfigured}
            />
          </div>
        </details>
      )}
    </div>
  );
}

function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

/** "2 d ago", from the dictionary: Intl has no Uzbek relative wording. */
function ago(iso: string, t: Dictionary): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 60) return fmt(t.home.agoMinutes, { n: min });
  if (min < 60 * 24) return fmt(t.home.agoHours, { n: Math.round(min / 60) });
  return fmt(t.home.agoDays, { n: Math.round(min / (60 * 24)) });
}

/** The next run on the viewer's own clock: "Today 20:00" / "Tomorrow 09:00". */
function when(iso: string, t: Dictionary): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  return fmt(d.toDateString() === today.toDateString() ? t.home.today : t.home.tomorrow, { time });
}

const STANDING_TONE = {
  live: "ok",
  paused: "warn",
  draft: "idle",
} as const;

function ChannelCard({ c }: { c: HomeChannel }) {
  const { t } = useI18n();
  const path = useChannelPath();
  const mounted = useMounted();
  const at = (section: string) => `/${encodeURIComponent(c.slug)}${section}`;
  const initial = (c.name.trim()[0] ?? "?").toUpperCase();

  return (
    <li className="w-[272px] shrink-0 snap-start sm:w-[300px]" data-channel={c.slug}>
      <div className="fl-card h-full !gap-3">
        <div className="flex items-center gap-3">
          {c.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element -- the channel's public YouTube avatar
            <img src={c.avatar} alt="" width={40} height={40} className="size-10 shrink-0 rounded-[var(--ns-r-key)] object-cover" />
          ) : (
            <span
              aria-hidden
              className="grid size-10 shrink-0 place-items-center rounded-[var(--ns-r-key)] bg-[var(--ns-key)] font-display text-[18px] font-bold text-[var(--color-fg)]"
            >
              {initial}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-[var(--color-fg)]">{c.name}</p>
            <p className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
              <StatusLamp tone={STANDING_TONE[c.standing]} label={t.home.standing[c.standing]} />
              {c.language && <span className="truncate">· {c.language}</span>}
            </p>
          </div>
        </div>

        {c.lastVideo?.title && (
          <p className="line-clamp-2 text-sm leading-snug text-[var(--color-fg)]" title={c.lastVideo.title}>
            {c.lastVideo.title}
          </p>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className="flex items-center gap-1.5 text-[var(--color-muted)]">
            <Film aria-hidden className="size-3.5" />
            {t.home.lastVideo}
          </dt>
          <dd className="min-w-0 truncate text-right text-[var(--color-fg)]">
            {c.lastVideo ? (
              <span>{c.lastVideo.at ? (mounted ? ago(c.lastVideo.at, t) : "…") : "—"}</span>
            ) : (
              <span className="text-[var(--color-muted)]">{t.home.noVideo}</span>
            )}
          </dd>
          <dt className="flex items-center gap-1.5 text-[var(--color-muted)]">
            <CalendarClock aria-hidden className="size-3.5" />
            {t.home.nextRun}
          </dt>
          <dd className="min-w-0 truncate text-right text-[var(--color-fg)]">
            {c.nextRun ? (mounted ? when(c.nextRun, t) : "…") : <span className="text-[var(--color-muted)]">{t.home.noSchedule}</span>}
          </dd>
          <dt className="flex items-center gap-1.5 text-[var(--color-muted)]">
            <Inbox aria-hidden className="size-3.5" />
            {t.home.waiting}
          </dt>
          <dd className="text-right">
            {c.waiting === null ? (
              <span className="text-[var(--color-muted)]">{t.home.waitingUnknown}</span>
            ) : (
              <span
                className="tnum font-semibold"
                style={{ color: c.waiting > 0 ? "var(--color-warn)" : "var(--color-muted)" }}
                data-testid="waiting"
              >
                <Timecode value={c.waiting} format="count" />
              </span>
            )}
          </dd>
        </dl>

        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="truncate text-xs text-[var(--color-muted)]">{c.autoPublish ? t.home.autoOn : t.home.autoOff}</span>
          {c.standing === "draft" ? (
            <Link href={path("/channels")} className="tap-link inline-flex shrink-0 items-center gap-1 text-xs text-[var(--color-primary)] hover:underline">
              {t.home.connect}
              <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
          ) : (
            <Link href={at("/videos")} className="tap-link inline-flex shrink-0 items-center gap-1 text-xs text-[var(--color-primary)] hover:underline">
              {t.home.review}
              <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}
