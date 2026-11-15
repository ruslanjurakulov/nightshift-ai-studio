"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlignLeft, Check, ChevronDown, Film, GitBranch, Hand, Layers, LayoutGrid, Maximize, Minus, MousePointer2, Palette, Plus, Projector, RotateCcw, Search, X, ZoomIn, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { useShell } from "@/components/shell/ShellContext";
import { creditUnit, formatCredits } from "@/lib/credits";
import { UPSELL_LINKS } from "@/lib/upsell";
import { ICONS } from "@/components/navigation/navIcons";
import { useLibraryImages, type LibraryPreview } from "@/components/studio/useLibraryImages";
import { refreshCredits } from "@/lib/credits-live";
import { coerceJobs, isActiveStatus, type StudioJob } from "@/lib/creative/studio";
import { studioTilesFor } from "@/lib/navigation";
import {
  EMPTY_STATE,
  KIND_SPEC,
  COMPOSER_H,
  COMPOSER_W,
  NODE_H,
  NODE_W,
  TOOL_KINDS,
  canWire,
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
  zoomAt,
  type CanvasNode,
  type CanvasState,
  type NodeKind,
  type Recipe,
  type ToolKind,
  type Viewport,
  type WireRefusal,
} from "@/lib/studio/canvas";
import { LibraryDrawer, type DroppedAsset } from "./LibraryDrawer";
import { Inspector, type PanelData } from "./Inspector";
import { InlineComposer, QuickAddMenu, type QuickMenuState } from "./QuickAdd";
import type { PanelQuote } from "@/components/studio/GeneratePanel";
import { KIND_ICONS, Lamp, statusLine } from "./parts";
import { Board } from "./FlowBoard";
import { LAMP, inputOf, jobAsset, kindOpen, nodeAsset, nodeStatus, resultView, type JobReading, type NodeStatus } from "./nodeState";
import "./studio-canvas.css";

export { KIND_ICONS };

