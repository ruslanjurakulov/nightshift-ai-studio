"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  AudioLines,
  Check,
  ChevronDown,
  Clapperboard,
  Film,
  Hand,
  Image as ImageIcon,
  Layers,
  LayoutGrid,
  Maximize,
  Minus,
  MousePointer2,
  Palette,
  Plus,
  Projector,
  Search,
  Sparkles,
  Wand2,
  X,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { useShell } from "@/components/shell/ShellContext";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { ICONS } from "@/components/navigation/navIcons";
import { useLibraryImages } from "@/components/studio/useLibraryImages";
import { refreshCredits } from "@/lib/credits-live";
import { coerceJobs, failureReason, isActiveStatus, statusView, type StudioJob } from "@/lib/creative/studio";
import { studioTilesFor } from "@/lib/navigation";
import {
  EMPTY_STATE,
  KIND_SPEC,
  NODE_H,
  NODE_W,
  RECIPES,
  TOOL_KINDS,
  canWire,
  clampZoom,
  connect,
  depthOf,
  disconnect,
  fitView,
  flowOrder,
  layoutKey,
  loadLayout,
  newNode,
  nextSpot,
  outputType,
  recipeState,
  removeNode,
  saveLayout,
  tidy,
  toCanvas,
  wireInto,
  wirePath,
  zoomAt,
  type CanvasNode,
  type CanvasState,
  type NodeKind,
  type PortType,
  type Recipe,
  type ToolKind,
  type Viewport,
  type WireRefusal,
} from "@/lib/studio/canvas";
import { ASSET_MIME, LibraryDrawer, readDrop, type DroppedAsset } from "./LibraryDrawer";
import { Inspector, type PanelData } from "./Inspector";
import { LAMP, inputOf, kindOpen, nodeAsset, nodeStatus, type JobReading, type NodeStatus } from "./nodeState";
import "./studio-canvas.css";

export const KIND_ICONS: Record<NodeKind, LucideIcon> = {
  image: ImageIcon,
  video: Clapperboard,
  animate: Film,
  effects: Sparkles,
  enhance: Wand2,
  voice: AudioLines,
  asset: Layers,
};

const PORT_LETTER: Record<PortType, string> = { image: "I", video: "V", audio: "A" };
const JOB_POLL_MS = 5000;
const NARROW = "(max-width: 760px)";

