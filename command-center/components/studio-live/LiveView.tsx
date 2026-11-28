"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { AssetDownloads } from "@/components/media/AssetDownloads";
import { Lamp } from "@/components/studio-canvas/parts";
import { useMediaUrls } from "@/components/studio-timeline/useTimelineData";
import { JOB_ERROR_CODES } from "@/lib/job-errors";
import { useBrainBrief, handoffTarget } from "./useBrainBrief";
import { ActivityPanel } from "./ActivityPanel";
import { LiveLane } from "./LiveLane";
import { utc } from "@/lib/studio/utc";
import { type Brief, type LiveGraph, type LiveNode, type LiveStatus, type RunVideoRef, type Activity, type ActivityItem } from "@/lib/studio/liveGraph";
import { useLiveGraph, type LiveTarget } from "./useLiveGraph";
import { nodeName, StoryBoard, TONE } from "./StoryBoard";
import { useBoardModel } from "./useBoardModel";
import type { BoardInput } from "@/lib/studio/boardModel";
import "@/components/studio-canvas/studio-canvas.css";
import "./studio-live.css";

type T = ReturnType<typeof useI18n>["t"];

/** Signing in again returns to this very plan (Pixel M10), as AssetDownloads does. */
function loginHref(): string {
  const here = typeof window === "undefined" ? "/" : window.location.pathname + window.location.search;
  return `/login?next=${encodeURIComponent(here || "/")}`;
}

/** system_events.ts is text, often a naive utcnow().isoformat(): read without an offset it would be local time (Lens M1). */
export { utc };

export { nodeName };

/** A channel run's live facts: GitHub's own status of the dispatched job, and the run's credit hold. Only what was read is said. */
function RunFacts({ graph }: { graph: LiveGraph }) {
  const { t } = useI18n();
  const c = t.studioLive;
  const w = graph.workflow;
  const h = graph.hold;
  const wf = w === undefined ? null : w === null ? c.workflow.unknown : w.state === "completed" ? c.workflow[w.conclusion] : c.workflow[w.state];
  const hold = !h
    ? null
    : h.state === "open"
      ? h.amount === null ? c.holdOpenUnknown : fmt(c.holdOpen, { n: h.amount })
      : h.state === "captured"
        ? h.captured === null ? c.holdCapturedUnknown : fmt(c.holdCaptured, { n: h.captured })
        : c.holdReleased;
  return (
    <ul className="lv-facts" data-testid="live-run-facts">
      {wf ? <li data-testid="live-workflow">{wf}</li> : null}
      {hold ? <li data-testid="live-hold">{hold}</li> : null}
    </ul>
  );
}

/** A failed step's reason and remedy, never a guess: a known word gets its sentence, any other is named as it was stored. */
export function failureText(t: T, n: LiveNode, run: boolean): { reason: string; remedy: string | null } {
  const c = t.studioLive;
  if (run) {
    const code = n.error && (JOB_ERROR_CODES as readonly string[]).includes(n.error) ? (n.error as keyof T["create"]["jobError"]) : null;
    return { reason: code ? t.create.jobError[code] : c.failedNoCode, remedy: null };
  }
  if (n.error && c.errors[n.error]) return { reason: c.errors[n.error], remedy: null };
  return { reason: n.error ? fmt(c.failedGeneric, { code: n.error }) : c.failedNoCode, remedy: c.remedyGeneric };
}


function Output({ node }: { node: LiveNode }) {
  const { t } = useI18n();
  const ids = useMemo(() => (node.assetId ? [node.assetId] : []), [node.assetId]);
  const { urls } = useMediaUrls(ids);
  // A failed step has nothing coming: "nothing to show yet" would promise otherwise.
  if (!node.assetId) return node.text ? <p className="lv-text">{node.text}</p> : node.status === "failed" ? null : <p className="lv-muted">{t.studioLive.noOutput}</p>;
  const m = urls.get(node.assetId);
  if (!m) return <p className="lv-muted">{t.studioLive.loading}</p>;
  // A picture has a thumbnail and no play link (useMediaUrls gives play to video and audio only): Pixel H2.
  const src = m.kind === "image" ? (m.thumb ?? m.play) : m.play;
  if (m.failed || m.unavailable || !src) return <p className="lv-muted">{t.studioLive.outputUnavailable}</p>;
  // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived library link
  if (m.kind === "image") return <img className="lv-media" src={src} alt="" />;
  if (m.kind === "audio") return <audio className="lv-audio" src={src} controls preload="none" />;
  return <video className="lv-media" src={src} poster={m.thumb ?? undefined} controls preload="metadata" playsInline />;
}