const JOB_POLL_MS = 5000;
const POLL_CONCURRENCY = 6;
const NARROW = "(max-width: 760px)";
const HISTORY_MAX = 100;
/** The map's corner, kept clear by Fit so the map never sits on a node. */
const MAP_ROOM = 232;
const MAP_TALL = 176;
/** Where a card's eye line is, from its top: a focused card is centred on its title and art, not its full layout height. */
const FOCUS_Y = 120;
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
  /** The node whose Retry chip was pressed: its inspector refills from the failed job once, then clears this. */
  const [retryFor, setRetryFor] = useState<string | null>(null);
  const [quick, setQuick] = useState<QuickMenuState | null>(null);
  /** The card showing its own small composer (made with "+"); the inspector replaces it when opened. */
  const [composing, setComposing] = useState<string | null>(null);
  /** The server's quote per node, as its composer last reported it (never a number of ours). */
  const [quotes, setQuotes] = useState<ReadonlyMap<string, PanelQuote>>(() => new Map());
  const setQuote = useCallback((id: string, q: PanelQuote | null) => {
    setQuotes((prev) => {
      if ((prev.get(id) ?? null) === q) return prev;
      const next = new Map(prev);
      if (q === null) next.delete(id);
      else next.set(id, q);
      return next;
    });
  }, []);
  /**
   * Nodes whose job is being created right now (the POST is in flight), with the token of the form that pressed. A node's
   * status turns busy only once the POST returns its job id; until then a second form for it (the inspector after "More
   * options", a reopened inspector, a remount on a new input) would offer Generate again and start, and pay for, a second
   * job, whose id would then replace the first on the card. The token lets only the pressing form go on.
   */
  const [creating, setCreating] = useState<ReadonlyMap<string, string>>(() => new Map());
  const creatingRef = useRef(creating);
  creatingRef.current = creating;
  const setPressing = useCallback((id: string, on: boolean, token: string) => {
    setCreating((prev) => {
      if (on ? prev.get(id) === token : prev.get(id) !== token) return prev;
      const next = new Map(prev);
      if (on) next.set(id, token);
      else next.delete(id);
      return next;
    });
  }, []);
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
  // One request per job at a time, at most POLL_CONCURRENCY at once; a job whose read failed waits longer before the next.
  const inFlight = useRef(new Set<string>());
  const failures = useRef(new Map<string, { n: number; next: number }>());
  const refresh = useCallback(
    async (ids: readonly string[], force = false) => {
      const now = Date.now();
      const due = ids.filter((id) => !inFlight.current.has(id) && (force || (failures.current.get(id)?.next ?? 0) <= now));
      if (due.length === 0) return;
      due.forEach((id) => inFlight.current.add(id));
      const read: (readonly [string, JobReading])[] = [];
      try {
        for (let i = 0; i < due.length; i += POLL_CONCURRENCY) {
          const batch = due.slice(i, i + POLL_CONCURRENCY);
          read.push(...(await Promise.all(batch.map(async (id) => [id, await readJob(id)] as const))));
        }
      } finally {
        due.forEach((id) => inFlight.current.delete(id));
      }
      // Decided from what was on screen before this read, not inside the state update (which React may run twice).
      const before = jobsRef.current;
      let finished = false;
      let newFile = false;
      // Only the ids just read change: two refreshes ending in the same tick (a new job's first read and another's poll) must
      // both land, so the update merges into the latest state rather than replacing it with this refresh's snapshot.
      const next = new Map<string, JobReading>();
      for (const [id, r] of read) {
        const prev = before.get(id);
        if (r.state === "unknown") {
          const f = failures.current.get(id);
          const n = (f?.n ?? 0) + 1;
          failures.current.set(id, { n, next: Date.now() + Math.min(60_000, JOB_POLL_MS * 2 ** n) });
          // A failed poll keeps the last good reading (marked stale) and keeps polling: one 502 must not end the job's watch.
          next.set(id, prev?.state === "ok" ? { ...prev, stale: true } : { state: "unknown" });
          continue;
        }
        failures.current.delete(id);
        const wasActive = prev?.state === "ok" && (isActiveStatus(prev.job.status) || prev.job.status === "queued");
        if (wasActive && r.state === "ok" && !isActiveStatus(r.job.status) && r.job.status !== "queued") finished = true;
        // A job first read already finished (it ended while the page was away) put a file the library read may not have.
        const out = r.state === "ok" && r.job.status === "completed" ? r.job.result_asset_ids[0] : undefined;
        const knewDone = prev?.state === "ok" && prev.job.status === "completed";
        if (out && !knewDone && !libraryRef.current.previews.has(out)) newFile = true;
        next.set(id, r);
      }
      setJobs((prev) => {
        const merged = new Map(prev);
        for (const [id, r] of next) merged.set(id, r);
        return merged;
      });
      // A job that just ended charged or released its hold, and may have put a file in the library.
      if (finished && orgId) void refreshCredits(orgId);
      if (finished || newFile) libraryRef.current.reload();
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
      void refresh(unread, true);
    }
  }, [jobIds, refresh]);
  // Polled while working or queued (a stale reading included), and while a job could not be read yet; never while the tab is hidden.
  const activeKey = jobIds
    .filter((id) => {
      const r = jobs.get(id);
      // A job never read yet (or gone) is tried a few times, then left as "unknown" rather than polled for ever.
      if (r?.state === "unknown") return (failures.current.get(id)?.n ?? 99) < 6;
      // Not read yet: polled too, so a first read lost or still pending never leaves the node "loading" for ever.
      if (!r || r.state === "loading") return true;
      return r?.state === "ok" && (isActiveStatus(r.job.status) || r.job.status === "queued");
    })
    .join(",");
  useEffect(() => {
    if (!activeKey) return;
    const ids = activeKey.split(",");
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh(ids);
    }, JOB_POLL_MS);
    return () => clearInterval(id);
  }, [activeKey, refresh]);

  // ── derived ────────────────────────────────────────────────────────────────
  const libReady = library.state === "ready";
  // A result beyond the library's first page (LIBRARY_PAGE, newest first) is read on its own (GET /api/media/{id}), so an
  // older finished job still shows its picture instead of reading as "can't be shown". null: that read found no file.
  const [direct, setDirect] = useState<ReadonlyMap<string, LibraryPreview | null>>(() => new Map());
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (library.state !== "ready" || !orgId) return;
    for (const r of jobs.values()) {
      const id = jobAsset(r);
      if (!id || library.previews.has(id) || asked.current.has(id)) continue;
      asked.current.add(id);
      void (async () => {
        let found: LibraryPreview | null = null;
        try {
          const res = await fetch(`/api/media/${encodeURIComponent(id)}`, { cache: "no-store" });
          if (res.ok) {
            const body = (await res.json()) as { asset?: { kind?: string }; urls?: Partial<Record<string, string>> };
            const kind = body.asset?.kind;
            if (kind === "image" || kind === "video" || kind === "audio") {
              const u = body.urls ?? {};
              found = { kind, thumbUrl: u.thumb ?? null, viewUrl: u.display ?? u.proxy ?? u.original ?? null };
            }
          }
        } catch {
          /* found stays null: the card says the result cannot be shown, with "Load again" */
        }
        setDirect((prev) => new Map(prev).set(id, found));
      })();
    }
  }, [jobs, library.state, library.previews, orgId]);
  const previews = useMemo(() => {
    if (direct.size === 0) return library.previews;
    const m = new Map(library.previews);
    for (const [id, p] of direct) if (p && !m.has(id)) m.set(id, p);
    return m;
  }, [library.previews, direct]);
  // Still being read: the library itself, or a direct read asked and not answered. A failed or unavailable library is not
  // "still loading" for ever: its results read as missing, with "Load again".
  const resultPending = useCallback(
    (id: string) => library.state === "loading" || (asked.current.has(id) && !direct.has(id)) || (library.state === "ready" && !asked.current.has(id) && !library.previews.has(id)),
    [library.state, library.previews, direct],
  );
  const reloadResults = useCallback(() => {
    asked.current.clear();
    setDirect(new Map());
    libraryRef.current.reload();
  }, []);
  const statusOf = useCallback(
    (n: CanvasNode): NodeStatus => nodeStatus(canvas, n, jobs, availability, { ready: libReady, previews }),
    [canvas, jobs, availability, libReady, previews],
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
    // The card's own composer is pressing: swapping it for the inspector would be a second form for the same job.
    if (composing === id && creatingRef.current.has(id)) {
      setSelected(id);
      say(c.inspector.busy);
      return;
    }
    setSelected(id);
    setSelectedWire(null);
    setInspecting(true);
    setComposing(null);
  };
  /** A job the composer started belongs to its node; it is read back from the database like any other. */
  const attachJob = (nodeId: string, jobId: string) => {
    patchNode(nodeId, { jobId });
    setJobs((prev) => new Map(prev).set(jobId, { state: "loading" }));
    void refresh([jobId]);
  };
  /** Centre a card in the board at 100% (no inspector beside it). */
  const centreOn = (spot: { x: number; y: number }) => {
    requestAnimationFrame(() => {
      const r = boardRef.current?.getBoundingClientRect();
      if (!r) return;
      setCanvas((s) => ({ ...s, view: { x: Math.round(r.width / 2 - (spot.x + 230)), y: Math.round(r.height / 2 - (spot.y + 250)), k: 1 } }));
    });
  };
  /** "+" picked a next step: a new card to the right of the source (or where the wire was dropped), wired from it, with its own composer. */
  const quickAdd = (from: string, kind: ToolKind, at?: { x: number; y: number }) => {
    const src = canvas.nodes.find((n) => n.id === from);
    if (!src || !kindOpen(availability, kind)) return;
    // The new card opens with its composer (COMPOSER_W x COMPOSER_H), so all of that must be clear, not just a card's size;
    // the source itself may be showing its composer too.
    const w = kind === "effects" ? NODE_W : COMPOSER_W;
    const h = kind === "effects" ? NODE_H : COMPOSER_H;
    let spot = at ?? { x: src.x + (composing === src.id ? COMPOSER_W : NODE_W) + 96, y: src.y };
    if (!at) {
      // Down the column until the spot is clear, so the new card never lands on another.
      const hit = (p: { x: number; y: number }) =>
        canvas.nodes.find((n) => p.x < n.x + NODE_W + 40 && n.x < p.x + w + 40 && p.y < n.y + NODE_H + 40 && n.y < p.y + h + 40);
      for (let guard = 0, n = hit(spot); n && guard < 200; guard++, n = hit(spot)) spot = { x: spot.x, y: n.y + NODE_H + 56 };
    }
    const id = makeId();
    edit((s) => connect({ ...s, nodes: [...s.nodes, newNode(kind, spot.x, spot.y, id)] }, from, id, makeId()));
    setFirstRunDone(true);
    setSelected(id);
    setSelectedWire(null);
    if (narrow) {
      open(id);
    } else {
      setInspecting(false);
      setComposing(kind === "effects" ? null : id);
      centreOn(spot);
    }
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
    if (next.nodes.some((n) => !kindOpen(availability, n.kind))) {
      say(c.wire.closed);
      return;
    }
    edit((s) => ({ ...next, view: s.view }));
    setFirstRunDone(true);
    // The first step that makes something opens with its composer, the idea already in it (from the wired words).
    const first = next.nodes.find((n) => n.kind !== "prompt" && n.kind !== "asset") ?? next.nodes[0];
    if (first) {
      setSelected(first.id);
      if (narrow) open(first.id);
      else if (r !== "photoClip") {
        setInspecting(false);
        setComposing(first.id);
      }
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

  // Opening a node brings it to 100% and centres it in the board beside the inspector (the prototype's focusNode(id, 1)).
  // After layout: the board has just narrowed by the inspector's width.
  useEffect(() => {
    if (narrow || !inspecting || !selected) return;
    const id = requestAnimationFrame(() => {
      const n = canvasRef.current.nodes.find((m) => m.id === selected);
      const r = boardRef.current?.getBoundingClientRect();
      if (!n || !r) return;
      const k = 1;
      setCanvas((s) => ({ ...s, view: { x: Math.round(r.width / 2 - (n.x + NODE_W / 2) * k), y: Math.round(r.height / 2 - (n.y + FOCUS_Y) * k), k } }));
    });
    return () => cancelAnimationFrame(id);
  }, [inspecting, selected, narrow]);

  // ── keys: ⌘K searches, N adds, Delete removes, ⌘Z undoes, + / − / 0 zoom, Escape closes ──
  const [space, setSpace] = useState(false);
  const focusFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), []);
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
      // The "+" menu closes on Escape wherever focus is (its own handler stops the key when focus is inside it).
      if (e.key === "Escape" && document.querySelector("[data-quick-menu]")) {
        setQuick((q) => {
          (q?.opener as HTMLElement | null | undefined)?.focus?.();
          return null;
        });
        return;
      }
      if (document.querySelector('[role="dialog"], [data-quick-menu]')) return;
      if (e.key === "Escape") {
        if (drawer || inspecting) {
          const wasInspecting = inspecting && selected;
          setDrawer(false);
          setInspecting(false);
          // Focus goes back to the card that was open, not to the page: the keyboard keeps its place.
          if (wasInspecting) {
            const id = selected;
            // Found by data attribute, not a selector string: no CSS.escape needed (jsdom has none). Cancelled on unmount.
            cancelAnimationFrame(focusFrame.current);
            focusFrame.current = requestAnimationFrame(() =>
              Array.from(document.querySelectorAll<HTMLElement>("[data-node-id]"))
                .find((el) => el.dataset.nodeId === id)
                ?.focus(),
            );
          }
        } else {
          setSelected(null);
          setSelectedWire(null);
        }
        return;
      }
      if (typing(e.target)) return;
      // The board's keys belong to the board: with focus in the inspector, the Library or anything else outside the stage (a
      // composer's buttons, a radio group), Backspace must not delete the node and arrows must not move it.
      const target = e.target;
      const onBoard = !(target instanceof Element) || target === document.body || target === document.documentElement || (!!target.closest(".cv-stage") && !target.closest(".cv-drawer, .cv-ncomp"));
      if (!onBoard) return;
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

  const bar = <ProjectBar filmStudio={filmStudio} onSearch={() => setPalette("all")} inline={!slot} view="canvas" />;
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
        previews={previews}
        nodeName={nodeName}
        retryNow={retryFor === sel.id}
        onQuote={(n) => setQuote(sel.id, n)}
        creatingBy={creating.get(sel.id)}
        onPressing={(on, token) => setPressing(sel.id, on, token)}
        onRetried={() => setRetryFor(null)}
        sheet={narrow}
        onClose={() => setInspecting(false)}
        onDraft={(words) => {
          if (words !== sel.draft) patchNode(sel.id, { draft: words.slice(0, 4000) });
        }}
        onCreated={(jobId) => attachJob(sel.id, jobId)}
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

  const quickFrom = quick ? canvas.nodes.find((n) => n.id === quick.from) ?? null : null;
  const quickEl =
    quick && quickFrom
      ? overlay(
          <QuickAddMenu
            state={quick}
            out={outputType(canvas, quickFrom)}
            fromName={nodeName(quickFrom)}
            onClose={() => setQuick(null)}
            onPick={(k) => {
              setQuick(null);
              quickAdd(quickFrom.id, k, quick.at);
            }}
          />,
        )
      : null;
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
  // Focus the step's Generate (its composer: the card's own, or the inspector's): the dock never presses it.
  const focusGenerate = (id: string) => {
    let tries = 0;
    const go = () => {
      const box = document.querySelector(`[data-testid="inline-composer-${id}"]`) ?? document.querySelector('[data-testid="canvas-inspector"]');
      const key = box?.querySelector<HTMLElement>(".ns-price-button");
      if (key) key.focus();
      else if (tries++ < 20) requestAnimationFrame(go);
    };
    requestAnimationFrame(go);
  };
  const quote = (
    <QuoteKey
      node={sel}
      status={sel ? statusOf(sel) : null}
      quote={sel ? quotes.get(sel.id) ?? null : null}
      onChoose={() => setPalette("add")}
      onPrice={() => {
        if (!sel) return;
        if (composing !== sel.id) open(sel.id);
        focusGenerate(sel.id);
      }}
    />
  );

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
            previews={previews}
            selected={selected}
            onOpen={open}
            onPlus={(from, el) => setQuick({ from, x: 0, y: 0, opener: el, sheet: true })}
            resultPending={resultPending}
            onReload={reloadResults}
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
        {quickEl}
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
            setRetryFor(id);
          }}
          hand={mode === "hand" || space}
          busy={busy}
          statusOf={statusOf}
          isClosed={(n) => !kindOpen(availability, n.kind)}
          nodeName={nodeName}
          jobs={jobs}
          previews={previews}
          canConnect={(from, to) => {
            const target = canvas.nodes.find((n) => n.id === to);
            return !!target && kindOpen(availability, target.kind) && canWire(canvas, from, to).ok;
          }}
          onWire={wire}
          onDrop={dropAsset}
          mapOpen={mapOpen}
          mapHidden={inspecting && !!sel}
          resultPending={resultPending}
          onReloadLibrary={reloadResults}
          composerFor={(n) =>
            composing === n.id && !!data.orgId && !inspecting && !n.jobId && kindOpen(availability, n.kind) ? (
              <InlineComposer
                node={n}
                state={canvas}
                jobs={jobs}
                data={data}
                onDraft={(words) => {
                  if (words !== n.draft) patchNode(n.id, { draft: words.slice(0, 4000) });
                }}
                onCreated={(jobId) => {
                  attachJob(n.id, jobId);
                  // Only this card's composer closes: by the time the POST returns, another card may be composing.
                  setComposing((cur) => (cur === n.id ? null : cur));
                }}
                onMore={() => open(n.id)}
                onQuote={(q) => setQuote(n.id, q)}
                creatingBy={creating.get(n.id)}
                onPressing={(on, token) => setPressing(n.id, on, token)}
              />
            ) : null
          }
          onPlus={(from, p) => {
            const r = boardRef.current?.getBoundingClientRect();
            const w = p.dropped && r ? toCanvas(canvas.view, p.clientX - r.left, p.clientY - r.top) : null;
            setQuick({ from, x: p.clientX, y: p.clientY, opener: p.el ?? null, at: w ? { x: Math.round(w.x), y: Math.round(w.y - 25) } : undefined });
          }}
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
      {quickEl}
    </div>
  );
}

