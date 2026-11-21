"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Flame, Lightbulb, Loader2, Upload } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { coerceJobs, isActiveStatus } from "@/lib/creative/studio";
import { createHref } from "@/lib/customer/create";
import { PROJECTS, TRENDS } from "@/lib/navigation";
import { StartBox, type StartChannel } from "@/components/prompt/StartBox";
import type { NightshiftAiAccess } from "@/lib/nightshift-ai-flag";
import "@/components/customer/customer.css";

export type HomeProject = { id: string; title: string; updatedAt: string | null };
/** Held videos and storyboards waiting for this person's decision; null = the read failed (never shown as 0). */
export type HomeWaiting = { videos: number | null; storyboards: number | null };
export type HomeProjectsReading = { state: "ok"; projects: HomeProject[] } | { state: "not_available" } | { state: "failed" };

/**
 * Home: "What shall we create?" — the start box (components/prompt/StartBox.tsx: its tabs, chips and the Trends templates
 * by purpose), what to continue and, for a new account, three ways to start. Nothing here prices or spends: the box opens
 * Create, the edit desk, the run form or Nightshift AI with the words, and only a press there starts a paid job.
 */
export function HomeCreate({
  orgId,
  projects,
  waiting = { videos: 0, storyboards: 0 },
  agent = { open: false, reason: "workspace" },
  channel = null,
}: {
  orgId: string | null;
  projects: HomeProjectsReading;
  waiting?: HomeWaiting;
  /** Nightshift AI for this workspace, as the server answered (lib/server/nightshift-ai.ts). */
  agent?: NightshiftAiAccess;
  /** The verified channel the start box's "Channel video" is for; null = none. */
  channel?: StartChannel | null;
}) {
  const { t } = useI18n();
  const h = t.customerApp.home;
  const path = useChannelPath();
  const working = useWorkingCount(orgId);
  const firstRun = projects.state === "ok" && projects.projects.length === 0 && working === 0;

  return (
    <div className="hc-screen" data-testid="home-create">
      <section aria-labelledby="hc-title" className="hc-hero">
        <h1 id="hc-title" className="hc-title">{h.title}</h1>
        <p className="hc-lead">{h.lead}</p>
        <StartBox agent={agent} channel={channel} />
      </section>

      <WaitingForYou waiting={waiting} />

      {firstRun && (
        <section aria-labelledby="hc-first" className="hc-section">
          <h2 id="hc-first" className="hc-h2">{h.firstTitle}</h2>
          <div className="hc-grid">
            <Tile href={path(TRENDS)} icon={<Flame aria-hidden className="size-5" />} title={h.tileTemplate} body={h.tileTemplateBody} />
            <Tile href={path(createHref("video"))} icon={<Lightbulb aria-hidden className="size-5" />} title={h.tileIdea} body={h.tileIdeaBody} />
            <Tile href={path("/library")} icon={<Upload aria-hidden className="size-5" />} title={h.tileVideo} body={h.tileVideoBody} />
          </div>
        </section>
      )}


      <section aria-labelledby="hc-continue" className="hc-section">
        <h2 id="hc-continue" className="hc-h2">{h.continueTitle}</h2>
        <ContinueRow projects={projects} working={working} />
      </section>
    </div>
  );
}

function Tile({ href, icon, title, body }: { href: string; icon: React.ReactNode; title: string; body: string }) {
  return (
    <Link href={href} className="hc-tile">
      <span className="hc-tile-icon">{icon}</span>
      <span className="font-medium">{title}</span>
      <span className="hc-meta">{body}</span>
    </Link>
  );
}

/** How many of the workspace's generations are working now (GET /api/creative/jobs, RLS). null = unknown, never 0. */
function useWorkingCount(orgId: string | null): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (!orgId) return;
    const ctl = new AbortController();
    fetch(`/api/creative/jobs?org_id=${encodeURIComponent(orgId)}`, { signal: ctl.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { jobs?: unknown };
        setN(coerceJobs(body.jobs).filter((j) => isActiveStatus(j.status)).length);
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [orgId]);
  return n;
}

function ContinueRow({ projects, working }: { projects: HomeProjectsReading; working: number | null }) {
  const { t, fmt, locale } = useI18n();
  const h = t.customerApp.home;
  const path = useChannelPath();
  const when = (iso: string | null) => {
    const at = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(at)) return h.updatedUnknown;
    return fmt(h.updated, { when: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at) });
  };
  const items: React.ReactNode[] = [];
  if (working && working > 0)
    items.push(
      <Link key="working" href={path("/create")} className="hc-card" data-testid="continue-working">
        <span className="inline-flex items-center gap-2 font-medium">
          <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          {fmt(h.working, { n: working })}
        </span>
        <span className="hc-meta">{t.customerApp.create.title}</span>
      </Link>,
    );
  if (projects.state === "ok")
    for (const p of projects.projects.slice(0, 8))
      items.push(
        // A full load into the editor's project page: it must get its own Permissions-Policy (lib/editor-nav.ts).
        <a key={p.id} href={path(`/editor/${p.id}`)} className="hc-card">
          <span className="truncate font-medium">{p.title}</span>
          <span className="hc-meta">{when(p.updatedAt)}</span>
        </a>,
      );
  if (projects.state === "failed" && items.length === 0) return <p role="alert" className="hc-meta m-0">{h.continueFailed}</p>;
  // Not readable here (no organization, or the editor migration not applied): unknown, never "nothing to continue".
  if (projects.state === "not_available" && items.length === 0) return <p className="hc-meta m-0">{h.continueUnknown}</p>;
  if (items.length === 0)
    return (
      <p className="hc-meta m-0">
        {h.continueEmpty}{" "}
        <Link href={path(PROJECTS)} className="tap-link text-[var(--color-primary)]">
          {t.nav.projects}
        </Link>
      </p>
    );
  return <div className="hc-row">{items}</div>;
}

/** One line above everything else when a decision waits: held videos and storyboards, each linking to where it is decided. */
function WaitingForYou({ waiting }: { waiting: HomeWaiting }) {
  const { t, fmt } = useI18n();
  const h = t.customerApp.home;
  const path = useChannelPath();
  const unread = waiting.videos === null || waiting.storyboards === null;
  const items: React.ReactNode[] = [];
  if (waiting.videos && waiting.videos > 0)
    items.push(
      <Link key="v" href={path("/videos")} className="hc-card" data-testid="waiting-videos">
        <span className="font-medium">{fmt(h.waitingVideos, { n: waiting.videos })}</span>
        <span className="hc-meta">{h.waitingVideosBody}</span>
      </Link>,
    );
  if (waiting.storyboards && waiting.storyboards > 0)
    items.push(
      <Link key="s" href={path("/videos")} className="hc-card" data-testid="waiting-storyboards">
        <span className="font-medium">{fmt(h.waitingBoards, { n: waiting.storyboards })}</span>
        <span className="hc-meta">{h.waitingBoardsBody}</span>
      </Link>,
    );
  if (items.length === 0 && !unread) return null;
  return (
    <section aria-labelledby="hc-waiting" className="hc-section" data-testid="home-waiting">
      <h2 id="hc-waiting" className="hc-h2">{h.waitingTitle}</h2>
      {items.length > 0 && <div className="hc-row">{items}</div>}
      {unread && (
        <p role="status" className="hc-meta m-0">
          {h.waitingUnknown}
        </p>
      )}
    </section>
  );
}
