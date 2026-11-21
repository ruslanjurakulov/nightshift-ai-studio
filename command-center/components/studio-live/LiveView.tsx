"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { AudioLines, Clapperboard, FileText, Film, Flag, Image as ImageIcon, Lightbulb, MapPin, Music, Search, ShieldCheck, Sword, Upload, UserRound, Wand2, X, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { AssetDownloads } from "@/components/media/AssetDownloads";
import { Lamp } from "@/components/studio-canvas/parts";
import { useMediaUrls } from "@/components/studio-timeline/useTimelineData";
import { JOB_ERROR_CODES } from "@/lib/runBackend";
import { briefGraph, type Brief, type LiveGraph, type LiveNode, type LiveNodeKind, type LiveStatus } from "@/lib/studio/liveGraph";
import { useLiveGraph, type LiveTarget } from "./useLiveGraph";
import "@/components/studio-canvas/studio-canvas.css";
import "./studio-live.css";

const ICONS: Record<LiveNodeKind, LucideIcon> = {
  idea: Lightbulb,
  script: FileText,
  keyframe: ImageIcon,
  clip: Clapperboard,
  voice: AudioLines,
  music: Music,
  assembly: Wand2,
  final: Film,
  character: UserRound,
  location: MapPin,
  prop: Sword,
  topic: Flag,
  research: Search,
  visuals: ImageIcon,
  render: Clapperboard,
  gate: ShieldCheck,
  upload: Upload,
};

const TONE: Record<LiveStatus, "ok" | "run" | "fail" | "warn" | "idle"> = {
  draft: "idle",
  waiting: "idle",
  working: "run",
  done: "ok",
  failed: "fail",
  skipped: "idle",
  stopped: "warn",
  unknown: "warn",
  none: "idle",
};

const NARROW = "(max-width: 760px)";
const COL_W = 236;
const ROW_H = 124;

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(NARROW);
    setNarrow(m.matches);
    const on = () => setNarrow(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

type T = ReturnType<typeof useI18n>["t"];

/** system_events.ts is text, often a naive utcnow().isoformat(): read without an offset it would be local time (Lens M1). */
export function utc(ts: string): Date {
  return new Date(/([zZ]|[+-]\d\d:?\d\d)$/.test(ts) ? ts : `${ts}Z`);
}

export function nodeName(t: T, n: LiveNode): string {
  const kind = fmt(t.studioLive.kinds[n.kind], { n: n.scene ?? "" });
  // A character, place or prop is named by the brief: "Character · Aziz".
  return (n.kind === "character" || n.kind === "location" || n.kind === "prop") && n.sceneTitle ? `${kind} · ${n.sceneTitle}` : kind;
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

type CardData = { node: LiveNode; name: string; statusWord: string; price: string | null; selected: boolean; onOpen: (id: string) => void };

function CardView({ data }: NodeProps<Node<CardData, "step">>) {
  const Icon = ICONS[data.node.kind];
  return (
    <>
      <Handle type="target" position={Position.Left} className="lv-handle" isConnectable={false} />
      <button
        type="button"
        className={`lv-card is-${data.node.status}${data.selected ? " is-selected" : ""}`}
        data-testid={`live-node-${data.node.id}`}
        data-status={data.node.status}
        aria-pressed={data.selected}
        onClick={() => data.onOpen(data.node.id)}
      >
        <span className="lv-card-head">
          <Icon aria-hidden className="size-4" />
          <span className="lv-card-name">{data.name}</span>
        </span>
        <Lamp tone={TONE[data.node.status]} live={data.node.status === "working"} label={data.statusWord} />
        {data.price ? <span className="lv-price">{data.price}</span> : null}
      </button>
      <Handle type="source" position={Position.Right} className="lv-handle" isConnectable={false} />
    </>
  );
}

const NODE_TYPES = { step: CardView };

type ViewProps = { graph: LiveGraph; selected: string | null; onOpen: (id: string) => void; names: Map<string, string>; words: Map<string, string>; prices: Map<string, string> };

function Board({ graph, selected, onOpen, names, words, prices }: ViewProps) {
  const nodes = useMemo<Node<CardData, "step">[]>(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: "step",
        position: { x: n.col * COL_W, y: n.row * ROW_H },
        data: { node: n, name: names.get(n.id) ?? n.id, statusWord: words.get(n.id) ?? "", price: prices.get(n.id) ?? null, selected: selected === n.id, onOpen },
        draggable: false,
        connectable: false,
        selectable: false,
      })),
    [graph, selected, onOpen, names, words, prices],
  );
  const status = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.status])), [graph]);
  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e) => ({
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        className: status.get(e.from) === "done" && status.get(e.to) === "working" ? "lv-edge is-live" : status.get(e.from) === "done" ? "lv-edge is-done" : "lv-edge",
        selectable: false,
        focusable: false,
      })),
    [graph, status],
  );
  return (
    <div className="lv-board" data-testid="live-board">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.3}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        />
      </ReactFlowProvider>
    </div>
  );
}