/** The deck's price key: the price lives in the selected node's form (its backend quote), so it opens that form. */
/**
 * The deck's main key, by what the person can do next: choose a step (nothing to price), get the price (a step that can run), or
 * make it for the price the server quoted. It never spends: it opens or focuses that step's composer, whose Generate is the only
 * press that creates a job (one per quote).
 */
function QuoteKey({
  node,
  status,
  quote,
  onChoose,
  onPrice,
}: {
  node: CanvasNode | null;
  status: NodeStatus | null;
  quote: PanelQuote | null;
  onChoose: () => void;
  onPrice: () => void;
}) {
  const { t, fmt, locale } = useI18n();
  const c = t.studioCanvas;
  const path = useChannelPath();
  const priceable = !!node && node.kind !== "asset" && node.kind !== "prompt" && (status === "idle" || status === "failed");
  // Short of credits: Generate would only be refused, so the key goes to the top-ups (a link; nothing is bought here).
  if (priceable && quote?.state === "short") {
    return (
      <Link href={path(UPSELL_LINKS.topups)} className="cv-kbtn is-primary" title={c.quote} data-testid="dock-quote" data-state="topup">
        {c.dock.topUp}
      </Link>
    );
  }
  const state = !priceable ? "choose" : quote?.state === "ready" ? "make" : "price";
  const label =
    state === "choose"
      ? c.dock.choose
      : quote?.state === "ready"
        ? fmt(c.dock.make, { n: formatCredits(quote.credits, locale), unit: creditUnit(quote.credits, locale, t.shell.creditUnit) })
        : c.dock.getPrice;
  // The price cannot form (a locked model, no length, a refused quote): the reason is said beside the key, not left to guess.
  const why = state === "price" && quote?.state === "blocked" ? quote.why : null;
  return (
    <>
      {why && (
        <span className="cv-qwhy" id="cv-dock-why" data-testid="dock-why">
          {why}
        </span>
      )}
      <button
        type="button"
        className="cv-kbtn is-primary"
        onClick={priceable ? onPrice : onChoose}
        title={why ?? (priceable ? c.quote : c.quoteHint)}
        aria-describedby={why ? "cv-dock-why" : undefined}
        data-testid="dock-quote"
        data-state={state}
      >
        {label}
      </button>
    </>
  );
}