const makeId = () => {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  } catch {
    return Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  }
};

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Nightshift Studio's canvas (docs/studio/STUDIO_IA.md §2, the person's `sketch` project, prototype in
 * docs/studio/prototype/). Every tool is a node; a wire is a real input; the inspector is the existing
 * composer; results land on the node from the job the database reports.
 *
 * What it never does: price or start anything by itself (rule 3: only the composer's quote → start does),
 * put another model in place of one that is off (rule 4), or show a state it did not read (rule 5: an
 * unreadable job is "unknown"). The layout (positions and wires) lives in this browser only, per
 * organization, channel and person, until a studio_layouts table exists.
 */
export function StudioCanvas({
  data,
  userId,
  channel,
  filmStudio,
}: {
  data: PanelData;
  userId: string;
  channel: string;
  /** NIGHTSHIFT_FILM_STUDIO, resolved for this viewer by the server: the Projects entry is listed only then. */
  filmStudio: boolean;
}) {
  const { t, fmt } = useI18n();
  const c = t.studioCanvas;
  const { tools: availability, operator, features } = useShell();
  const narrow = useNarrow();
  const orgId = data.orgId;
  const key = orgId ? layoutKey(orgId, channel, userId) : null;

  const [canvas, setCanvas] = useState<CanvasState>(EMPTY_STATE);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState<null | "all" | "add">(null);
  const [mode, setMode] = useState<"select" | "hand">("select");
  const [showMap, setShowMap] = useState(true);
  const [firstRunDone, setFirstRunDone] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Map<string, JobReading>>(() => new Map());
  const library = useLibraryImages(orgId ?? "", { enabled: !!orgId });
  const libraryRef = useRef(library);
  libraryRef.current = library;

  // ── layout: read once, then saved on every change (this browser only) ──────
  useEffect(() => {
    setCanvas(key ? loadLayout(storage(), key) : EMPTY_STATE);
    setLoaded(true);
  }, [key]);
  useEffect(() => {
    if (!loaded || !key) return;
    const id = setTimeout(() => setSaved(saveLayout(storage(), key, canvas)), 250);
    return () => clearTimeout(id);
  }, [canvas, loaded, key]);

  const say = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 3200);
  }, []);

  // ── jobs: each node's own generation, read as the member, polled while working ──
  const jobIds = useMemo(() => [...new Set(canvas.nodes.map((n) => n.jobId).filter((x): x is string => !!x))], [canvas.nodes]);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const readJob = useCallback(async (id: string): Promise<JobReading> => {
    try {
      const res = await fetch(`/api/creative/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!res.ok) return { state: "unknown" };
      const body = (await res.json().catch(() => ({}))) as { job?: unknown };
      const job = coerceJobs([body.job])[0] as StudioJob | undefined;
      return job ? { state: "ok", job } : { state: "unknown" };
    } catch {
      return { state: "unknown" };
    }
  }, []);
  const refresh = useCallback(
    async (ids: readonly string[]) => {
      if (ids.length === 0) return;
      const read = await Promise.all(ids.map(async (id) => [id, await readJob(id)] as const));
      let finished = false;
      setJobs((prev) => {
        const next = new Map(prev);
        for (const [id, r] of read) {
          const before = prev.get(id);
          const wasActive = before?.state === "ok" && isActiveStatus(before.job.status);
          if (wasActive && r.state === "ok" && !isActiveStatus(r.job.status)) finished = true;
          next.set(id, r);
        }
        return next;
      });
      // A job that just ended charged or released its hold, and may have put a file in the library.
      if (finished) {
        if (orgId) void refreshCredits(orgId);
        libraryRef.current.reload();
      }
    },
    [readJob, orgId],
  );
  useEffect(() => {
    const unread = jobIds.filter((id) => !jobsRef.current.has(id));
    if (unread.length) {
      setJobs((prev) => {
        const next = new Map(prev);
        for (const id of unread) next.set(id, { state: "loading" });
        return next;
      });
      void refresh(unread);
    }
  }, [jobIds, refresh]);
  const activeIds = jobIds.filter((id) => {
    const r = jobs.get(id);
    return r?.state === "ok" && (isActiveStatus(r.job.status) || r.job.status === "queued");
  });
  const activeKey = activeIds.join(",");
  useEffect(() => {
    if (!activeKey) return;
    const ids = activeKey.split(",");
    const id = setInterval(() => void refresh(ids), JOB_POLL_MS);
    return () => clearInterval(id);
  }, [activeKey, refresh]);

  // ── derived ────────────────────────────────────────────────────────────────
  const libReady = library.state === "ready";
  const statusOf = useCallback(
    (n: CanvasNode): NodeStatus => nodeStatus(canvas, n, jobs, availability, { ready: libReady, previews: library.previews }),
    [canvas, jobs, availability, libReady, library.previews],
  );
  const kindName = useCallback((k: NodeKind) => c.kinds[k].name, [c]);
  const nodeName = useCallback(
    (n: CanvasNode): string => {
      if (n.kind === "asset") {
        const lib = [...library.images, ...library.recordings].find((x) => x.id === n.assetId);
        return lib?.name || c.kinds.asset.name;
      }
      const same = canvas.nodes.filter((m) => m.kind === n.kind);
      const label = n.kind === "effects" && n.effectId && n.effectId in t.effects.items ? t.effects.items[n.effectId as keyof typeof t.effects.items].name : kindName(n.kind);
      return same.length > 1 ? `${label} ${same.findIndex((m) => m.id === n.id) + 1}` : label;
    },
    [canvas.nodes, library.images, library.recordings, c, kindName, t],
  );
  const counts = useMemo(() => {
    const out: Partial<Record<NodeStatus, number>> = {};
    for (const n of canvas.nodes) {
      const s = statusOf(n);
      out[s] = (out[s] ?? 0) + 1;
    }
    return out;
  }, [canvas.nodes, statusOf]);
  const sel = canvas.nodes.find((n) => n.id === selected) ?? null;

  // ── edits (all free: they move boxes and draw lines) ─────────────────────────
  const boardRef = useRef<HTMLDivElement>(null);
  const boardSize = () => {
    const r = boardRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 1200, h: r?.height ?? 700 };
  };
  const centreSpot = () => {
    const { w, h } = boardSize();
    const p = toCanvas(canvas.view, w / 2, h / 2);
    return { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 };
  };
  const addNode = (kind: NodeKind, at?: { x: number; y: number }, extra: Partial<CanvasNode> = {}) => {
    const id = makeId();
    const spot = at ?? (canvas.nodes.length ? nextSpot(canvas.nodes) : centreSpot());
    setCanvas((s) => ({ ...s, nodes: [...s.nodes, newNode(kind, spot.x, spot.y, id, extra)] }));
    setSelected(id);
    if (kind !== "asset") setInspecting(true);
    setFirstRunDone(true);
    return id;
  };
  const patchNode = (id: string, patch: Partial<CanvasNode>) =>
    setCanvas((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  const wire = (from: string, to: string) => {
    const check = canWire(canvas, from, to);
    if (!check.ok) {
      say(c.wire[check.why as WireRefusal]);
      return false;
    }
    setCanvas((s) => connect(s, from, to, makeId()));
    return true;
  };
  const dropAsset = (a: DroppedAsset, at?: { x: number; y: number }, onto?: string) => {
    const target = onto ? canvas.nodes.find((n) => n.id === onto) : undefined;
    if (target && KIND_SPEC[target.kind].accepts.includes(a.kind)) {
      // Onto a node's input: the file sits beside it, wired in at once.
      const id = makeId();
      const node = newNode("asset", target.x - NODE_W - 96, target.y, id, { assetId: a.id, assetKind: a.kind });
      setCanvas((s) => connect({ ...s, nodes: [...s.nodes, node] }, id, target.id, makeId()));
      setSelected(target.id);
      setInspecting(true);
      setFirstRunDone(true);
      return;
    }
    if (target) say(c.wire.wrong_type);
    addNode("asset", at, { assetId: a.id, assetKind: a.kind });
  };
  const startRecipe = (r: Recipe) => {
    const next = recipeState(r, makeId);
    setCanvas((s) => ({ ...next, view: s.view }));
    setFirstRunDone(true);
    setSelected(next.nodes[next.nodes.length - 1]?.id ?? null);
    if (r === "photoClip") setDrawer(true);
    requestAnimationFrame(() => fit(next.nodes));
  };
  const deleteSelected = () => {
    if (!selected) return;
    setCanvas((s) => removeNode(s, selected));
    setSelected(null);
    setInspecting(false);
  };
  const setView = (v: Viewport | ((v: Viewport) => Viewport)) => setCanvas((s) => ({ ...s, view: typeof v === "function" ? v(s.view) : v }));
  const fit = (nodes: readonly CanvasNode[] = canvas.nodes) => {
    const { w, h } = boardSize();
    setView(fitView(nodes, w, h));
  };
  const zoomBy = (f: number) => {
    const { w, h } = boardSize();
    setView((v) => zoomAt(v, v.k * f, w / 2, h / 2));
  };

  // First open with a stored layout and no stored view: show all of it.
  const fitted = useRef(false);
  useEffect(() => {
    if (!loaded || fitted.current || narrow) return;
    fitted.current = true;
    if (canvas.nodes.length && canvas.view.x === 0 && canvas.view.y === 0 && canvas.view.k === 1) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, narrow]);

  // ── keys: N adds, ⌘K searches, Delete removes, + / − / 0 zoom ──────────────────
  const rootRef = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState(false);
  useEffect(() => {
    const typing = (el: EventTarget | null) => {
      const e = el as HTMLElement | null;
      return !!e && (e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT" || e.isContentEditable);
    };
    function onKey(e: KeyboardEvent) {
      // ⌘K belongs to the canvas while it is open: it adds and opens, like the prototype's bar. Caught before the app's palette.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPalette((p) => (p ? null : "all"));
        return;
      }
      if (typing(e.target) || document.querySelector('[role="dialog"]')) return;
      if (e.key === " " && !e.repeat) setSpace(true);
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setPalette("add");
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === "+" || e.key === "=") zoomBy(1.2);
      else if (e.key === "-") zoomBy(1 / 1.2);
      else if (e.key === "0") fit();
      else if (e.key === "Escape") {
        setInspecting(false);
        setSelected(null);
      } else if (selected && e.key.startsWith("Arrow")) {
        // The keyboard's way to move a node (no drag needed).
        e.preventDefault();
        const step = e.shiftKey ? 64 : 16;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        setCanvas((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === selected ? { ...n, x: n.x + dx, y: n.y + dy } : n)) }));
      }
    }
    function onUp(e: KeyboardEvent) {
      if (e.key === " ") setSpace(false);
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp);
    };
  });

  // The workspace fills the window below the app's header, so the canvas never makes the page scroll.
  useLayoutEffect(() => {
    if (narrow) return;
    const el = rootRef.current;
    if (!el) return;
    const size = () => el.style.setProperty("--sc-top", `${Math.max(0, el.getBoundingClientRect().top + window.scrollY)}px`);
    size();
    window.addEventListener("resize", size);
    return () => window.removeEventListener("resize", size);
  }, [narrow]);

  const status = (
    <div className="sc-strip" data-testid="canvas-status">
      {canvas.nodes.length === 0 ? (
        <span>{c.statusEmpty}</span>
      ) : (
        <>
          <span className="font-semibold">{fmt(c.statusNodes, { n: canvas.nodes.length })}</span>
          {!!counts.working && <StatusLamp tone="run" live label={fmt(c.statusWorking, { n: counts.working })} />}
          {!!counts.done && <StatusLamp tone="ok" label={fmt(c.statusDone, { n: counts.done })} />}
          {!!counts.failed && <StatusLamp tone="fail" label={fmt(c.statusFailed, { n: counts.failed })} />}
          {!!counts.needs && <StatusLamp tone="warn" label={fmt(c.statusNeeds, { n: counts.needs })} />}
          {!!counts.unknown && <StatusLamp tone="warn" label={fmt(c.statusUnknown, { n: counts.unknown })} />}
          {!!counts.closed && <StatusLamp tone="idle" label={fmt(c.statusClosed, { n: counts.closed })} />}
        </>
      )}
      {!saved && <span className="sc-strip-note">{c.notSaved}</span>}
    </div>
  );

  const bar = (
    <ProjectBar
      filmStudio={filmStudio}
      operator={operator}
      features={features}
      onSearch={() => setPalette("all")}
    />
  );

  const inspector =
    sel && inspecting ? (
      <Inspector
        node={sel}
        state={canvas}
        jobs={jobs}
        status={statusOf(sel)}
        closed={!kindOpen(availability, sel.kind)}
        data={data}
        previews={library.previews}
        nodeName={nodeName}
        sheet={narrow}
        onClose={() => setInspecting(false)}
        onDraft={(words) => {
          if (words !== sel.draft) patchNode(sel.id, { draft: words.slice(0, 4000) });
        }}
        onCreated={(jobId) => {
          patchNode(sel.id, { jobId });
          setJobs((prev) => new Map(prev).set(jobId, { state: "loading" }));
          void refresh([jobId]);
        }}
        onWire={(from) => wire(from, sel.id)}
        onDisconnect={() => setCanvas((s) => disconnect(s, sel.id))}
        onEffect={(effectId) => patchNode(sel.id, { effectId })}
      />
    ) : null;

  const drawerEl = drawer ? (
    <LibraryDrawer
      state={orgId ? library.state : "unavailable"}
      images={library.images}
      recordings={library.recordings}
      onReload={() => library.reload()}
      onAdd={(a) => {
        if (sel && KIND_SPEC[sel.kind].accepts.includes(a.kind) && !wireInto(canvas, sel.id)) dropAsset(a, undefined, sel.id);
        else dropAsset(a);
        if (narrow) setDrawer(false);
      }}
      onClose={() => setDrawer(false)}
      sheet={narrow}
    />
  ) : null;

  const paletteEl = palette ? (
    <CanvasPalette
      mode={palette}
      filmStudio={filmStudio}
      onClose={() => setPalette(null)}
      onAdd={(k) => {
        addNode(k);
        setPalette(null);
      }}
    />
  ) : null;

  const showFirstRun = loaded && canvas.nodes.length === 0 && !firstRunDone;
  const firstRun = showFirstRun ? <FirstRun filmStudio={filmStudio} onRecipe={startRecipe} onBlank={() => setFirstRunDone(true)} /> : null;
  const live = (
    <div className="sr-only" role="status" aria-live="polite">
      {notice}
    </div>
  );

  if (!loaded) {
    return (
      <div className="sc-root" data-studio-canvas="" ref={rootRef}>
        {bar}
        <p className="sc-loading" role="status">
          {c.loading}
        </p>
      </div>
    );
  }

  if (narrow) {
    return (
      <div className="sc-root is-flow" data-studio-canvas="" ref={rootRef}>
        {bar}
        {status}
        {live}
        {notice && <p className="sc-toast">{notice}</p>}
        {firstRun ?? (
          <FlowView
            canvas={canvas}
            statusOf={statusOf}
            nodeName={nodeName}
            jobs={jobs}
            previews={library.previews}
            onOpen={(id) => {
              setSelected(id);
              setInspecting(true);
            }}
          />
        )}
        <div className="sc-flow-dock" role="toolbar" aria-label={c.dock.label}>
          <button type="button" className="sc-dock-btn" onClick={() => setPalette("add")}>
            <Plus aria-hidden className="size-4" /> {c.dock.add}
          </button>
          <button type="button" className="sc-dock-btn" onClick={() => setDrawer(true)} aria-label={c.dock.library} title={c.dock.library}>
            <Layers aria-hidden className="size-4" />
          </button>
          <QuoteKey node={sel} onOpen={() => setInspecting(true)} />
        </div>
        {(inspector || drawerEl) && (
          <div
            className="sc-sheet-scrim"
            onClick={() => {
              setInspecting(false);
              setDrawer(false);
            }}
            aria-hidden
          />
        )}
        {inspector}
        {drawerEl}
        {paletteEl}
      </div>
    );
  }

  return (
    <div className="sc-root" data-studio-canvas="" ref={rootRef} data-mode={space ? "hand" : mode}>
      {bar}
      {status}
      <div className="sc-main">
        {drawerEl}
        <Board
          boardRef={boardRef}
          canvas={canvas}
          setCanvas={setCanvas}
          selected={selected}
          onSelect={(id) => {
            setSelected(id);
            setInspecting(!!id);
          }}
          hand={mode === "hand" || space}
          statusOf={statusOf}
          nodeName={nodeName}
          jobs={jobs}
          previews={library.previews}
          onWire={wire}
          onDrop={dropAsset}
          showMap={showMap}
          onToggleMap={() => setShowMap((m) => !m)}
        >
          {firstRun}
          {!firstRun && canvas.nodes.length === 0 && (
            <p className="sc-empty-hint">{c.firstRun.blank.desc}</p>
          )}
          {notice && <p className="sc-toast">{notice}</p>}
          {live}
        </Board>
        {inspector}
      </div>
      <div className="sc-dock" role="toolbar" aria-label={c.dock.label}>
        <button type="button" className="sc-dock-btn" onClick={() => setPalette("add")} aria-haspopup="dialog" data-testid="dock-add">
          <Plus aria-hidden className="size-4" /> {c.dock.add}
        </button>
        <button type="button" className="sc-dock-btn" aria-pressed={drawer} onClick={() => setDrawer((d) => !d)} data-testid="dock-library">
          <Layers aria-hidden className="size-4" /> {c.dock.library}
        </button>
        <div className="sc-seg" role="group">
          <button type="button" className="sc-dock-btn" aria-pressed={mode === "select"} onClick={() => setMode("select")} aria-label={c.dock.select} title={c.dock.select}>
            <MousePointer2 aria-hidden className="size-4" />
          </button>
          <button type="button" className="sc-dock-btn" aria-pressed={mode === "hand"} onClick={() => setMode("hand")} aria-label={c.dock.hand} title={c.dock.hand}>
            <Hand aria-hidden className="size-4" />
          </button>
        </div>
        <button type="button" className="sc-dock-btn" onClick={() => setCanvas((s) => tidy(s))} disabled={canvas.nodes.length < 2}>
          <LayoutGrid aria-hidden className="size-4" /> {c.dock.tidy}
        </button>
        <div className="sc-seg" role="group">
          <button type="button" className="sc-dock-btn" onClick={() => zoomBy(1 / 1.2)} aria-label={c.dock.zoomOut} title={c.dock.zoomOut}>
            <Minus aria-hidden className="size-4" />
          </button>
          <span className="sc-zoom" aria-live="off" title={fmt(c.dock.zoom, { n: Math.round(canvas.view.k * 100) })}>
            {Math.round(canvas.view.k * 100)}%
          </span>
          <button type="button" className="sc-dock-btn" onClick={() => zoomBy(1.2)} aria-label={c.dock.zoomIn} title={c.dock.zoomIn}>
            <ZoomIn aria-hidden className="size-4" />
          </button>
          <button type="button" className="sc-dock-btn" onClick={() => fit()} aria-label={c.dock.fit} title={c.dock.fit}>
            <Maximize aria-hidden className="size-4" />
          </button>
        </div>
        <span className="sc-dock-spacer" />
        <span className="sc-dock-note">{c.nothingSpends}</span>
        <QuoteKey node={sel} onOpen={() => setInspecting(true)} />
      </div>
      {paletteEl}
    </div>
  );
}

/** The dock's price key: the price lives in the selected node's form (its backend quote), so it opens that form. */
function QuoteKey({ node, onOpen }: { node: CanvasNode | null; onOpen: () => void }) {
  const { t } = useI18n();
  const c = t.studioCanvas;
  const can = !!node && node.kind !== "asset";
  return (
    <button type="button" className="sc-quote" disabled={!can} onClick={onOpen} title={can ? c.quote : c.quoteHint} data-testid="dock-quote">
      {c.quote}
    </button>
  );
}

// ── the project bar ──────────────────────────────────────────────────────────

function ProjectBar({
  filmStudio,
  operator,
  features,
  onSearch,
}: {
  filmStudio: boolean;
  operator: boolean;
  features: Parameters<typeof studioTilesFor>[1];
  onSearch: () => void;
}) {
  const { t } = useI18n();
  const c = t.studioCanvas;
  const path = useChannelPath();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const tiles = studioTilesFor(operator, features).filter((x) => x.key !== "create" && x.key !== "editor");
  return (
    <div className="sc-bar">
      <div className="relative" ref={menu}>
        <button type="button" className="sc-switch" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)} aria-label={c.switcher} data-testid="project-switcher">
          <span className="flex min-w-0 flex-col items-start leading-tight">
            <span className="sc-switch-title">{c.sketch}</span>
            <span className="sc-switch-sub">{c.sketchSub}</span>
          </span>
          <ChevronDown aria-hidden className="size-4 shrink-0" />
        </button>
        {open && (
          <div className="sc-menu" role="menu" aria-label={c.switcher}>
            <p className="sc-menu-group">{c.views}</p>
            <MenuLink href={path("/studio")} icon={<Check aria-hidden className="size-4" />} label={c.viewCanvas} current />
            <MenuLink href={path("/studio?shelf=videos")} icon={<Film aria-hidden className="size-4" />} label={c.viewVideos} />
            <MenuLink href={path("/studio?shelf=projects")} icon={<ICONS.editor aria-hidden className="size-4" />} label={c.viewEditor} />
            {filmStudio && (
              <MenuLink href={path("/create/projects")} icon={<Projector aria-hidden className="size-4" />} label={c.projects} sub={c.projectsSub} testid="menu-projects" />
            )}
            <p className="sc-menu-group">{c.tools}</p>
            {tiles.map((tile) => {
              const Icon = tile.key === "presets" ? LayoutGrid : ICONS[tile.key];
              return <MenuLink key={tile.href} href={path(tile.href)} icon={<Icon aria-hidden className="size-4" />} label={tile.key === "presets" ? t.presets.title : t.nav[tile.key]} />;
            })}
          </div>
        )}
      </div>
      {/* Brand look, one click from where its old bookmark lands (STUDIO_IA.md §9.1). */}
      <Link href={path("/studio/look")} className="sc-chip-link" data-testid="channel-look-chip">
        <Palette aria-hidden className="size-4" />
        <span>{t.studioHub.channelLook}</span>
      </Link>
      <span className="sc-bar-spacer" />
      <button type="button" className="sc-search" onClick={onSearch} data-testid="canvas-search">
        <Search aria-hidden className="size-4" />
        <span className="sc-search-label">{c.search}</span>
        <kbd className="sc-kbd">⌘K</kbd>
      </button>
    </div>
  );
}

function MenuLink({ href, icon, label, sub, current = false, testid }: { href: string; icon: ReactNode; label: string; sub?: string; current?: boolean; testid?: string }) {
  return (
    <Link href={href} role="menuitem" className="sc-menu-item" aria-current={current ? "page" : undefined} data-testid={testid}>
      {icon}
      <span className="flex min-w-0 flex-col">
        <span>{label}</span>
        {sub && <span className="sc-note">{sub}</span>}
      </span>
    </Link>
  );
}

// ── the board: pan, zoom, nodes, wires, minimap ───────────────────────────────

type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "node"; id: string; sx: number; sy: number; ox: number; oy: number }
  | { kind: "wire"; from: string };

function Board({
  boardRef,
  canvas,
  setCanvas,
  selected,
  onSelect,
  hand,
  statusOf,
  nodeName,
  jobs,
  previews,
  onWire,
  onDrop,
  showMap,
  onToggleMap,
  children,
}: {
  boardRef: React.RefObject<HTMLDivElement | null>;
  canvas: CanvasState;
  setCanvas: React.Dispatch<React.SetStateAction<CanvasState>>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  hand: boolean;
  statusOf: (n: CanvasNode) => NodeStatus;
  nodeName: (n: CanvasNode) => string;
  jobs: ReadonlyMap<string, JobReading>;
  previews: ReadonlyMap<string, { thumbUrl: string | null; kind: string }>;
  onWire: (from: string, to: string) => boolean;
  onDrop: (a: DroppedAsset, at: { x: number; y: number }, onto?: string) => void;
  showMap: boolean;
  onToggleMap: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const c = t.studioCanvas;
  const view = canvas.view;
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; k: number } | null>(null);
  const [tip, setTip] = useState<{ from: string; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = boardRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const setView = (v: Viewport) => setCanvas((s) => ({ ...s, view: v }));

  // The wheel pans; with Ctrl/⌘ (and a trackpad pinch, which the browser reports the same way) it zooms at the cursor.
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest(".sc-map")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        setCanvas((s) => ({ ...s, view: zoomAt(s.view, s.view.k * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top) }));
      } else {
        setCanvas((s) => ({ ...s, view: { ...s.view, x: s.view.x - e.deltaX, y: s.view.y - e.deltaY } }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [boardRef, setCanvas]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: view.k };
      drag.current = null;
      return;
    }
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const target = e.target as Element;
    if (target.closest(".sc-map, .sc-firstrun, .sc-toast")) return;
    const port = target.closest<HTMLElement>("[data-port-out]");
    if (port && !hand) {
      drag.current = { kind: "wire", from: port.dataset.portOut! };
      const w = toCanvas(view, p.x, p.y);
      setTip({ from: port.dataset.portOut!, x: w.x, y: w.y });
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return;
    }
    const nodeEl = target.closest<HTMLElement>("[data-node-id]");
    if (nodeEl && !hand) {
      if (target.closest("button, a, input, select, textarea")) return;
      const n = canvas.nodes.find((m) => m.id === nodeEl.dataset.nodeId);
      if (!n) return;
      onSelect(n.id);
      drag.current = { kind: "node", id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return;
    }
    if (target.closest("button, a, input, select, textarea")) return;
    if (!nodeEl) onSelect(null);
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, local(e));
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      setView(zoomAt(view, clampZoom((pinch.current.k * d) / pinch.current.d), (a.x + b.x) / 2, (a.y + b.y) / 2));
      return;
    }
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") setView({ ...view, x: d.vx + (e.clientX - d.sx), y: d.vy + (e.clientY - d.sy) });
    else if (d.kind === "node") {
      const x = Math.round(d.ox + (e.clientX - d.sx) / view.k);
      const y = Math.round(d.oy + (e.clientY - d.sy) / view.k);
      setCanvas((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === d.id ? { ...n, x, y } : n)) }));
    } else {
      const w = toCanvas(view, local(e).x, local(e).y);
      setTip({ from: d.from, x: w.x, y: w.y });
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "wire") {
      setTip(null);
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-node-id]");
      const to = under?.dataset.nodeId;
      if (to && to !== d.from) onWire(d.from, to);
    }
  };

  const nodesById = new Map(canvas.nodes.map((n) => [n.id, n]));
  const from = tip ? nodesById.get(tip.from) : undefined;

  return (
    <div
      ref={boardRef}
      className="sc-board"
      data-hand={hand ? "true" : undefined}
      style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.k}px ${24 * view.k}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(ASSET_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        const over = (e.target as Element).closest<HTMLElement>("[data-node-id]")?.dataset.nodeId ?? null;
        if (over !== dropTarget) setDropTarget(over);
      }}
      onDragLeave={() => setDropTarget(null)}
      onDrop={(e) => {
        const a = readDrop(e.dataTransfer.getData(ASSET_MIME));
        setDropTarget(null);
        if (!a) return;
        e.preventDefault();
        const p = local(e);
        const w = toCanvas(view, p.x, p.y);
        const onto = (e.target as Element).closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
        onDrop(a, { x: w.x - NODE_W / 2, y: w.y - NODE_H / 2 }, onto);
      }}
      data-testid="canvas-board"
    >
      <div className="sc-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="sc-wires" aria-hidden>
          {canvas.wires.map((w) => {
            const a = nodesById.get(w.from);
            const b = nodesById.get(w.to);
            if (!a || !b) return null;
            const type = outputType(canvas, a) ?? "image";
            const working = statusOf(a) === "working" || statusOf(b) === "working";
            return <path key={w.id} d={wirePath(a, b)} className={`sc-wire is-${type}${working ? " is-live" : ""}`} data-wire={`${w.from}->${w.to}`} />;
          })}
          {from && tip && <path d={wirePath(from, { x: tip.x, y: tip.y - NODE_H / 2 })} className="sc-wire is-draft" />}
        </svg>
        {canvas.nodes.map((n) => (
          <NodeCard
            key={n.id}
            node={n}
            canvas={canvas}
            status={statusOf(n)}
            name={nodeName(n)}
            sourceName={(() => {
              const i = inputOf(canvas, n, jobs);
              return i ? nodeName(i.from) : null;
            })()}
            selected={selected === n.id}
            dropTarget={dropTarget === n.id}
            jobs={jobs}
            previews={previews}
            onOpen={() => onSelect(n.id)}
          />
        ))}
      </div>
      {children}
      {canvas.nodes.length > 0 && (showMap ? <Minimap canvas={canvas} boardRef={boardRef} onCentre={setView} onHide={onToggleMap} /> : (
        <button type="button" className="sc-map-show" onClick={onToggleMap}>
          {c.mapShow}
        </button>
      ))}
    </div>
  );
}

function NodeCard({
  node,
  canvas,
  status,
  name,
  sourceName,
  selected,
  dropTarget,
  jobs,
  previews,
  onOpen,
}: {
  node: CanvasNode;
  canvas: CanvasState;
  status: NodeStatus;
  name: string;
  sourceName: string | null;
  selected: boolean;
  dropTarget: boolean;
  jobs: ReadonlyMap<string, JobReading>;
  previews: ReadonlyMap<string, { thumbUrl: string | null; kind: string }>;
  onOpen: () => void;
}) {
  const { t, fmt } = useI18n();
  const c = t.studioCanvas;
  const spec = KIND_SPEC[node.kind];
  const Icon = KIND_ICONS[node.kind];
  const out = outputType(canvas, node);
  const asset = nodeAsset(node, jobs);
  const thumb = asset ? previews.get(asset)?.thumbUrl ?? null : null;
  const reading = node.jobId ? jobs.get(node.jobId) : undefined;
  const job = reading?.state === "ok" ? reading.job : null;
  const accepts = spec.accepts.map((k) => c.ports[k]).join(" / ");
  const line = statusLine(t, status, job, accepts);
  return (
    <div
      className="sc-node"
      data-node-id={node.id}
      data-kind={node.kind}
      data-status={status}
      data-selected={selected ? "true" : undefined}
      data-drop={dropTarget ? "true" : undefined}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: NODE_W, height: NODE_H }}
      role="group"
      aria-label={`${name}: ${line}`}
    >
      {spec.accepts.length > 0 && (
        <span className={`sc-port sc-port-in is-${spec.accepts[0]}`} data-port-in={node.id} title={fmt(c.ports.in, { kinds: accepts })}>
          <span aria-hidden>{spec.accepts.map((k) => PORT_LETTER[k]).join("")}</span>
        </span>
      )}
      <button type="button" className="sc-node-head" onClick={onOpen} aria-pressed={selected}>
        <Icon aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{name}</span>
      </button>
      <div className="sc-node-body" aria-hidden={!thumb}>
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" draggable={false} />
        ) : (
          <Icon aria-hidden className="sc-node-glyph" />
        )}
      </div>
      <div className="sc-node-foot">
        <StatusLamp tone={LAMP[status]} live={status === "working"} label={line} />
        {sourceName && <span className="sc-node-sub">{fmt(c.node.from, { name: sourceName })}</span>}
      </div>
      {out && (
        <span className={`sc-port sc-port-out is-${out}`} data-port-out={node.id} title={`${fmt(c.ports.out, { kind: c.ports[out] })} · ${c.wire.drag}`}>
          <span aria-hidden>{PORT_LETTER[out]}</span>
        </span>
      )}
    </div>
  );
}

/** A node's status in words: always words, never a colour alone; a failure names its reason (rule 6). */
function statusLine(t: ReturnType<typeof useI18n>["t"], status: NodeStatus, job: StudioJob | null, accepts: string): string {
  const c = t.studioCanvas;
  switch (status) {
    case "closed":
      return c.node.notAvailable;
    case "needs":
      return c.node.needsInput.replace("{kinds}", accepts);
    case "idle":
      return c.node.notStarted;
    case "loading":
      return c.node.reading;
    case "unknown":
      return c.node.unknown;
    case "asset":
      return c.kinds.asset.name;
    case "missing":
      return c.node.noFile;
    case "failed":
      return job ? `${t.gen.status.failed} · ${failureReason(t, job)}` : t.gen.status.failed;
    default:
      return job ? statusView(t, job.status).label : c.node.unknown;
  }
}

// ── minimap ──────────────────────────────────────────────────────────────────

function Minimap({
  canvas,
  boardRef,
  onCentre,
  onHide,
}: {
  canvas: CanvasState;
  boardRef: React.RefObject<HTMLDivElement | null>;
  onCentre: (v: Viewport) => void;
  onHide: () => void;
}) {
  const { t } = useI18n();
  const c = t.studioCanvas;
  const W = 200;
  const H = 120;
  const r = boardRef.current?.getBoundingClientRect();
  const vw = r?.width ?? 1200;
  const vh = r?.height ?? 700;
  const tl = toCanvas(canvas.view, 0, 0);
  const br = toCanvas(canvas.view, vw, vh);
  const xs = [tl.x, br.x, ...canvas.nodes.flatMap((n) => [n.x, n.x + NODE_W])];
  const ys = [tl.y, br.y, ...canvas.nodes.flatMap((n) => [n.y, n.y + NODE_H])];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const s = Math.min(W / (Math.max(...xs) - minX || 1), H / (Math.max(...ys) - minY || 1));
  return (
    <div className="sc-map">
      <div className="sc-map-head">
        <span>{c.map}</span>
        <button type="button" className="sc-icon-btn is-small" onClick={onHide} aria-label={c.mapHide} title={c.mapHide}>
          <X aria-hidden className="size-3.5" />
        </button>
      </div>
      <svg
        width={W}
        height={H}
        role="img"
        aria-label={c.map}
        onPointerDown={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const wx = (e.clientX - box.left) / s + minX;
          const wy = (e.clientY - box.top) / s + minY;
          onCentre({ ...canvas.view, x: vw / 2 - wx * canvas.view.k, y: vh / 2 - wy * canvas.view.k });
        }}
      >
        {canvas.nodes.map((n) => (
          <rect key={n.id} x={(n.x - minX) * s} y={(n.y - minY) * s} width={NODE_W * s} height={NODE_H * s} rx={2} className="sc-map-node" />
        ))}
        <rect x={(tl.x - minX) * s} y={(tl.y - minY) * s} width={(br.x - tl.x) * s} height={(br.y - tl.y) * s} className="sc-map-view" />
      </svg>
    </div>
  );
}

// ── palette and the add menu ───────────────────────────────────────────────────

function CanvasPalette({ mode, filmStudio, onClose, onAdd }: { mode: "all" | "add"; filmStudio: boolean; onClose: () => void; onAdd: (k: ToolKind) => void }) {
  const { t } = useI18n();
  const c = t.studioCanvas;
  const path = useChannelPath();
  const { tools: availability, operator, features } = useShell();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  type Item = { id: string; group: "add" | "open"; label: string; sub: string; closed?: boolean; run: () => void; Icon: LucideIcon };
  const items: Item[] = [
    ...TOOL_KINDS.map((k) => ({
      id: `add:${k}`,
      group: "add" as const,
      label: c.kinds[k].name,
      sub: kindOpen(availability, k) ? c.kinds[k].desc : c.node.notAvailable,
      closed: !kindOpen(availability, k),
      run: () => onAdd(k),
      Icon: KIND_ICONS[k],
    })),
    ...(mode === "all"
      ? [
          ...(filmStudio ? [{ id: "open:projects", group: "open" as const, label: c.projects, sub: c.projectsSub, run: () => (window.location.href = path("/create/projects")), Icon: Projector }] : []),
          { id: "open:videos", group: "open" as const, label: c.viewVideos, sub: "", run: () => (window.location.href = path("/studio?shelf=videos")), Icon: Film },
          ...studioTilesFor(operator, features).map((tile) => ({
            id: `open:${tile.href}`,
            group: "open" as const,
            label: tile.key === "presets" ? t.presets.title : t.nav[tile.key],
            sub: "",
            run: () => (window.location.href = path(tile.href)),
            Icon: tile.key === "presets" ? LayoutGrid : ICONS[tile.key],
          })),
        ]
      : []),
  ];
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((i) => `${i.label} ${i.sub}`.toLowerCase().includes(needle)) : items;
  const pick = (i: Item | undefined) => i?.run();
  return (
    <div className="sc-palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sc-palette" role="dialog" aria-modal="true" aria-label={mode === "add" ? c.add.title : c.palette.label} data-testid="canvas-palette">
        <div className="sc-palette-head">
          <Search aria-hidden className="size-4" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(shown.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(shown[active]);
              }
            }}
            placeholder={c.palette.placeholder}
            aria-label={c.palette.placeholder}
            className="sc-palette-input"
          />
          <button type="button" className="sc-icon-btn" onClick={onClose} aria-label={c.add.close} title={c.add.close}>
            <X aria-hidden className="size-4" />
          </button>
        </div>
        <ul className="sc-palette-list" role="listbox" aria-label={c.palette.label}>
          {shown.length === 0 && <li className="sc-note px-3 py-2">{c.palette.empty}</li>}
          {shown.map((i, n) => (
            <li key={i.id}>
              {(n === 0 || shown[n - 1].group !== i.group) && <p className="sc-menu-group">{i.group === "add" ? c.palette.addGroup : c.palette.openGroup}</p>}
              <button
                type="button"
                role="option"
                aria-selected={n === active}
                className="sc-palette-item"
                data-closed={i.closed ? "true" : undefined}
                onMouseEnter={() => setActive(n)}
                onClick={() => pick(i)}
                data-testid={i.id}
              >
                <i.Icon aria-hidden className="size-4 shrink-0" />
                <span className="flex min-w-0 flex-col text-left">
                  <span className="font-semibold">{i.label}</span>
                  {i.sub && <span className="sc-note">{i.sub}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="sc-palette-foot">{c.palette.hint}</p>
      </div>
    </div>
  );
}

// ── first run ────────────────────────────────────────────────────────────────

function FirstRun({ filmStudio, onRecipe, onBlank }: { filmStudio: boolean; onRecipe: (r: Recipe) => void; onBlank: () => void }) {
  const { t } = useI18n();
  const c = t.studioCanvas.firstRun;
  const path = useChannelPath();
  return (
    <section className="sc-firstrun" aria-labelledby="sc-firstrun-title" data-testid="canvas-first-run">
      <h2 id="sc-firstrun-title" className="sc-firstrun-title">
        {c.title}
      </h2>
      <p className="sc-firstrun-lead">{c.lead}</p>
      <p className="sc-menu-group">{c.from}</p>
      <ul className="sc-recipes">
        {RECIPES.map((r) => (
          <li key={r}>
            <button type="button" className="sc-recipe" onClick={() => onRecipe(r)} data-testid={`recipe-${r}`}>
              <span className="font-semibold">{c[r].name}</span>
              <span className="sc-note">{c[r].desc}</span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" className="sc-recipe" onClick={onBlank} data-testid="recipe-blank">
            <span className="font-semibold">{c.blank.name}</span>
            <span className="sc-note">{c.blank.desc}</span>
          </button>
        </li>
        {filmStudio && (
          <li>
            <Link href={path("/create/projects")} className="sc-recipe" data-testid="recipe-projects">
              <span className="font-semibold">{t.studioCanvas.projects}</span>
              <span className="sc-note">{t.studioCanvas.projectsSub}</span>
            </Link>
          </li>
        )}
      </ul>
    </section>
  );
}

// ── the phone: the same graph as a vertical flow ──────────────────────────────

function FlowView({
  canvas,
  statusOf,
  nodeName,
  jobs,
  previews,
  onOpen,
}: {
  canvas: CanvasState;
  statusOf: (n: CanvasNode) => NodeStatus;
  nodeName: (n: CanvasNode) => string;
  jobs: ReadonlyMap<string, JobReading>;
  previews: ReadonlyMap<string, { thumbUrl: string | null; kind: string }>;
  onOpen: (id: string) => void;
}) {
  const { t, fmt } = useI18n();
  const c = t.studioCanvas;
  const order = flowOrder(canvas);
  const groups: { id: "sources" | "make" | "finish"; nodes: CanvasNode[] }[] = [
    { id: "sources", nodes: order.filter((n) => depthOf(canvas, n.id) === 0) },
    { id: "make", nodes: order.filter((n) => depthOf(canvas, n.id) === 1) },
    { id: "finish", nodes: order.filter((n) => depthOf(canvas, n.id) >= 2) },
  ];
  if (canvas.nodes.length === 0) return <p className="sc-empty-hint is-flow">{c.firstRun.blank.desc}</p>;
  return (
    <div className="sc-flow" aria-label={c.flow.label}>
      {groups
        .filter((g) => g.nodes.length > 0)
        .map((g) => (
          <section key={g.id} className="sc-flow-group" aria-labelledby={`flow-${g.id}`}>
            <h2 id={`flow-${g.id}`} className="sc-flow-title">
              {c.flow[g.id]}
            </h2>
            <ul className="sc-flow-list">
              {g.nodes.map((n) => {
                const s = statusOf(n);
                const Icon = KIND_ICONS[n.kind];
                const input = inputOf(canvas, n, jobs);
                const asset = nodeAsset(n, jobs);
                const thumb = asset ? previews.get(asset)?.thumbUrl ?? null : null;
                const reading = n.jobId ? jobs.get(n.jobId) : undefined;
                const job = reading?.state === "ok" ? reading.job : null;
                const accepts = KIND_SPEC[n.kind].accepts.map((k) => c.ports[k]).join(" / ");
                return (
                  <li key={n.id}>
                    <button type="button" className="sc-flow-card" data-status={s} onClick={() => onOpen(n.id)} data-testid={`flow-node-${n.kind}`}>
                      {thumb && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumb} alt="" className="sc-flow-thumb" />
                      )}
                      <span className="flex items-center gap-2 font-semibold">
                        <Icon aria-hidden className="size-4 shrink-0" />
                        <span className="truncate">{nodeName(n)}</span>
                      </span>
                      <StatusLamp tone={LAMP[s]} live={s === "working"} label={statusLine(t, s, job, accepts)} />
                      {KIND_SPEC[n.kind].accepts.length > 0 && (
                        <span className="sc-flow-inputs">
                          <span className="sc-note">{c.flow.inputs}:</span>{" "}
                          {input ? <span className="sc-chip">{fmt(c.node.from, { name: nodeName(input.from) })}</span> : <span className="sc-chip is-empty">{c.flow.noInputs}</span>}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
    </div>
  );
}
