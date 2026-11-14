"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Check, ChevronDown, Film, GitBranch, Hand, Layers, LayoutGrid, Maximize, Minus, MousePointer2, Palette, Plus, Projector, RotateCcw, Search, X, ZoomIn, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { useShell } from "@/components/shell/ShellContext";
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
  PORT_Y,
  RECIPES,
  TOOL_KINDS,
  canWire,
  clampZoom,
  connect,
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
  type CanvasWire,
  type NodeKind,
  type Recipe,
  type ToolKind,
  type Viewport,
  type WireRefusal,
} from "@/lib/studio/canvas";
import { ASSET_MIME, LibraryDrawer, readDrop, type DroppedAsset } from "./LibraryDrawer";
import { Inspector, type PanelData } from "./Inspector";
import { KIND_ICONS, Lamp } from "./parts";
import { LAMP, inputOf, kindOpen, nodeAsset, nodeStatus, type JobReading, type NodeStatus } from "./nodeState";
import "./studio-canvas.css";

export { KIND_ICONS };

const JOB_POLL_MS = 5000;
const NARROW = "(max-width: 760px)";
/** A press that moves less than this is a click (it opens the inspector); more is a drag (it only moves the node). */
const CLICK_SLOP = 4;
const HISTORY_MAX = 100;
/** The map's corner, kept clear by Fit so the map never sits on a node. */
const MAP_ROOM = 232;
const MAP_TALL = 176;
/** Where the app's header offers this page its bar (components/Header.tsx, Studio only). */
export const BAR_SLOT_ID = "studio-bar-slot";

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

type Snapshot = Pick<CanvasState, "nodes" | "wires">;

/** Groups of the phone's flow, by what a node is (not by depth): words and files, then making, then finishing. */
const FLOW_GROUP: Record<NodeKind, "sources" | "make" | "finish"> = {
  prompt: "sources",
  asset: "sources",
  image: "make",
  video: "make",
  animate: "make",
  effects: "make",
  voice: "make",
  enhance: "finish",
};