// ── the project bar (in the app's header on this page) ─────────────────────────

export function ProjectBar({
  filmStudio,
  onSearch,
  inline,
  view,
  title,
  sub,
}: {
  filmStudio: boolean;
  onSearch?: () => void;
  inline: boolean;
  view: "canvas" | "timeline";
  /** The Timeline names the project it shows; the canvas is the person's sketch. */
  title?: string;
  sub?: string;
}) {
  // The key a person actually presses: ⌘ on a Mac, Ctrl elsewhere (read after hydration, so the server's render is stable).
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)), []);
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
            <span className="cv-pswitch-nm">{title ?? c.sketch}</span>
            <span className="cv-pswitch-kd">{sub ?? c.sketchSub}</span>
          </span>
          <ChevronDown aria-hidden className="size-4 shrink-0" />
        </button>
        {open && (
          <div className="cv-pop" role="menu" aria-label={c.switcher}>
            <p className="cv-pop-h">{c.views}</p>
            <MenuLink href={path("/studio")} icon={<Check aria-hidden className="size-4" />} label={c.viewCanvas} current={view === "canvas"} />
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
        <Link href={path("/studio")} aria-current={view === "canvas" ? "page" : undefined} data-testid="view-canvas">
          <GitBranch aria-hidden className="size-4" /> {c.viewCanvas}
        </Link>
        <Link href={path("/studio?view=timeline")} aria-current={view === "timeline" ? "page" : undefined} data-testid="view-timeline">
          <AlignLeft aria-hidden className="size-4" /> {c.timeline}
        </Link>
      </div>
      {/* Brand look, one click from where its old bookmark lands (STUDIO_IA.md §9.1). */}
      <Link href={path("/studio/look")} className="cv-chip-link" data-testid="channel-look-chip" aria-label={t.studioHub.channelLook} title={t.studioHub.channelLook}>
        <Palette aria-hidden className="size-4" />
        <span className="cv-chip-label">{t.studioHub.channelLook}</span>
      </Link>
      <span className="cv-grow" />
      {onSearch && (
        <button type="button" className="cv-kbtn cv-search" onClick={onSearch} data-testid="canvas-search" aria-label={c.search}>
          <Search aria-hidden className="size-4" />
          <span className="cv-search-label">{c.search}</span>
          <kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
      )}
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
        sub: closed ? c.node.notAvailable : c.kinds[k].desc,
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
                title={i.closed ? c.palette.closedWhy : undefined}
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
            <kbd>{c.palette.keys.up}</kbd>
            <kbd>{c.palette.keys.down}</kbd> {c.palette.keyMove}
          </span>
          <span>
            <kbd>{c.palette.keys.enter}</kbd> {c.palette.keyChoose}
          </span>
          <span>
            <kbd>{c.palette.keys.esc}</kbd> {c.palette.keyClose}
          </span>
          <span className="cv-pal-hint">{c.palette.hint}</span>
        </div>
      </div>
    </>
  );
}

