"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { DESKS, deskHref, type Desk } from "@/lib/creative/desks";
import { Meter } from "@/components/ui/Meter";
import { Timecode } from "@/components/ui/Timecode";
import { LocalTime } from "@/components/ui/LocalTime";
import { formatNumber } from "@/lib/number-format";
import type { CreditAccount } from "@/lib/credits";
import { DESK_ICONS } from "@/components/studio/deskIcons";
import { useShell } from "@/components/shell/ShellContext";
import { deskOpen } from "@/lib/tool-availability";
import "@/components/studio/desk.css";
import "@/components/studio/availability.css";


/**
 * The desk switcher: one row of engraved keys across the top of /create, the
 * current desk lit. Links, not tabs — each desk is its own address, so a desk
 * can be bookmarked, shared and opened from the sidebar. On a phone it is one
 * row that scrolls sideways, every key at least 44 px tall.
 */
export function DeskBar({ current }: { current: Desk }) {
  const { t } = useI18n();
  const path = useChannelPath();
  const { tools } = useShell();
  return (
    <nav aria-label={t.desk.nav} className="desk-bar">
      <ul className="desk-bar-row">
        {DESKS.map((d) => {
          const Icon = DESK_ICONS[d];
          const on = d === current;
          // A desk with nothing on sale says so in place of its line, and is not a link (lib/tool-availability.ts); the current
          // one stays a link so the bar still says where you are.
          const closed = !deskOpen(tools, d);
          const body = (
            <>
              <Icon aria-hidden className="desk-key-icon" strokeWidth={1.75} />
              <span className="flex min-w-0 flex-col">
                <span className="desk-key-name">{t.desk.names[d]}</span>
                <span className="desk-key-sub">{closed ? t.availability.notYet : t.desk.keySub[d]}</span>
              </span>
            </>
          );
          return (
            <li key={d}>
              {closed && !on ? (
                <span className="desk-key av-closed" aria-disabled="true" data-desk={d} data-unavailable="true">
                  {body}
                </span>
              ) : (
                <Link href={path(deskHref(d))} aria-current={on ? "page" : undefined} className="desk-key" data-desk={d} data-unavailable={closed ? "true" : undefined}>
                  {body}
                </Link>
              )}
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
 * The credit balance and the edit projects, read as the member (RLS) by the
 * page. Unreadable is words, never a zero; nothing here prices or spends.
 * /create shows it in its "Advanced" part (components/studio/StudioHome.tsx).
 */
export function StudioSide({
  credits,
  projects,
  className,
}: {
  credits: CreditsReading;
  projects: ProjectsReading;
  className?: string;
}) {
  const { t, locale, fmt } = useI18n();
  const path = useChannelPath();
  return (
    <aside className={className ?? "flex min-w-0 flex-col gap-4"} aria-label={t.desk.sideLabel}>
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
                    {/* A full load into the editor's project page: it must get its own Permissions-Policy (lib/editor-nav.ts). */}
                    <a href={path(`/editor/${p.id}`)} className="desk-project">
                      <span className="min-w-0 truncate text-sm font-semibold text-[var(--color-fg)]">{p.title}</span>
                      <LocalTime iso={p.updatedAt} locale={locale} className="shrink-0 text-xs text-[var(--color-muted)]" />
                    </a>
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
      {/* id="prompt": the target of "Skip to the prompt" (components/shell/SkipLink). */}
      <div id="prompt" className="min-w-0">{run}</div>
    </div>
  );
}