/**
 * Nightshift Studio's canvas (docs/studio/STUDIO_IA.md §2, the person's `sketch` project; prototype in
 * docs/studio/prototype/). Every tool is a node; a wire is a real input; the inspector is the existing composer
 * locked to the node's tools; results land on the node from the job the database reports.
 *
 * What it never does: price or start anything by itself (rule 3: only the composer's quote → start does), put
 * another model in place of one that is off (rule 4), or show a state it did not read (rule 5). The layout lives
 * in this browser only, per organization, channel and person, until a studio_layouts table exists.
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
  const { tools: availability } = useShell();
  const narrow = useNarrow();
  const orgId = data.orgId;
  const key = orgId ? layoutKey(orgId, channel, userId) : null;

  const [canvas, setCanvas] = useState<CanvasState>(EMPTY_STATE);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedWire, setSelectedWire] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState<null | "all" | "add">(null);
  const [mode, setMode] = useState<"select" | "hand">("select");
  const [mapOpen, setMapOpen] = useState(true);
  const [firstRunDone, setFirstRunDone] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [jobs, setJobs] = useState<Map<string, JobReading>>(() => new Map());
  const library = useLibraryImages(orgId ?? "", { enabled: !!orgId });
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;

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

  // ── undo / redo: a person's edits (add, delete, move, wire), never a job ─────
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const snap = (s: CanvasState): Snapshot => ({ nodes: s.nodes, wires: s.wires });
  const record = useCallback(() => {
    past.current.push(snap(canvasRef.current));
    if (past.current.length > HISTORY_MAX) past.current.shift();
    future.current = [];
  }, []);
  const edit = useCallback(
    (fn: (s: CanvasState) => CanvasState) => {
      record();
      setCanvas(fn);
    },
    [record],
  );
  /** Restoring an edit keeps what happened since (a job started, words typed): only the person's layout goes back. */
  const restore = (target: Snapshot, now: CanvasState): CanvasState => ({
    ...now,
    wires: target.wires,
    nodes: target.nodes.map((n) => {
      const live = now.nodes.find((m) => m.id === n.id);
      return live ? { ...n, jobId: live.jobId ?? n.jobId, draft: live.draft } : n;
    }),
  });
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(snap(canvasRef.current));
    setCanvas((s) => restore(prev, s));
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(snap(canvasRef.current));
    setCanvas((s) => restore(next, s));
  };

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
          const wasActive = before?.state === "ok" && (isActiveStatus(before.job.status) || before.job.status === "queued");
          if (wasActive && r.state === "ok" && !isActiveStatus(r.job.status) && r.job.status !== "queued") finished = true;
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
  const activeKey = jobIds
    .filter((id) => {
      const r = jobs.get(id);
      return r?.state === "ok" && (isActiveStatus(r.job.status) || r.job.status === "queued");
    })
    .join(",");
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
  const nodeName = useCallback(
    (n: CanvasNode): string => {
      if (n.kind === "asset") {
        const lib = [...library.images, ...library.recordings].find((x) => x.id === n.assetId);
        return lib?.name || c.kinds.asset.name;
      }
      const same = canvas.nodes.filter((m) => m.kind === n.kind);
      const label =
        n.kind === "effects" && n.effectId && n.effectId in t.effects.items ? t.effects.items[n.effectId as keyof typeof t.effects.items].name : c.kinds[n.kind].name;
      return same.length > 1 ? `${label} ${same.findIndex((m) => m.id === n.id) + 1}` : label;
    },
    [canvas.nodes, library.images, library.recordings, c, t],
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
  const open = (id: string) => {
    setSelected(id);
    setSelectedWire(null);
    setInspecting(true);
  };
  const addNode = (kind: NodeKind, at?: { x: number; y: number }, extra: Partial<CanvasNode> = {}) => {
    if (!kindOpen(availability, kind)) {
      say(c.wire.closed);
      return null;
    }
    const id = makeId();
    const spot = at ?? (canvas.nodes.length ? nextSpot(canvas.nodes) : centreSpot());
    edit((s) => ({ ...s, nodes: [...s.nodes, newNode(kind, spot.x, spot.y, id, extra)] }));
    setFirstRunDone(true);
    if (kind === "asset") setSelected(id);
    else open(id);
    return id;
  };
  const patchNode = (id: string, patch: Partial<CanvasNode>) =>
    setCanvas((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  const wire = (from: string, to: string) => {
    const target = canvas.nodes.find((n) => n.id === to);
    if (target && !kindOpen(availability, target.kind)) {
      say(c.wire.closed);
      return false;
    }
    const check = canWire(canvas, from, to);
    if (!check.ok) {
      say(c.wire[check.why as WireRefusal]);
      return false;
    }
    edit((s) => connect(s, from, to, makeId()));
    return true;
  };
  const dropAsset = (a: DroppedAsset, at?: { x: number; y: number }, onto?: string) => {
    const target = onto ? canvas.nodes.find((n) => n.id === onto) : undefined;
    if (target && KIND_SPEC[target.kind].accepts.includes(a.kind) && kindOpen(availability, target.kind)) {
      // Onto a node's input: the file sits beside it, wired in at once.
      const id = makeId();
      const node = newNode("asset", target.x - NODE_W - 96, target.y, id, { assetId: a.id, assetKind: a.kind });
      edit((s) => connect({ ...s, nodes: [...s.nodes, node] }, id, target.id, makeId()));
      setFirstRunDone(true);
      open(target.id);
      return;
    }
    if (target) say(c.wire.wrong_type);
    addNode("asset", at, { assetId: a.id, assetKind: a.kind });
  };
  const startRecipe = (r: Recipe, words = "") => {
    const next = recipeState(r, makeId, words);
    edit((s) => ({ ...next, view: s.view }));
    setFirstRunDone(true);
    const last = next.nodes[next.nodes.length - 1];
    if (last) {
      setSelected(last.id);
      setInspecting(r !== "photoClip" && !narrow);
    }
    if (r === "photoClip") setDrawer(true);
    requestAnimationFrame(() => fit(next.nodes));
  };
  const deleteSelected = () => {
    if (selectedWire) {
      edit((s) => ({ ...s, wires: s.wires.filter((w) => w.id !== selectedWire) }));
      setSelectedWire(null);
      return;
    }
    if (!selected) return;
    edit((s) => removeNode(s, selected));
    setSelected(null);
    setInspecting(false);
  };
  const setView = (v: Viewport | ((v: Viewport) => Viewport)) => setCanvas((s) => ({ ...s, view: typeof v === "function" ? v(s.view) : v }));
  const fit = (nodes: readonly CanvasNode[] = canvas.nodes) => {
    const { w, h } = boardSize();
    // The map keeps its corner: the fit leaves that room beside or above it (whichever costs less zoom), so it never sits on a node.
    if (!mapOpen) return setView(fitView(nodes, w, h));
    const beside = fitView(nodes, Math.max(320, w - MAP_ROOM), h);
    const above = fitView(nodes, w, Math.max(240, h - MAP_TALL));
    setView(above.k > beside.k ? above : beside);
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

  // A node opened in the inspector stays in view: the board narrows by the inspector's width, so pan it back if it went under.
  useEffect(() => {
    if (narrow || !inspecting || !selected) return;
    const id = requestAnimationFrame(() => {
      const n = canvasRef.current.nodes.find((m) => m.id === selected);
      const w = boardRef.current?.getBoundingClientRect().width;
      if (!n || !w) return;
      const v = canvasRef.current.view;
      const left = n.x * v.k + v.x;
      const right = left + NODE_W * v.k;
      const shift = right > w - 24 ? w - 24 - right : left < 24 ? 24 - left : 0;
      if (shift) setCanvas((s) => ({ ...s, view: { ...s.view, x: s.view.x + shift } }));
    });
    return () => cancelAnimationFrame(id);
  }, [inspecting, selected, narrow]);

  // ── keys: ⌘K searches, N adds, Delete removes, ⌘Z undoes, + / − / 0 zoom, Escape closes ──
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
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "Escape") {
        if (drawer || inspecting) {
          setDrawer(false);
          setInspecting(false);
        } else {
          setSelected(null);
          setSelectedWire(null);
        }
        return;
      }
      if (typing(e.target)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === " " && !e.repeat) setSpace(true);
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setPalette("add");
      } else if ((e.key === "Delete" || e.key === "Backspace") && (selected || selectedWire)) {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === "+" || e.key === "=") zoomBy(1.2);
      else if (e.key === "-") zoomBy(1 / 1.2);
      else if (e.key === "0") fit();
      else if (selected && e.key.startsWith("Arrow")) {
        // The keyboard's way to move a node (no drag needed).
        e.preventDefault();
        const step = e.shiftKey ? 64 : 16;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        edit((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === selected ? { ...n, x: n.x + dx, y: n.y + dy } : n)) }));
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

  // The workspace fills the window below the bar, so the canvas never makes the page scroll.
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (narrow) return;
    const el = rootRef.current;
    if (!el) return;
    const size = () => el.style.setProperty("--cv-top", `${Math.max(0, el.getBoundingClientRect().top + window.scrollY)}px`);
    size();
    window.addEventListener("resize", size);
    return () => window.removeEventListener("resize", size);
  }, [narrow, loaded]);

  // The project bar goes into the app's own header on this page (one bar, not two); without it (tests), inline.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById(BAR_SLOT_ID));
  }, []);

  // Sheets and the palette go to <body>: the app's frame makes its own stacking context, so from inside the page a
  // scrim could dim neither the header nor the tab bar, and a phone sheet would sit under the tab bar.
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => setPortalReady(true), []);
  const overlay = (el: ReactNode) => (el && portalReady ? createPortal(<div className="cv-tok">{el}</div>, document.body) : el);

  const busy = (counts.working ?? 0) + (counts.queued ?? 0) > 0;
  const nodesWord = canvas.nodes.length === 1 ? c.statusNodesOne : fmt(c.statusNodes, { n: canvas.nodes.length });
  const status = (
    <div className="cv-strip" data-testid="canvas-status">
      {canvas.nodes.length === 0 ? (
        <span>{c.statusEmpty}</span>
      ) : (
        <>
          <b>{nodesWord}</b>
          {!!counts.working && <Lamp tone="run" live label={fmt(c.statusWorking, { n: counts.working })} />}
          {!!counts.done && <Lamp tone="ok" label={fmt(c.statusDone, { n: counts.done })} />}
          {!!counts.failed && <Lamp tone="fail" label={fmt(c.statusFailed, { n: counts.failed })} />}
          {!!counts.needs && <Lamp tone="warn" label={fmt(c.statusNeeds, { n: counts.needs })} />}
          {!!counts.unknown && <Lamp tone="warn" label={fmt(c.statusUnknown, { n: counts.unknown })} />}
          {!!counts.closed && <Lamp tone="idle" label={fmt(c.statusClosed, { n: counts.closed })} />}
        </>
      )}
      {!saved && <span className="cv-strip-warn">{c.notSaved}</span>}
    </div>
  );

  const bar = <ProjectBar filmStudio={filmStudio} onSearch={() => setPalette("all")} inline={!slot} />;
  const barEl = slot ? createPortal(bar, slot) : bar;

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
        retrySignal={retry}
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
        onDisconnect={() => edit((s) => disconnect(s, sel.id))}
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

  const paletteEl = palette ? overlay(
    <CanvasPalette
      mode={palette}
      filmStudio={filmStudio}
      onClose={() => setPalette(null)}
      onAdd={(k) => {
        if (addNode(k)) setPalette(null);
      }}
    />,
  ) : null;

  const showFirstRun = loaded && canvas.nodes.length === 0 && !firstRunDone;
  const firstRun = showFirstRun ? (
    <FirstRun filmStudio={filmStudio} phone={narrow} onRecipe={startRecipe} onBlank={() => setFirstRunDone(true)} />
  ) : null;
  const live = (
    <div className="sr-only" role="status" aria-live="polite">
      {notice}
    </div>
  );
  const toast = notice ? <p className="cv-toast">{notice}</p> : null;
  const quote = <QuoteKey node={sel} onOpen={() => sel && open(sel.id)} />;

  if (!loaded) {
    return (
      <div className="cv-root" data-studio-canvas="" ref={rootRef}>
        {barEl}
        <p className="cv-loading" role="status">
          {c.loading}
        </p>
      </div>
    );
  }

  if (narrow) {
    return (
      <div className="cv-root is-flow" data-studio-canvas="" ref={rootRef} data-sheet={inspector || drawerEl ? "" : undefined}>
        {barEl}
        {status}
        {live}
        {toast}
        {firstRun ?? (
          <FlowView
            canvas={canvas}
            statusOf={statusOf}
            nodeName={nodeName}
            jobs={jobs}
            previews={library.previews}
            selected={selected}
            onOpen={open}
          />
        )}
        <div className="cv-flow-dock" role="toolbar" aria-label={c.dock.label}>
          <button type="button" className="cv-kbtn" onClick={() => setPalette("add")}>
            <Plus aria-hidden className="size-4" /> {c.dock.add}
          </button>
          <button type="button" className="cv-kbtn is-icon" onClick={() => setDrawer(true)} aria-label={c.dock.library} title={c.dock.library}>
            <Layers aria-hidden className="size-4" />
          </button>
          {quote}
        </div>
        {overlay(
          inspector || drawerEl ? (
            <>
              <div
                className="cv-scrim"
                onClick={() => {
                  setInspecting(false);
                  setDrawer(false);
                }}
                aria-hidden
              />
              {inspector}
              {drawerEl}
            </>
          ) : null,
        )}
        {paletteEl}
      </div>
    );
  }

  return (
    <div className="cv-root" data-studio-canvas="" ref={rootRef} data-mode={space ? "hand" : mode}>
      {barEl}
      {status}
      <div className="cv-work">
        <Board
          boardRef={boardRef}
          canvas={canvas}
          setCanvas={setCanvas}
          record={record}
          selected={selected}
          selectedWire={selectedWire}
          onSelect={(id) => {
            setSelected(id);
            setSelectedWire(null);
            if (!id) setInspecting(false);
          }}
          onSelectWire={(id) => {
            setSelectedWire(id);
            setSelected(null);
            setInspecting(false);
          }}
          onOpen={open}
          onRetry={(id) => {
            open(id);
            setRetry((r) => r + 1);
          }}
          hand={mode === "hand" || space}
          busy={busy}
          statusOf={statusOf}
          nodeName={nodeName}
          jobs={jobs}
          previews={library.previews}
          onWire={wire}
          onDrop={dropAsset}
          mapOpen={mapOpen}
          onToggleMap={() => setMapOpen((m) => !m)}
        >
          {firstRun}
          {!firstRun && canvas.nodes.length === 0 && <p className="cv-hint">{c.firstRun.blank.desc}</p>}
          {toast}
          {live}
          {/* The Library is glass over the board's left edge: the board keeps its width, so both panels can be open at once. */}
          {drawerEl}
        </Board>
        {inspector}
      </div>
      <div className="cv-deck" role="toolbar" aria-label={c.dock.label}>
        <button type="button" className="cv-kbtn" onClick={() => setPalette("add")} aria-haspopup="dialog" aria-label={c.dock.add} title={c.dock.add} data-testid="dock-add">
          <Plus aria-hidden className="size-4" /> <span className="cv-klabel">{c.dock.add}</span>
        </button>
        <button type="button" className="cv-kbtn" aria-pressed={drawer} onClick={() => setDrawer((d) => !d)} aria-label={c.dock.library} title={c.dock.library} data-testid="dock-library">
          <Layers aria-hidden className="size-4" /> <span className="cv-klabel">{c.dock.library}</span>
        </button>
        <div className="cv-seg" role="group">
          <button type="button" aria-pressed={mode === "select"} onClick={() => setMode("select")} aria-label={c.dock.select} title={c.dock.select}>
            <MousePointer2 aria-hidden className="size-4" />
          </button>
          <button type="button" aria-pressed={mode === "hand"} onClick={() => setMode("hand")} aria-label={c.dock.hand} title={c.dock.hand}>
            <Hand aria-hidden className="size-4" />
          </button>
        </div>
        <button type="button" className="cv-kbtn" onClick={() => edit((s) => tidy(s))} disabled={canvas.nodes.length < 2} aria-label={c.dock.tidy} title={c.dock.tidy}>
          <LayoutGrid aria-hidden className="size-4" /> <span className="cv-klabel">{c.dock.tidy}</span>
        </button>
        <span className="cv-vsep" aria-hidden />
        <div className="cv-zoom" role="group">
          <button type="button" className="cv-kbtn is-icon" onClick={() => zoomBy(1 / 1.2)} aria-label={c.dock.zoomOut} title={c.dock.zoomOut}>
            <Minus aria-hidden className="size-4" />
          </button>
          <output title={fmt(c.dock.zoom, { n: Math.round(canvas.view.k * 100) })}>{Math.round(canvas.view.k * 100)}%</output>
          <button type="button" className="cv-kbtn is-icon" onClick={() => zoomBy(1.2)} aria-label={c.dock.zoomIn} title={c.dock.zoomIn}>
            <ZoomIn aria-hidden className="size-4" />
          </button>
          <button type="button" className="cv-kbtn is-icon" onClick={() => fit()} aria-label={c.dock.fit} title={c.dock.fit}>
            <Maximize aria-hidden className="size-4" />
          </button>
        </div>
        <span className="cv-grow" />
        <span className="cv-qnote">{c.nothingSpends}</span>
        {quote}
      </div>
      {paletteEl}
    </div>
  );
}

