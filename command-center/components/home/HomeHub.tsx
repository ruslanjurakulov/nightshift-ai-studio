"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronRight,
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
import { HOME_FORMATS, QUICK_ACTIONS, toolHref, type HomeChannel, type QuickActionId } from "@/lib/home";
import { HomeComposer, type ComposerChannel, type ComposerHandle } from "@/components/home/HomeComposer";
import { FormatArt } from "@/components/home/FormatArt";
import { RecentStrip } from "@/components/home/RecentStrip";
import { AssistantPlanner } from "@/components/assistant/AssistantPlanner";
import type { StudioModel } from "@/lib/creative/studio";

const QUICK_ICON: Record<QuickActionId, LucideIcon> = {
  image: ImagePlus,
  video: Clapperboard,
  voice: Mic,
  edit: Wand2,
  upscale: ZoomIn,
  cutout: Scissors,
};

/** Each tool's mark on its own painted square (same in both themes). */
const QUICK_HUES: Record<QuickActionId, string> = {
  image: "linear-gradient(135deg,#ff7a59,#ffb35c)",
  video: "linear-gradient(135deg,#7b5cff,#d65cff)",
  voice: "linear-gradient(135deg,#2bb3a3,#5ad1e6)",
  edit: "linear-gradient(135deg,#3f7bff,#69b4ff)",
  upscale: "linear-gradient(135deg,#ffb020,#ff6a3d)",
  cutout: "linear-gradient(135deg,#e2559f,#ff8fb1)",
};

const FLOW = ["channel", "topic", "script", "video", "approval", "youtube"] as const;

/**
 * Home ("Bosh sahifa"): the customer's first screen after sign-in.
 *
 * It leads with what Nightshift is — a channel that turns a topic into a
 * script, a video, an approval and a YouTube upload — and puts every other
 * tool one tap away. Nothing on this screen starts, prices or spends
 * anything: the composer and every tile only open the existing forms, which
 * show their price and ask before they run (lib/home).
 */