export function Details({
  node,
  run,
  filmId,
  video,
  onClose,
}: {
  node: LiveNode;
  run: boolean;
  filmId: string | null;
  /** undefined: the route did not say (an older answer); null: no video row readable for this run yet. */
  video?: RunVideoRef | null;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const c = t.studioLive;
  const path = useChannelPath();
  const closeRef = useRef<HTMLButtonElement>(null);
  // preventScroll: focusing the close key must not scroll the page and hide the plan's title (S4 MEDIUM 4).
  useEffect(() => closeRef.current?.focus({ preventScroll: true }), [node.id]);
  return (
    <aside
      className="lv-details"
      aria-label={c.details}
      data-testid="live-details"
    >
      <div className="lv-details-head">
        <h2>{nodeName(t, node)}</h2>
        <button type="button" ref={closeRef} className="cv-kbtn" onClick={onClose} aria-label={c.close}>
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <Lamp tone={TONE[node.status]} live={node.status === "working"} label={c.status[node.status]} />
      {node.status === "failed" ? (
        (() => {
          const f = failureText(t, node, run);
          return (
            <div className="lv-fail" role="status" data-testid="live-failure">
              <p>{f.reason}</p>
              {f.remedy ? <p>{f.remedy}</p> : null}
            </div>
          );
        })()
      ) : null}
      {node.kind === "upload" ? (
        <p data-testid="live-privacy">{node.privacy === "private" ? c.privacyPrivate : node.privacy ? fmt(c.privacyOther, { privacy: c.privacyWords[node.privacy] ?? node.privacy }) : c.privacyUnknown}</p>
      ) : null}
      {run && node.kind === "upload" && video !== undefined ? (
        // The run's video page holds the existing "Publish to platforms" panel: the person sends from there, after its checks.
        video ? (
          <Link className="cv-kbtn" href={path(`/videos/${encodeURIComponent(video.id)}`)} data-testid="live-open-video">
            {c.openVideo}
          </Link>
        ) : (
          <p className="lv-muted" data-testid="live-video-after-sync">
            {c.videoAfterSync}
          </p>
        )
      ) : null}
      {!run ? (
        <p className="lv-muted" data-testid="live-credits">
          {node.credits
            ? [
                node.credits.held === null ? c.creditsHeldUnrecorded : fmt(c.creditsHeld, { n: node.credits.held }),
                node.credits.charged === null ? c.creditsChargedUnrecorded : fmt(c.creditsCharged, { n: node.credits.charged }),
              ].join(" · ")
            : c.creditsNone}
        </p>
      ) : node.at ? (
        <p className="lv-muted">{fmt(c.recordedAt, { time: utc(node.at).toLocaleString(locale === "uz" ? "uz-Latn-UZ" : locale) })}</p>
      ) : null}
      {!run ? <Output node={node} /> : null}
      {node.kind === "final" && node.assetId ? (
        <div className="lv-final" data-testid="live-final">
          <AssetDownloads assetId={node.assetId} preview="ready" />
          {filmId ? (
            <Link className="cv-kbtn" href={path(`/studio?view=timeline&film=${filmId}`)} data-testid="live-open-timeline">
              {c.openTimeline}
            </Link>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

/**
 * The Studio's live view of one plan (item 5): a short film or a channel video, its steps drawn as nodes whose lamps follow the real
 * rows as they change. Read-only: no drag, no wiring, no key that starts, repeats or charges anything (CLAUDE.md rule 3); a failed
 * step shows its reason and remedy only. At phone width the board becomes a list of the same steps.
 */
export function LiveView({
  filmStudio,
  target: given,
  brief: givenBrief = null,
  brain = null,
}: {
  filmStudio: boolean;
  target: LiveTarget | null;
  brief?: Brief | null;
  /** A Nightshift AI conversation (?brain=): its brief is drawn as a draft, and its handoff, once Create is pressed, is followed live. */
  brain?: string | null;
}) {
  const { t } = useI18n();
  const c = t.studioLive;
  const studioPath = useChannelPath();
  const brainRead = useBrainBrief(given || givenBrief ? null : brain);
  const brief = givenBrief ?? (brainRead.load.state === "ready" ? brainRead.load.brief : null);
  // After Create the brief names what was made; the view follows it in place. The scene cards keep their ids because both graphs key
  // them by the scene's position (liveGraph sceneNodeId): the brief's scene ids are not the film's, so keyed by id they never matched.
  const target = given ?? (brief?.handoff ? handoffTarget(brief.handoff) : null);
  const run = target?.kind === "run" || target?.kind === "window" || (!target && brief?.kind === "long");
  const shown = filmStudio || run ? target : null;
  const { load, stale, retry } = useLiveGraph(shown);
  const [selected, setSelected] = useState<string | null>(null);
  // Before Create there is no target: the brief so far is drawn as DRAFT steps (no lamp, a price only where the backend gave one).
  // After Create the same position-keyed ids light from the database (boardModel: proposing/planning/ready, then making/assembled),
  // and the brief's character, place and prop cards stay until the film has its own.
  const draft = !target && !!brief;
  const boardInput = useMemo<BoardInput | null>(() => {
    if (!target && brief) return { source: "brief", brief };
    if (load.state === "ready") return { source: "live", graph: load.graph };
    // Between Create and the film's first reading, the brief stays drawn: the same cards, about to light.
    if (brief && target && load.state === "loading") return { source: "brief", brief };
    return null;
  }, [target, brief, load]);
  // A conversation stays one plan across its Create (its film is the same plan); otherwise the plan is the target.
  const boardPlan = brain && !given ? `brain:${brain}` : target ? (target.kind === "window" ? `window:${target.channel}:${target.since}` : `${target.kind}:${target.id}`) : null;
  const graph = useBoardModel(boardInput, boardPlan)?.graph ?? null;
  const sel = graph?.nodes.find((n) => n.id === selected) ?? null;
  // The Activity lines. A film's reading gives the log's newest 50, so lines read earlier stay on screen (gathered by line id); a
  // run's routes answer the whole window, so its lines are replaced. Only a reading of THIS plan counts: for one render after a
  // switch the previous plan's reading is still on screen, and its lines must never land under the new plan (Lens HIGH).
  const planKey = target ? (target.kind === "window" ? `window:${target.channel}:${target.since}` : `${target.kind}:${target.id}`) : null;
  const reading = !draft && load.state === "ready" && load.key === planKey ? load.graph.activity ?? null : null;
  const [gathered, setGathered] = useState<{ key: string | null; items: ActivityItem[]; total: number | null }>({ key: null, items: [], total: null });
  useEffect(() => {
    if (!reading || !planKey) return;
    setGathered((prev) => {
      const byId = new Map(run || prev.key !== planKey ? [] : prev.items.map((it) => [it.id, it] as const));
      for (const it of reading.items) byId.set(it.id, it);
      const items = [...byId.values()].sort((x, y) => utc(x.at).getTime() - utc(y.at).getTime() || x.id.localeCompare(y.id));
      // The total is stored with the lines it counts, so "N not shown" never pairs a new total with the previous lines.
      return { key: planKey, items, total: reading.total };
    });
  }, [reading, planKey, run]);
  const activity: Activity | null =
    reading && gathered.key === planKey ? { items: gathered.items, total: gathered.total, cut: reading.cut } : null;
  // Closing the details gives focus back to the step it was opened from, not to the page (Pixel M2). The card is focused before the
  // panel unmounts: focusing it after, the browser has already dropped focus to <body>.
  const close = () => {
    const id = selected;
    if (id) [...document.querySelectorAll<HTMLElement>(".lv-card")].find((el) => el.dataset.testid === `live-node-${id}`)?.focus({ preventScroll: true });
    setSelected(null);
  };
  // Escape closes the details wherever focus is: after a click on another card focus is on that card, not in the panel (Lens).
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected]);
  // The steps that turned done since the last reading: only they play the "turning on" ring, never every done card on first load.
  const seen = useRef<Map<string, LiveStatus> | null>(null);
  const [lit, setLit] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!graph) return;
    const before = seen.current;
    setLit(new Set(before ? graph.nodes.filter((n) => n.status === "done" && before.has(n.id) && before.get(n.id) !== "done").map((n) => n.id) : []));
    seen.current = new Map(graph.nodes.map((n) => [n.id, n.status]));
  }, [graph]);

  let body: React.ReactNode;
  if (draft) body = null;
  else if (brain && !target && !brief) {
    const b = brainRead.load.state;
    body =
      b === "loading" ? (
        <p className="lv-muted" role="status" data-testid="live-loading">{c.briefLoading}</p>
      ) : b === "expired" ? (
        <p role="alert" data-testid="live-expired">
          {c.expired} <Link href={loginHref()}>{c.signIn}</Link>
        </p>
      ) : b === "notFound" ? (
        <p data-testid="live-notfound">{c.briefNotFound}</p>
      ) : b === "unavailable" ? (
        <p data-testid="live-unavailable">{c.briefUnavailable}</p>
      ) : (
        <div role="alert" data-testid="live-error">
          <p>{c.briefReadFailed}</p>
          <button type="button" className="cv-kbtn" onClick={brainRead.retry}>
            {c.retry}
          </button>
        </div>
      );
  } else if (!target) body = <p className="lv-muted" data-testid="live-notfound">{c.notFound}</p>;
  else if (!shown) body = <p className="lv-muted" data-testid="live-closed">{c.closed}</p>;
  else if (load.state === "loading") body = <p className="lv-muted" role="status" data-testid="live-loading">{c.loading}</p>;
  else if (load.state === "error")
    body = (
      <div role="alert" data-testid="live-error">
        <p>{c.readFailed}</p>
        <button type="button" className="cv-kbtn" onClick={retry}>
          {c.retry}
        </button>
      </div>
    );
  else if (load.state === "notFound") body = <p data-testid="live-notfound">{c.notFound}</p>;
  else if (load.state === "expired")
    body = (
      <p role="alert" data-testid="live-expired">
        {c.expired} <Link href={loginHref()}>{c.signIn}</Link>
      </p>
    );
  else if (load.state === "unavailable") body = <p data-testid="live-unavailable">{c.unavailable}</p>;
  else body = null;

  // A plan that cannot be shown here still leaves a way on (Pixel M11).
  const brainWaiting = !!brain && !target && !brief;
  const deadEnd =
    !graph &&
    (brainWaiting
      ? brainRead.load.state === "notFound" || brainRead.load.state === "unavailable"
      : !target || !shown || load.state === "notFound" || load.state === "unavailable");

  return (
    <div className="cv-root lv-root" data-studio-live="" data-testid="live-view">
      <header className="lv-head">
        <h1>{(draft && brief?.title) || (run ? c.runTitle : (load.state === "ready" && load.film?.film.view.film.title) || c.filmTitle)}</h1>
        <p className="lv-muted" data-testid={draft ? "live-draft-note" : undefined}>{draft ? c.draftNote : c.readOnly}</p>
        {run && target ? (
          <p className="lv-muted" data-testid="live-run-window">
            {target.kind === "window" ? c.runWindowSince : c.runWindow} {c.stagesLag}
          </p>
        ) : null}
        {graph && (graph.workflow !== undefined || graph.hold) ? <RunFacts graph={graph} /> : null}
        <p className="sr-only" role="status" aria-live="polite">
          {stale ? c.stale : graph?.settled ? c.settled : ""}
        </p>
        {stale ? <p className="lv-stale" data-testid="live-stale">{c.stale}</p> : null}
        {graph?.runError ? (
          <p className="lv-fail" role="status" data-testid="live-run-error">
            {c.runFailed} {failureText(t, { id: "run", kind: "render", status: "failed", error: graph.runError, col: 0, row: 0 }, true).reason}
          </p>
        ) : null}
        {graph?.settled ? <p className="lv-muted" data-testid="live-settled">{c.settled}</p> : null}
      </header>
      {body}
      {deadEnd ? (
        <Link className="cv-kbtn self-start" href={studioPath("/studio")} data-testid="live-back">
          {c.backToStudio}
        </Link>
      ) : null}
      {graph ? (
        <div className={`lv-main${sel ? " has-details" : ""}${activity ? " has-activity" : ""}`}>
          <StoryBoard graph={graph} selected={selected} onOpen={setSelected} lit={lit} />
          {sel ? <Details node={sel} run={run} filmId={target?.kind === "film" ? target.id : null} video={graph.video} onClose={close} /> : null}
        </div>
      ) : null}
      {target?.kind === "film" && shown && !draft ? <LiveLane load={load} planKey={planKey} stale={stale} selected={selected} onOpen={setSelected} retry={retry} /> : null}
      {graph && activity ? (
        // Below the board, never beside it: a side column narrows the board until its ends fall outside at 1280-1440 (Pixel HIGH).
        <ActivityPanel activity={activity} run={run} />
      ) : null}
    </div>
  );
}