function List({ graph, selected, onOpen, names, words, prices }: ViewProps) {
  const order = [...graph.nodes].sort((a, b) => a.col - b.col || a.row - b.row);
  return (
    <ol className="lv-list" data-testid="live-list">
      {order.map((n) => {
        const Icon = ICONS[n.kind];
        return (
          <li key={n.id}>
            <button
              type="button"
              className={`lv-card is-${n.status}${selected === n.id ? " is-selected" : ""}`}
              data-testid={`live-node-${n.id}`}
              data-status={n.status}
              aria-pressed={selected === n.id}
              onClick={() => onOpen(n.id)}
            >
              <span className="lv-card-head">
                <Icon aria-hidden className="size-4" />
                <span className="lv-card-name">{names.get(n.id)}</span>
              </span>
              <Lamp tone={TONE[n.status]} live={n.status === "working"} label={words.get(n.id) ?? ""} />
              {prices.get(n.id) ? <span className="lv-price">{prices.get(n.id)}</span> : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Output({ node }: { node: LiveNode }) {
  const { t } = useI18n();
  const ids = useMemo(() => (node.assetId ? [node.assetId] : []), [node.assetId]);
  const { urls } = useMediaUrls(ids);
  if (!node.assetId) return node.text ? <p className="lv-text">{node.text}</p> : <p className="lv-muted">{t.studioLive.noOutput}</p>;
  const m = urls.get(node.assetId);
  if (!m) return <p className="lv-muted">{t.studioLive.loading}</p>;
  if (m.failed || m.unavailable || !m.play) return <p className="lv-muted">{t.studioLive.outputUnavailable}</p>;
  // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived library link
  if (m.kind === "image") return <img className="lv-media" src={m.thumb ?? m.play} alt="" />;
  if (m.kind === "audio") return <audio className="lv-audio" src={m.play} controls preload="none" />;
  return <video className="lv-media" src={m.play} poster={m.thumb ?? undefined} controls preload="metadata" playsInline />;
}

function Details({ node, run, filmId, onClose }: { node: LiveNode; run: boolean; filmId: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const c = t.studioLive;
  const path = useChannelPath();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), [node.id]);
  const credit = (v: number | null) => (v === null ? c.creditsUnrecorded : String(v));
  return (
    <aside className="lv-details" aria-label={c.details} data-testid="live-details">
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
        <p data-testid="live-privacy">{node.privacy === "private" ? c.privacyPrivate : node.privacy ? fmt(c.privacyOther, { privacy: node.privacy }) : c.privacyUnknown}</p>
      ) : null}
      {!run ? (
        <p className="lv-muted" data-testid="live-credits">
          {node.credits ? fmt(c.credits, { held: credit(node.credits.held), charged: credit(node.credits.charged) }) : c.creditsNone}
        </p>
      ) : node.at ? (
        <p className="lv-muted">{fmt(c.recordedAt, { time: utc(node.at).toLocaleString() })}</p>
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
export function LiveView({ filmStudio, target, brief = null }: { filmStudio: boolean; target: LiveTarget | null; brief?: Brief | null }) {
  const { t } = useI18n();
  const c = t.studioLive;
  const narrow = useNarrow();
  const run = target?.kind === "run" || target?.kind === "window";
  const shown = filmStudio || run ? target : null;
  const { load, stale, retry } = useLiveGraph(shown);
  const [selected, setSelected] = useState<string | null>(null);
  // Before Create there is no target: the brief so far is drawn as DRAFT steps (no lamp, a price only where the backend gave one).
  // After Create the same ids light from the database, so nothing is redrawn.
  const draft = useMemo(() => (!target && brief ? briefGraph(brief) : null), [target, brief]);
  const graph = draft ?? (load.state === "ready" ? load.graph : null);
  const names = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, nodeName(t, n)])), [graph, t]);
  const words = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, c.status[n.status]])), [graph, c]);
  const prices = useMemo(
    () => new Map((graph?.nodes ?? []).filter((n) => typeof n.price === "number").map((n) => [n.id, fmt(c.price, { n: n.price as number })])),
    [graph, c],
  );
  const sel = graph?.nodes.find((n) => n.id === selected) ?? null;

  let body: React.ReactNode;
  if (draft) body = null;
  else if (!target) body = <p className="lv-muted" data-testid="live-notfound">{c.notFound}</p>;
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
        {c.expired} <Link href="/login">{c.signIn}</Link>
      </p>
    );
  else if (load.state === "unavailable") body = <p data-testid="live-unavailable">{c.unavailable}</p>;
  else body = null;

  return (
    <div className="cv-root lv-root" data-studio-live="" data-testid="live-view">
      <header className="lv-head">
        <h1>{run ? c.runTitle : (load.state === "ready" && load.film?.film.view.film.title) || c.filmTitle}</h1>
        <p className="lv-muted" data-testid={draft ? "live-draft-note" : undefined}>{draft ? c.draftNote : c.readOnly}</p>
        {run ? <p className="lv-muted" data-testid="live-run-window">{target?.kind === "window" ? c.runWindowSince : c.runWindow}</p> : null}
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
      {graph ? (
        <div className={sel ? "lv-main has-details" : "lv-main"}>
          {narrow ? (
            <List graph={graph} selected={selected} onOpen={setSelected} names={names} words={words} prices={prices} />
          ) : (
            <Board graph={graph} selected={selected} onOpen={setSelected} names={names} words={words} prices={prices} />
          )}
          {sel ? <Details node={sel} run={run} filmId={target?.kind === "film" ? target.id : null} onClose={() => setSelected(null)} /> : null}
        </div>
      ) : null}
    </div>
  );
}
