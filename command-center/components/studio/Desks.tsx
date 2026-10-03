"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { DESKS, DESK_TOOLS, MEDIA_DESKS, deskFor, deskHref, type Desk, type MediaDesk } from "@/lib/creative/desks";
import { isActiveStatus, isStudioCapability, type StudioJob } from "@/lib/creative/studio";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { Meter } from "@/components/ui/Meter";
import { Timecode } from "@/components/ui/Timecode";
import { LocalTime } from "@/components/ui/LocalTime";
import { formatNumber } from "@/lib/number-format";
import { JobFeed } from "@/components/studio/JobFeed";
import type { CreditAccount } from "@/lib/credits";
import { DESK_ICONS } from "@/components/studio/deskIcons";
import "@/components/studio/desk.css";


/**
 * The desk switcher: one row of engraved keys across the top of /create, the
 * current desk lit. Links, not tabs — each desk is its own address, so a desk
 * can be bookmarked, shared and opened from the sidebar. On a phone it is one
 * row that scrolls sideways, every key at least 44 px tall.
 */
export function DeskBar({ current }: { current: Desk }) {
  const { t } = useI18n();
  const path = useChannelPath();
  return (
    <nav aria-label={t.desk.nav} className="desk-bar">
      <ul className="desk-bar-row">
        {DESKS.map((d) => {
          const Icon = DESK_ICONS[d];
          const on = d === current;
          return (
            <li key={d}>
              <Link href={path(deskHref(d))} aria-current={on ? "page" : undefined} className="desk-key" data-desk={d}>
                <Icon aria-hidden className="desk-key-icon" strokeWidth={1.75} />
                <span className="flex min-w-0 flex-col">
                  <span className="desk-key-name">{t.desk.names[d]}</span>
                  <span className="desk-key-sub">{t.desk.keySub[d]}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Where the credit balance stands, as the page could read it (never a made-up zero). */
export type CreditsReading =
  | { state: "account"; account: CreditAccount }
  /** The operator's own organization: work there is not charged in credits. */
  | { state: "exempt" }
  /** Not readable here (no organization, no migration, a failed read). */
  | { state: "unknown" };

export interface ProjectSummary {
  id: string;
  title: string;
  updatedAt: string | null;
}

export type ProjectsReading = { state: "ok"; projects: ProjectSummary[] } | { state: "not_available" } | { state: "failed" };

/**
 * /create with no desk: the five desks as one patch bay, the latest work from
 * every desk (the real generation history, each row linking to its desk), the
 * credit balance and the edit projects. Nothing on it prices or spends.
 */
export function StudioOverview({
  orgId,
  credits,
  projects,
  assistant,
}: {
  orgId: string | null;
  credits: CreditsReading;
  projects: ProjectsReading;
  /** The Assistant planner (one goal → a priced plan → one confirm), rendered by the page. */
  assistant?: ReactNode;
}) {
  const { t, locale, fmt } = useI18n();
  const path = useChannelPath();
  const bay = [...MEDIA_DESKS, "youtube"] as const;
  // What is working on each desk right now, from the same read as the list below (never guessed).
  const [working, setWorking] = useState<Partial<Record<MediaDesk, number>> | null>(null);
  const onJobs = (jobs: StudioJob[]) => {
    const n: Partial<Record<MediaDesk, number>> = {};
    for (const j of jobs) {
      if (!isActiveStatus(j.status) || !isStudioCapability(j.capability)) continue;
      const d = deskFor(j.capability);
      n[d] = (n[d] ?? 0) + 1;
    }
    setWorking(n);
  };


  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="desk-bay-title" className="flex flex-col gap-3">
        <h2 id="desk-bay-title" className="ns-eyebrow">
          {t.desk.startTitle}
        </h2>
        <ol className="desk-bay">
          {bay.map((d, i) => {
            const Icon = DESK_ICONS[d];
            const tools = d === "youtube" ? null : DESK_TOOLS[d];
            return (
              <li key={d} className="desk-bay-cell">
                <Link href={path(deskHref(d))} className="desk-bay-key">
                  <span className="desk-bay-top">
                    <span aria-hidden className="desk-bay-no ns-tc">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <Icon aria-hidden className="size-5" strokeWidth={1.75} />
                  </span>
                  <span className="desk-bay-name">{t.desk.names[d]}</span>
                  <span className="desk-bay-blurb">{t.desk.blurbs[d]}</span>
                  <span className="desk-bay-tools">
                    {tools ? tools.map((c) => t.desk.tools[c]).join(" · ") : t.desk.keySub.youtube}
                  </span>
                  {d !== "youtube" && working && (working[d] ?? 0) > 0 && (
                    <span className="desk-bay-live">
                      <StatusLamp tone="run" live label={fmt(t.desk.workingNow, { n: working[d] ?? 0 })} />
                    </span>
                  )}
                  <span aria-hidden className="desk-bay-go">
                    <ArrowRight className="size-4" />
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="desk-overview-grid">
        <div className="min-w-0">
          {orgId ? (
            <JobFeed
              orgId={orgId}
              variant="log"
              limit={8}
              onLoaded={onJobs}
              title={t.desk.recentTitle}
              emptyTitle={t.desk.recentEmptyTitle}
              emptyBody={t.desk.recentEmpty}
            />
          ) : (
            <p className="studio-field p-4 text-sm text-[var(--color-muted)]">{t.desk.noOrg}</p>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-4" aria-label={t.desk.sideLabel}>
          <section className="ns-panel desk-side" aria-labelledby="desk-credits-title">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="desk-credits-title" className="ns-eyebrow">
                {t.desk.creditsTitle}
              </h2>
              <Link href={path("/credits")} className="tap-link text-xs text-[var(--color-primary)] underline">
                {t.desk.creditsLink}
              </Link>
            </div>
            {credits.state === "account" ? (
              <>
                <p className="flex items-baseline gap-2">
                  <Timecode value={credits.account.available} locale={locale} className="desk-figure" />
                  <span className="text-sm text-[var(--color-muted)]">{t.desk.creditsAvailable}</span>
                </p>
                <Meter
                  value={credits.account.available}
                  held={credits.account.reserved}
                  size="lg"
                  label={t.desk.creditsTitle}
                  valueText={fmt(t.desk.creditsReading, {
                    n: formatNumber(credits.account.available, locale, 2),
                    h: formatNumber(credits.account.reserved, locale, 2),
                  })}
                />
                <p className="text-xs text-[var(--color-muted)]">
                  {credits.account.reserved > 0 ? (
                    <>
                      <Timecode value={credits.account.reserved} locale={locale} /> {t.desk.creditsHeld}
                    </>
                  ) : (
                    t.desk.creditsNoneHeld
                  )}
                </p>
              </>
            ) : credits.state === "exempt" ? (
              <p className="text-sm text-[var(--color-muted)]">{t.desk.creditsExempt}</p>
            ) : (
              <p className="text-sm text-[var(--color-muted)]">{t.desk.creditsUnknown}</p>
            )}
          </section>

          <section className="ns-panel desk-side" aria-labelledby="desk-projects-title">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="desk-projects-title" className="ns-eyebrow">
                {t.desk.projectsTitle}
              </h2>
              <Link href={path("/editor")} className="tap-link text-xs text-[var(--color-primary)] underline">
                {t.desk.projectsOpen}
              </Link>
            </div>
            {projects.state === "ok" ? (
              projects.projects.length > 0 ? (
                <ul className="flex flex-col">
                  {projects.projects.slice(0, 5).map((p) => {
                    return (
                      <li key={p.id}>
                        <Link href={path(`/editor/${p.id}`)} className="desk-project">
                          <span className="min-w-0 truncate text-sm font-semibold text-[var(--color-fg)]">{p.title}</span>
                          <LocalTime iso={p.updatedAt} locale={locale} className="shrink-0 text-xs text-[var(--color-muted)]" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-[var(--color-muted)]">{t.desk.projectsEmpty}</p>
              )
            ) : (
              <p className="text-sm text-[var(--color-muted)]">
                {projects.state === "not_available" ? t.desk.projectsUnavailable : t.desk.projectsFailed}
              </p>
            )}
          </section>
        </aside>
      </div>

      {assistant}
    </div>
  );
}

/** The YouTube video's steps, in order, and where each one is done (customer sections only). */
const RUNDOWN = [
  { id: "idea", href: null },
  { id: "script", href: "/videos" },
  { id: "assets", href: "/studio" },
  { id: "edit", href: "/editor" },
  { id: "validate", href: "/videos" },
  { id: "approve", href: "/videos" },
] as const;

/**
 * The YouTube desk: the whole video as a rundown — idea, script, pictures and
 * voice, edit, the publish gate, your approval — beside the run form that
 * starts it. The rundown is a map, not a progress bar: it lights only the step
 * this form is (the idea), and every other step names the place it happens.
 */
export function YouTubeDesk({ run }: { run: ReactNode }) {
  const { t } = useI18n();
  const path = useChannelPath();
  return (
    <div className="desk-yt">
      <section aria-labelledby="desk-rundown-title" className="desk-rundown-wrap">
        <h2 id="desk-rundown-title" className="ns-eyebrow">
          {t.desk.rundownTitle}
        </h2>
        <ol className="desk-rundown">
          {RUNDOWN.map((s, i) => {
            const copy = t.desk.rundown[s.id];
            const here = s.href === null;
            return (
              <li key={s.id} className="desk-rundown-step" data-here={here ? "true" : undefined} aria-current={here ? "step" : undefined}>
                <span aria-hidden className="desk-rundown-no ns-tc">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="desk-rundown-title">{copy.title}</span>
                  <span className="desk-rundown-body">{copy.body}</span>
                  {here ? (
                    <span className="desk-rundown-here">{t.desk.rundownHere}</span>
                  ) : (
                    <Link href={path(s.href)} className="desk-rundown-link">
                      {copy.link}
                      <ArrowRight aria-hidden className="size-3.5" />
                    </Link>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      </section>
      <div className="min-w-0">{run}</div>
    </div>
  );
}