/** The deck's price key: the price lives in the selected node's form (its backend quote), so it opens that form. */
function QuoteKey({ node, onOpen }: { node: CanvasNode | null; onOpen: () => void }) {
  const { t } = useI18n();
  const c = t.studioCanvas;
  const can = !!node && node.kind !== "asset" && node.kind !== "prompt";
  return (
    <button type="button" className="cv-kbtn is-primary" disabled={!can} onClick={onOpen} title={can ? c.quote : c.quoteHint} data-testid="dock-quote">
      {c.quote}
    </button>
  );
}

// ── the project bar (in the app's header on this page) ─────────────────────────

function ProjectBar({ filmStudio, onSearch, inline }: { filmStudio: boolean; onSearch: () => void; inline: boolean }) {
  const { t } = useI18n();
  const c = t.studioCanvas;
  const path = useChannelPath();
  const { operator, features } = useShell();
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
    <div className={inline ? "cv-pbar is-inline" : "cv-pbar"}>
      <div className="relative min-w-0" ref={menu}>
        <button type="button" className="cv-pswitch" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)} aria-label={c.switcher} data-testid="project-switcher">
          <span className="flex min-w-0 flex-col items-start">
            <span className="cv-pswitch-nm">{c.sketch}</span>
            <span className="cv-pswitch-kd">{c.sketchSub}</span>
          </span>
          <ChevronDown aria-hidden className="size-4 shrink-0" />
        </button>
        {open && (
          <div className="cv-pop" role="menu" aria-label={c.switcher}>
            <p className="cv-pop-h">{c.views}</p>
            <MenuLink href={path("/studio")} icon={<Check aria-hidden className="size-4" />} label={c.viewCanvas} current />
            <MenuLink href={path("/studio?shelf=videos")} icon={<Film aria-hidden className="size-4" />} label={c.viewVideos} />
            <MenuLink href={path("/studio?shelf=projects")} icon={<ICONS.editor aria-hidden className="size-4" />} label={c.viewEditor} />
            {filmStudio && <MenuLink href={path("/create/projects")} icon={<Projector aria-hidden className="size-4" />} label={c.projects} sub={c.projectsSub} testid="menu-projects" />}
            <p className="cv-pop-h">{c.tools}</p>
            {tiles.map((tile) => {
              const Icon = tile.key === "presets" ? LayoutGrid : ICONS[tile.key];
              return <MenuLink key={tile.href} href={path(tile.href)} icon={<Icon aria-hidden className="size-4" />} label={tile.key === "presets" ? t.presets.title : t.nav[tile.key]} />;
            })}
          </div>
        )}
      </div>
      <div className="cv-seg cv-deskonly" role="group" aria-label={c.views}>
        <button type="button" aria-pressed="true">
          <GitBranch aria-hidden className="size-4" /> {c.viewCanvas}
        </button>
        {/* Honest about what is not built: the timeline arrives with scene-by-scene projects. */}
        <button type="button" disabled aria-disabled="true" title={c.timelineSoon}>
          {c.timeline}
        </button>
      </div>
      {/* Brand look, one click from where its old bookmark lands (STUDIO_IA.md §9.1). */}
      <Link href={path("/studio/look")} className="cv-chip-link" data-testid="channel-look-chip" aria-label={t.studioHub.channelLook} title={t.studioHub.channelLook}>
        <Palette aria-hidden className="size-4" />
        <span className="cv-chip-label">{t.studioHub.channelLook}</span>
      </Link>
      <span className="cv-grow" />
      <button type="button" className="cv-kbtn cv-search" onClick={onSearch} data-testid="canvas-search" aria-label={c.search}>
        <Search aria-hidden className="size-4" />
        <span className="cv-search-label">{c.search}</span>
        <kbd>⌘K</kbd>
      </button>
    </div>
  );
}