// ── first run ────────────────────────────────────────────────────────────────

type Tile = "image" | "video" | "voice" | "project";
const TILES: readonly Tile[] = ["image", "video", "voice", "project"];
/** What each tile lays out: fixed chains, no planning call (a server-side planner comes later). */
const TILE_RECIPE: Record<Exclude<Tile, "project">, Recipe> = { image: "promptImage", video: "promptVideo", voice: "promptVoice" };
const TILE_ICON: Record<Tile, LucideIcon> = { image: KIND_ICONS.image, video: KIND_ICONS.video, voice: KIND_ICONS.voice, project: Projector };

/**
 * The empty canvas: "What shall we make?" with one idea box and four big tiles. Nightshift lays out the chain (the person does
 * not wire anything), fits it, and opens the first making step with the idea in it. A tile whose tools are not on sale, or
 * "Finished video" while projects are off, is shown and refused.
 */
function FirstRun({ filmStudio, phone, onRecipe, onBlank }: { filmStudio: boolean; phone: boolean; onRecipe: (r: Recipe, words?: string) => void; onBlank: () => void }) {
  const { t } = useI18n();
  const c = t.studioCanvas.firstRun;
  const path = useChannelPath();
  const { tools: availability } = useShell();
  const [words, setWords] = useState("");
  const closedIn = (r: Recipe) => recipeState(r, () => "x").nodes.some((n) => !kindOpen(availability, n.kind));
  const closed = (tile: Tile) => (tile === "project" ? !filmStudio : closedIn(TILE_RECIPE[tile]));
  return (
    <section className="cv-empty" aria-labelledby="cv-empty-title" data-testid="canvas-first-run">
      <div className="cv-ecard">
        <h2 id="cv-empty-title">{c.ask}</h2>
        <textarea
          className="cv-inp cv-ask"
          value={words}
          onChange={(e) => setWords(e.target.value.slice(0, 4000))}
          placeholder={c.askPlaceholder}
          aria-label={c.ask}
          data-testid="first-run-words"
        />
        <p className="cv-note">{c.askNote}</p>
        <ul className="cv-tiles">
          {TILES.map((tile) => {
            const Icon = TILE_ICON[tile];
            const off = closed(tile);
            const body = (
              <>
                <span className="cv-tile-ic" aria-hidden>
                  <Icon className="size-6" strokeWidth={1.7} />
                </span>
                <b>{c.tiles[tile].name}</b>
                <span>{off ? t.studioCanvas.node.notAvailable : c.tiles[tile].desc}</span>
              </>
            );
            return (
              <li key={tile}>
                {tile === "project" && !off ? (
                  <Link href={path("/create/projects")} className="cv-tile" data-testid="tile-project">
                    {body}
                  </Link>
                ) : (
                  <button
                    type="button"
                    className="cv-tile"
                    aria-disabled={off ? "true" : undefined}
                    title={off ? t.studioCanvas.palette.closedWhy : undefined}
                    onClick={() => {
                      if (!off && tile !== "project") onRecipe(TILE_RECIPE[tile], words.trim());
                    }}
                    data-testid={`tile-${tile}`}
                  >
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <button type="button" className="cv-link" onClick={onBlank} data-testid="recipe-blank" title={(phone ? c.blankPhone : c.blank).desc}>
          {c.blankLink}
        </button>
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
  onPlus,
  resultPending,
  onReload,
}: {
  canvas: CanvasState;
  statusOf: (n: CanvasNode) => NodeStatus;
  nodeName: (n: CanvasNode) => string;
  jobs: ReadonlyMap<string, JobReading>;
  previews: ReadonlyMap<string, LibraryPreview>;
  selected: string | null;
  onOpen: (id: string) => void;
  onPlus: (from: string, el: HTMLElement) => void;
  resultPending: (assetId: string) => boolean;
  onReload: () => void;
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
                // As on the board: "Made" only beside the real result; a result that cannot be shown says so.
                const rv = resultView(n, s, jobs, previews, resultPending);
                return (
                  <li key={n.id} className="cv-fli">
                    {outputType(canvas, n) && (
                      <button
                        type="button"
                        className="cv-plus is-flow"
                        aria-label={fmt(c.quick.add, { name: nodeName(n) })}
                        aria-haspopup="menu"
                        onClick={(e) => onPlus(n.id, e.currentTarget)}
                        data-testid={`plus-${n.id}`}
                      >
                        <Plus aria-hidden className="size-4" />
                      </button>
                    )}
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
                          ) : rv === "missing" ? (
                            <span className="cv-art-note" data-testid={`flow-result-missing-${n.id}`}>
                              {c.node.resultMissing}
                            </span>
                          ) : rv === "loading" ? (
                            <span className="cv-art-note">{c.node.resultLoading}</span>
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
                      <Lamp
                        tone={rv === "missing" ? "warn" : rv === "loading" ? "idle" : LAMP[s]}
                        live={s === "working"}
                        label={rv === "missing" ? c.node.resultMissing : rv === "loading" ? c.node.resultLoading : statusLine(t, s, job, accepts)}
                      />
                      {KIND_SPEC[n.kind].accepts.length > 0 && (
                        <span className="cv-fin">{input ? fmt(c.node.from, { name: nodeName(input.from) }) : c.flow.noInputs}</span>
                      )}
                    </button>
                    {rv === "missing" && (
                      <button type="button" className="cv-nchip is-flow" onClick={onReload} data-testid={`flow-result-reload-${n.id}`}>
                        <RotateCcw aria-hidden className="size-3.5" /> {c.node.resultRetry}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
    </div>
  );
}