export function HomeHub({
  channels,
  currentSlug,
  orgId,
  allPrivate,
  assistant,
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

  return (
    <div className="flex flex-col gap-10 sm:gap-12">
      {/* ── Hero: the idea, then the box ─────────────────────────────── */}
      <section aria-labelledby="home-hero" className="relative flex flex-col gap-5">
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-x-6 -top-10 h-[260px] opacity-80"
          style={{
            background:
              "radial-gradient(60% 70% at 50% 0%, color-mix(in srgb, var(--color-primary) 18%, transparent), transparent 70%)",
          }}
        />
        <ol
          aria-label={t.home.flowLabel}
          className="relative -mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-1 text-[12px] text-[var(--color-muted)] [scrollbar-width:none]"
        >
          {FLOW.map((step, i) => (
            <li key={step} className="flex shrink-0 items-center gap-1">
              {i > 0 && <ChevronRight aria-hidden className="size-3.5 opacity-50" />}
              <span
                className={`pill border px-2.5 py-1 ${
                  step === "approval"
                    ? "border-[color-mix(in_srgb,var(--color-primary)_55%,var(--color-border))] text-[var(--color-fg)]"
                    : "border-[var(--color-border)]"
                }`}
              >
                {t.home.flow[step]}
              </span>
            </li>
          ))}
        </ol>

        <div className="relative flex flex-col gap-2">
          <h1 id="home-hero" className="text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-[var(--color-fg)] sm:text-[32px]">
            {t.home.heroTitle}
          </h1>
          <p className="max-w-[60ch] text-[14px] leading-relaxed text-[var(--color-muted)] sm:text-[15px]">{t.home.heroLead}</p>
        </div>

        <div className="relative">
          <HomeComposer ref={composer} channels={runnable} currentSlug={currentSlug} />
        </div>

        <ul className="relative flex flex-wrap gap-x-4 gap-y-1.5 px-1 text-[12px] text-[var(--color-muted)]">
          {[t.home.promisePrice, t.home.promiseRefund, allPrivate ? t.home.promisePrivate : t.home.promiseGate].map((p) => (
            <li key={p} className="flex items-center gap-1.5">
              <Check aria-hidden className="size-3.5 text-[var(--color-ok)]" />
              {p}
            </li>
          ))}
        </ul>
      </section>

      {assistant && (
        <AssistantPlanner
          orgId={orgId}
          models={assistant.models}
          channels={plannerChannels}
          currentSlug={currentSlug}
          canRun={assistant.canRun}
          runConfigured={assistant.runConfigured}
        />
      )}

      {/* ── Quick tools → the Studio panel, filled ─────────────────────── */}
      <section aria-labelledby="home-quick" className="flex flex-col gap-3">
        <h2 id="home-quick" className="t-panel">
          {t.home.quickTitle}
        </h2>
        <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          {QUICK_ACTIONS.map((a) => {
            const Icon = QUICK_ICON[a.id];
            return (
              <li key={a.id}>
                <Link
                  href={path(toolHref(a.tool))}
                  className="press group flex h-full flex-col gap-3 rounded-[16px] border border-[var(--color-border)] bg-[var(--color-panel)] p-3 transition-colors hover:border-[color-mix(in_srgb,var(--color-primary)_45%,var(--color-border))]"
                >
                  <span aria-hidden className="grid size-9 place-items-center rounded-[11px] text-white" style={{ background: QUICK_HUES[a.id] }}>
                    <Icon className="size-[18px]" strokeWidth={2} />
                  </span>
                  <span className="flex flex-col">
                    <span className="text-[14px] font-medium leading-snug text-[var(--color-fg)]">{t.home.quick[a.id].title}</span>
                    <span className="text-[12px] leading-snug text-[var(--color-muted)]">{t.home.quick[a.id].sub}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── Formats → the composer, preset ─────────────────────────────── */}
      <section aria-labelledby="home-formats" className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="home-formats" className="t-panel">
            {t.home.formatsTitle}
          </h2>
          <p className="text-[13px] text-[var(--color-muted)]">{t.home.formatsHint}</p>
        </div>
        <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2 sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 sm:pb-0">
          {HOME_FORMATS.map((f) => (
            <li key={f.id} className="w-[200px] shrink-0 snap-start sm:w-auto">
              <button
                type="button"
                onClick={() => composer.current?.preset(f.length, t.home.formats[f.id].starter)}
                className="press group flex h-full w-full flex-col overflow-hidden rounded-[16px] border border-[var(--color-border)] bg-[var(--color-panel)] text-left transition-colors hover:border-[color-mix(in_srgb,var(--color-primary)_45%,var(--color-border))]"
              >
                <span className="relative block aspect-[16/10] w-full overflow-hidden">
                  <FormatArt id={f.id} className="absolute inset-0 size-full transition-transform duration-500 group-hover:scale-[1.04]" />
                  <span className="pill absolute bottom-2 left-2 bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
                    {t.home.lengths[f.length]}
                  </span>
                </span>
                <span className="flex flex-col gap-0.5 p-3">
                  <span className="text-[14px] font-medium text-[var(--color-fg)]">{t.home.formats[f.id].title}</span>
                  <span className="text-[12px] leading-snug text-[var(--color-muted)]">{t.home.formats[f.id].who}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Your channels: the part no other studio has ───────────────── */}
      <section aria-labelledby="home-channels" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 id="home-channels" className="t-panel">
              {t.home.channelsTitle}
            </h2>
            {channels.length > 0 && <p className="text-[13px] text-[var(--color-muted)]">{t.home.channelsHint}</p>}
          </div>
          {channels.length > 0 && (
            <Link href={path("/channels/new")} className="tap-link shrink-0 text-[13px] text-[var(--color-primary)] hover:underline">
              {t.home.addChannel}
            </Link>
          )}
        </div>
        {channels.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-[18px] border border-dashed border-[var(--color-border)] p-5 sm:flex-row sm:items-center">
            <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-[var(--color-panel-2)] text-[var(--color-primary)]">
              <Film className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium text-[var(--color-fg)]">{t.home.noChannelsTitle}</p>
              <p className="text-[13px] text-[var(--color-muted)]">{t.home.noChannelsBody}</p>
            </div>
            <Link href={path("/channels/new")} className="cta-glass pill inline-flex min-h-10 items-center gap-1.5 px-4 text-[13px] font-semibold">
              <Plus aria-hidden className="size-4" />
              {t.home.connect}
            </Link>
          </div>
        ) : (
          <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
            {channels.map((c) => (
              <ChannelCard key={c.id} c={c} />
            ))}
          </ul>
        )}
      </section>

      <RecentStrip orgId={orgId} />
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
  live: "var(--color-ok)",
  paused: "var(--color-warn)",
  draft: "var(--color-idle)",
} as const;

function ChannelCard({ c }: { c: HomeChannel }) {
  const { t } = useI18n();
  const path = useChannelPath();
  const mounted = useMounted();
  const at = (section: string) => `/${encodeURIComponent(c.slug)}${section}`;
  const initial = (c.name.trim()[0] ?? "?").toUpperCase();

  return (
    <li className="w-[272px] shrink-0 snap-start sm:w-[300px]" data-channel={c.slug}>
      <div className="flex h-full flex-col gap-3 rounded-[18px] border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
        <div className="flex items-center gap-3">
          {c.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element -- the channel's public YouTube avatar
            <img src={c.avatar} alt="" width={40} height={40} className="size-10 shrink-0 rounded-full border border-[var(--color-border)] object-cover" />
          ) : (
            <span
              aria-hidden
              className="grid size-10 shrink-0 place-items-center rounded-full text-[15px] font-semibold text-white"
              style={{ background: "linear-gradient(135deg, #3f7bff, #a35cff)" }}
            >
              {initial}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-medium text-[var(--color-fg)]">{c.name}</p>
            <p className="flex items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
              <span aria-hidden className="size-1.5 rounded-full" style={{ background: STANDING_TONE[c.standing] }} />
              {t.home.standing[c.standing]}
              {c.language && <span className="truncate">· {c.language}</span>}
            </p>
          </div>
        </div>

        {c.lastVideo?.title && (
          <p className="line-clamp-2 text-[13px] leading-snug text-[var(--color-fg)]" title={c.lastVideo.title}>
            {c.lastVideo.title}
          </p>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
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
                className="mono font-semibold"
                style={{ color: c.waiting > 0 ? "var(--color-warn)" : "var(--color-muted)" }}
                data-testid="waiting"
              >
                {c.waiting}
              </span>
            )}
          </dd>
        </dl>

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
          <span className="truncate text-[11px] text-[var(--color-muted)]">{c.autoPublish ? t.home.autoOn : t.home.autoOff}</span>
          {c.standing === "draft" ? (
            <Link href={path("/channels")} className="tap-link inline-flex shrink-0 items-center gap-1 text-[12px] text-[var(--color-primary)] hover:underline">
              {t.home.connect}
              <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
          ) : (
            <Link href={at("/videos")} className="tap-link inline-flex shrink-0 items-center gap-1 text-[12px] text-[var(--color-primary)] hover:underline">
              {t.home.review}
              <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}