function MenuLink({ href, icon, label, sub, current = false, testid }: { href: string; icon: ReactNode; label: string; sub?: string; current?: boolean; testid?: string }) {
  return (
    <Link href={href} role="menuitem" className="cv-opt" aria-current={current ? "page" : undefined} data-testid={testid}>
      {icon}
      <span className="flex min-w-0 flex-col">
        <span className="cv-opt-on">{label}</span>
        {sub && <span className="cv-opt-os">{sub}</span>}
      </span>
    </Link>
  );
}

// ── the board: pan, zoom, nodes, wires, minimap ───────────────────────────────

type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: "node"; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | { kind: "wire"; from: string };

function Board({
  boardRef,
  canvas,
  setCanvas,
  record,
  selected,
  selectedWire,
  onSelect,
  onSelectWire,
  onOpen,
  onRetry,
  hand,
  busy,
  statusOf,
  nodeName,
  jobs,
  previews,
  onWire,
  onDrop,
  mapOpen,
  onToggleMap,
  children,
}: {
  boardRef: React.RefObject<HTMLDivElement | null>;
  canvas: CanvasState;
  setCanvas: React.Dispatch<React.SetStateAction<CanvasState>>;
  record: () => void;
  selected: string | null;
  selectedWire: string | null;
  onSelect: (id: string | null) => void;
  onSelectWire: (id: string) => void;
  onOpen: (id: string) => void;
  onRetry: (id: string) => void;
  hand: boolean;
  busy: boolean;
  statusOf: (n: CanvasNode) => NodeStatus;
  nodeName: (n: CanvasNode) => string;
  jobs: ReadonlyMap<string, JobReading>;
  previews: ReadonlyMap<string, { thumbUrl: string | null; kind: string }>;
  onWire: (from: string, to: string) => boolean;
  onDrop: (a: DroppedAsset, at: { x: number; y: number }, onto?: string) => void;
  mapOpen: boolean;
  onToggleMap: () => void;
  children: ReactNode;
}) {
  const view = canvas.view;
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; k: number } | null>(null);
  const [tip, setTip] = useState<{ from: string; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);

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
      if ((e.target as Element).closest(".cv-mini, .cv-drawer, .cv-empty")) return;
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
    if (target.closest(".cv-mini, .cv-empty, .cv-toast, .cv-drawer")) return;
    const hit = target.closest<SVGElement>("[data-wire-hit]");
    if (hit && !hand) {
      onSelectWire(hit.dataset.wireHit!);
      return;
    }
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
      // Selecting is not opening: a press that does not move opens the inspector on release; a drag only moves the node.
      onSelect(n.id);
      drag.current = { kind: "node", id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, moved: false };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return;
    }
    if (target.closest("button, a, input, select, textarea")) return;
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
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
    if (d.kind === "pan") {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > CLICK_SLOP) {
        d.moved = true;
        setPanning(true);
      }
      if (d.moved) setView({ ...view, x: d.vx + (e.clientX - d.sx), y: d.vy + (e.clientY - d.sy) });
    } else if (d.kind === "node") {
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) <= CLICK_SLOP) return;
        d.moved = true;
        record();
        setDragging(d.id);
      }
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
    setDragging(null);
    setPanning(false);
    if (d?.kind === "wire") {
      setTip(null);
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-node-id]");
      const to = under?.dataset.nodeId;
      if (to && to !== d.from) onWire(d.from, to);
    } else if (d?.kind === "node" && !d.moved) {
      onOpen(d.id);
    } else if (d?.kind === "pan" && !d.moved) {
      onSelect(null);
    }
  };

  const nodesById = new Map(canvas.nodes.map((n) => [n.id, n]));
  const from = tip ? nodesById.get(tip.from) : undefined;
  const inv = 1 / view.k;

  return (
    <div
      ref={boardRef}
      className={`cv-stage${busy ? " is-busy" : ""}`}
      data-hand={hand ? "true" : undefined}
      data-panning={panning ? "true" : undefined}
      style={{ "--gx": `${view.x}px`, "--gy": `${view.y}px`, "--gs": `${24 * view.k}px` } as React.CSSProperties}
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
      <div className="cv-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, "--inv": inv } as React.CSSProperties}>
        <svg className="cv-edges">
          {canvas.wires.map((w: CanvasWire) => {
            const a = nodesById.get(w.from);
            const b = nodesById.get(w.to);
            if (!a || !b) return null;
            const type = outputType(canvas, a) ?? "image";
            const d = wirePath(a, b);
            const live = statusOf(a) === "working" || statusOf(b) === "working";
            const hl = selected === w.from || selected === w.to;
            return (
              <g key={w.id}>
                <path d={d} className={`cv-e t-${type}${hl ? " is-hl" : ""}${selectedWire === w.id ? " is-sel" : ""}`} data-wire={`${w.from}->${w.to}`} />
                {live && <path d={d} className="cv-flowline" aria-hidden />}
                <path d={d} className="cv-hit" data-wire-hit={w.id} />
              </g>
            );
          })}
          {from && tip && <path d={wirePath(from, { x: tip.x, y: tip.y - PORT_Y })} className="cv-ghost" />}
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
            dragging={dragging === n.id}
            dropTarget={dropTarget === n.id}
            connecting={!!tip}
            jobs={jobs}
            previews={previews}
            onOpen={() => onOpen(n.id)}
            onRetry={() => onRetry(n.id)}
          />
        ))}
      </div>
      {children}
      {canvas.nodes.length > 0 && <Minimap canvas={canvas} boardRef={boardRef} onCentre={setView} open={mapOpen} onToggle={onToggleMap} selected={selected} statusOf={statusOf} />}
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
  dragging,
  dropTarget,
  connecting,
  jobs,
  previews,
  onOpen,
  onRetry,
}: {
  node: CanvasNode;
  canvas: CanvasState;
  status: NodeStatus;
  name: string;
  sourceName: string | null;
  selected: boolean;
  dragging: boolean;
  dropTarget: boolean;
  connecting: boolean;
  jobs: ReadonlyMap<string, JobReading>;
  previews: ReadonlyMap<string, { thumbUrl: string | null; kind: string }>;
  onOpen: () => void;
  onRetry: () => void;
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
  const input = inputOf(canvas, node, jobs);
  const words = node.kind === "prompt" ? node.draft : node.draft || input?.text || "";
  const working = status === "working" || status === "queued";
  const showArt = !!thumb || working || (node.kind === "asset" && status !== "missing") || status === "done";
  const cls = ["cv-node", `k-${node.kind}`, `s-${status}`, selected && "is-sel", dragging && "is-dragging", dropTarget && "is-drop"].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      data-node-id={node.id}
      data-kind={node.kind}
      data-status={status}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: NODE_W }}
      role="group"
      tabIndex={0}
      aria-label={`${name}: ${line}`}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {spec.accepts.length > 0 && (
        <span
          className={`cv-port is-in t-${spec.accepts[0]}${connecting ? " is-target" : ""}`}
          data-port-in={node.id}
          title={fmt(c.ports.in, { kinds: accepts })}
          aria-label={fmt(c.ports.in, { kinds: accepts })}
        >
          <span aria-hidden>{c.ports.letters[spec.accepts[0]]}</span>
        </span>
      )}
      {/* The title bar is the drag handle; a press that does not move opens the inspector. */}
      <div className="cv-nh">
        <span aria-hidden className={`cv-ty k-${node.kind}`}>
          <Icon className="size-4" strokeWidth={1.9} />
        </span>
        <span className="cv-nt">
          <span className="cv-nt-k">{c.kinds[node.kind].name}</span>
          <span className="cv-nt-n">{name}</span>
        </span>
      </div>
      <div className="cv-nb">
        {showArt && (
          <div className={`cv-art${working ? " is-working" : ""}${status === "failed" ? " is-failed" : ""}`} aria-hidden>
            {thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumb} alt="" draggable={false} />
            ) : (
              <Icon className="cv-art-glyph" />
            )}
          </div>
        )}
        {/* The words it makes from, clamped; with none, a placeholder only where it is true ("Not started" on a node that has a job would contradict its lamp). */}
        {node.kind !== "asset" && (words || !node.jobId) && (
          <p className={words ? "cv-clamp" : "cv-clamp is-empty"}>{words || (node.kind === "prompt" ? c.node.noWords : c.node.notStarted)}</p>
        )}
        <Lamp tone={LAMP[status]} live={status === "working"} label={status === "failed" ? t.gen.status.failed : line} />
        {sourceName && <span className="cv-nsub">{fmt(c.node.from, { name: sourceName })}</span>}
        {status === "failed" && job && (
          <div className="cv-nfail">
            <span className="cv-nfail-why">{failureReason(t, job)}</span>
            <button type="button" className="cv-nchip" onClick={onRetry} data-testid={`retry-${node.id}`}>
              <RotateCcw aria-hidden className="size-3.5" /> {c.node.retry}
            </button>
          </div>
        )}
      </div>
      {out && (
        <span
          className={`cv-port is-out t-${out}`}
          data-port-out={node.id}
          title={`${fmt(c.ports.out, { kind: c.ports[out] })} · ${c.wire.drag}`}
          aria-label={fmt(c.ports.out, { kind: c.ports[out] })}
        >
          <span aria-hidden>{c.ports.letters[out]}</span>
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
    case "words":
      return c.node.words;
    case "empty":
      return c.node.noWords;
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
  open,
  onToggle,
  selected,
  statusOf,
}: {
  canvas: CanvasState;
  boardRef: React.RefObject<HTMLDivElement | null>;
  onCentre: (v: Viewport) => void;
  open: boolean;
  onToggle: () => void;
  selected: string | null;
  statusOf: (n: CanvasNode) => NodeStatus;
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
    <div className={open ? "cv-mini" : "cv-mini is-min"}>
      <div className="cv-mini-h">
        <span>{c.map}</span>
        <button type="button" onClick={onToggle} aria-label={open ? c.mapMin : c.mapMax} title={open ? c.mapMin : c.mapMax} aria-expanded={open}>
          {open ? <Minus aria-hidden className="size-3.5" /> : <Plus aria-hidden className="size-3.5" />}
        </button>
      </div>
      {open && (
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
            <rect
              key={n.id}
              x={(n.x - minX) * s}
              y={(n.y - minY) * s}
              width={NODE_W * s}
              height={NODE_H * s}
              rx={2}
              className={`cv-mn${n.id === selected ? " is-sel" : statusOf(n) === "working" ? " is-run" : ""}`}
            />
          ))}
          <rect x={(tl.x - minX) * s} y={(tl.y - minY) * s} width={(br.x - tl.x) * s} height={(br.y - tl.y) * s} className="cv-mv" />
        </svg>
      )}
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
  const dialog = useRef<HTMLDivElement>(null);
  // Focus goes into the dialog, and back to whatever opened it when it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => opener?.focus?.();
  }, []);
  type Item = { id: string; group: "add" | "open"; label: string; sub: string; closed?: boolean; run: () => void; Icon: LucideIcon };
  const items: Item[] = [
    ...TOOL_KINDS.map((k) => {
      const closed = !kindOpen(availability, k);
      return {
        id: `add:${k}`,
        group: "add" as const,
        label: c.kinds[k].name,
        sub: closed ? `${c.node.notAvailable} · ${c.palette.closedWhy}` : c.kinds[k].desc,
        closed,
        run: () => onAdd(k),
        Icon: KIND_ICONS[k],
      };
    }),
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
  // A tool with nothing on sale is listed with its reason and cannot be added.
  const pick = (i: Item | undefined) => {
    if (i && !i.closed) i.run();
  };
  return (
    <>
      <div className="cv-scrim is-pal" onMouseDown={onClose} aria-hidden />
      <div
        ref={dialog}
        className="cv-pal"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "add" ? c.add.title : c.palette.label}
        data-testid="canvas-palette"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === "Tab") {
            // A focus trap: Tab cycles inside the dialog.
            const f = [...(dialog.current?.querySelectorAll<HTMLElement>("input, button:not([disabled])") ?? [])];
            if (f.length === 0) return;
            const i = f.indexOf(document.activeElement as HTMLElement);
            const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1;
            e.preventDefault();
            f[next].focus();
          }
        }}
      >
        <div className="cv-pi">
          <Search aria-hidden className="size-4" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
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
          />
          <button type="button" className="cv-icon" onClick={onClose} aria-label={c.add.close} title={c.add.close}>
            <X aria-hidden className="size-4" />
          </button>
        </div>
        <ul className="cv-pal-list" role="listbox" aria-label={c.palette.label}>
          {shown.length === 0 && <li className="cv-note px-3 py-2">{c.palette.empty}</li>}
          {shown.map((i, n) => (
            <li key={i.id}>
              {(n === 0 || shown[n - 1].group !== i.group) && <p className="cv-pop-h">{i.group === "add" ? c.palette.addGroup : c.palette.openGroup}</p>}
              <button
                type="button"
                role="option"
                aria-selected={n === active}
                aria-disabled={i.closed ? "true" : undefined}
                className="cv-pal-o"
                onMouseEnter={() => setActive(n)}
                onClick={() => pick(i)}
                data-testid={i.id}
              >
                <i.Icon aria-hidden className="size-4 shrink-0" />
                <span className="flex min-w-0 flex-col text-left">
                  <span className="cv-opt-on">{i.label}</span>
                  {i.sub && <span className={i.closed ? "cv-opt-why" : "cv-opt-os"}>{i.sub}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="cv-pal-f">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {c.palette.keyMove}
          </span>
          <span>
            <kbd>Enter</kbd> {c.palette.keyChoose}
          </span>
          <span>
            <kbd>Esc</kbd> {c.palette.keyClose}
          </span>
          <span className="cv-pal-hint">{c.palette.hint}</span>
        </div>
      </div>
    </>
  );
}

// ── first run ────────────────────────────────────────────────────────────────

function FirstRun({ filmStudio, phone, onRecipe, onBlank }: { filmStudio: boolean; phone: boolean; onRecipe: (r: Recipe, words?: string) => void; onBlank: () => void }) {
  const { t } = useI18n();
  const c = t.studioCanvas.firstRun;
  const path = useChannelPath();
  const [words, setWords] = useState("");
  const blank = phone ? c.blankPhone : c.blank;
  return (
    <section className="cv-empty" aria-labelledby="cv-empty-title" data-testid="canvas-first-run">
      <div className="cv-ecard">
        <h2 id="cv-empty-title">{c.ask}</h2>
        <p>{c.lead}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (words.trim()) onRecipe("promptVideo", words.trim());
          }}
        >
          <textarea className="cv-inp cv-ask" value={words} onChange={(e) => setWords(e.target.value.slice(0, 4000))} placeholder={c.askPlaceholder} aria-label={c.ask} data-testid="first-run-words" />
          <div className="cv-erow">
            <span className="cv-note">{c.askNote}</span>
            <button type="submit" className="cv-kbtn is-primary" disabled={!words.trim()} data-testid="first-run-go">
              {c.askGo}
            </button>
          </div>
        </form>
        <h3>{c.from}</h3>
        <ul className="cv-estarts">
          {RECIPES.map((r) => (
            <li key={r}>
              <button type="button" className="cv-estart" onClick={() => onRecipe(r)} data-testid={`recipe-${r}`}>
                <b>{c[r].name}</b>
                <span>{c[r].desc}</span>
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="cv-estart" onClick={onBlank} data-testid="recipe-blank">
              <b>{blank.name}</b>
              <span>{blank.desc}</span>
            </button>
          </li>
          {filmStudio && (
            <li>
              <Link href={path("/create/projects")} className="cv-estart" data-testid="recipe-projects">
                <b>{t.studioCanvas.projects}</b>
                <span>{t.studioCanvas.projectsSub}</span>
              </Link>
            </li>
          )}
        </ul>
      </div>
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
  selected,
  onOpen,
}: {
  canvas: CanvasState;
  statusOf: (n: CanvasNode) => NodeStatus;
  nodeName: (n: CanvasNode) => string;
  jobs: ReadonlyMap<string, JobReading>;
  previews: ReadonlyMap<string, { thumbUrl: string | null; kind: string }>;
  selected: string | null;
  onOpen: (id: string) => void;
}) {
  const { t, fmt } = useI18n();
  const c = t.studioCanvas;
  const order = flowOrder(canvas);
  const groups = (["sources", "make", "finish"] as const).map((id) => ({ id, nodes: order.filter((n) => FLOW_GROUP[n.kind] === id) }));
  if (canvas.nodes.length === 0) return <p className="cv-hint is-flow">{c.firstRun.blankPhone.desc}</p>;
  return (
    <div className="cv-flow" aria-label={c.flow.label}>
      {groups
        .filter((g) => g.nodes.length > 0)
        .map((g) => (
          <section key={g.id} className="cv-fgrp" aria-labelledby={`flow-${g.id}`}>
            <h2 id={`flow-${g.id}`}>{c.flow[g.id]}</h2>
            <ul className="cv-fcards">
              {g.nodes.map((n) => {
                const s = statusOf(n);
                const Icon = KIND_ICONS[n.kind];
                const input = inputOf(canvas, n, jobs);
                const asset = nodeAsset(n, jobs);
                const thumb = asset ? previews.get(asset)?.thumbUrl ?? null : null;
                const reading = n.jobId ? jobs.get(n.jobId) : undefined;
                const job = reading?.state === "ok" ? reading.job : null;
                const accepts = KIND_SPEC[n.kind].accepts.map((k) => c.ports[k]).join(" / ");
                const working = s === "working" || s === "queued";
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      className={`cv-fcard s-${s}${selected === n.id ? " is-sel" : ""}`}
                      data-status={s}
                      onClick={() => onOpen(n.id)}
                      data-testid={`flow-node-${n.kind}`}
                    >
                      {/* A prompt's picture is its words. */}
                      {n.kind === "prompt" ? (
                        <span className={n.draft.trim() ? "cv-fwords" : "cv-fwords is-empty"}>{n.draft.trim() || c.node.noWords}</span>
                      ) : (
                        <span className={`cv-art${working ? " is-working" : ""}${s === "failed" ? " is-failed" : ""}`} aria-hidden>
                          {thumb ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={thumb} alt="" />
                          ) : (
                            <Icon className="cv-art-glyph" />
                          )}
                        </span>
                      )}
                      <span className="cv-ft">
                        <span aria-hidden className={`cv-ty is-sm k-${n.kind}`}>
                          <Icon className="size-3.5" strokeWidth={1.9} />
                        </span>
                        <b>{nodeName(n)}</b>
                      </span>
                      <Lamp tone={LAMP[s]} live={s === "working"} label={statusLine(t, s, job, accepts)} />
                      {KIND_SPEC[n.kind].accepts.length > 0 && (
                        <span className="cv-fin">{input ? fmt(c.node.from, { name: nodeName(input.from) }) : c.flow.noInputs}</span>
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
