"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import Link from "next/link";
import {
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { fmt } from "@/lib/i18n/core";
import { createCampaignWorkflow, inspectWorkflow, NODE_TYPES, type AgentWorkflow, type NodeType } from "@/lib/agent-graph";
import { addNode, checkConnection, clampPosition, type NodePosition } from "@/lib/agent-graph-editor";
import { exportWorkflowDraft, importWorkflowDraft } from "@/lib/agent-draft";
import {
  applyConnect,
  connectionAllowed,
  connectionReason,
  dropPosition,
  edgeId,
  focusAfterRemoval,
  nodePosition,
  readEdgeChanges,
  readNodeChanges,
  removeEdges,
  removeNodeAndPosition,
  toFlowEdges,
  toFlowNodes,
  wirePorts,
  type AgentFlowEdge,
  type AgentFlowNode,
} from "@/lib/agent-flow";
import { AgentCanvasContext, AgentEdge, AgentNode, type AgentBuilderCopy, type AgentCanvasActions } from "./AgentNode";
import { planCreativeRequest, type CreativeIntent } from "@/lib/agent-planner";
import type { DirectProvider, ProviderPlan } from "@/lib/agent-providers";
import styles from "./agent-builder.module.css";

/** The review card for each direct provider, planned on the server (lib/agent-providers.ts is server-only: its registry names
 *  each provider's licensing and pricing state, which no static chunk may carry). */
export type ProviderPreviews = Record<DirectProvider, ProviderPlan | { error: string }>;

const FLOW_NODE_TYPES = { agent: AgentNode };
const FLOW_EDGE_TYPES = { agent: AgentEdge };
/** The world the old SVG canvas drew (2470 × 1850): clampPosition keeps a card's corner inside 2200 × 1600 of it. */
const WORLD: [[number, number], [number, number]] = [[0, 0], [2470, 1850]];
const PAN_LIMIT: [[number, number], [number, number]] = [[-400, -400], [2870, 2250]];
const DELETE_KEYS = ["Delete", "Backspace"];
const ZOOM_KEYS = ["Meta", "Control"];
const PRO_OPTIONS = { hideAttribution: true };
const FIT = { padding: 0.12, maxZoom: 1 };
/** On a phone, fitting 6+ cards into 360px drew them at 0.39, every button under 15px: fit no smaller than 0.75 and let the person pan. */
const FIT_NARROW = { ...FIT, minZoom: 0.75 };
const NARROW = "(max-width: 540px)";
const isNarrow = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches;

/** Turn a set of ids on or off; the same object back when nothing changed, so React keeps its render. */
function toggled(prev: ReadonlySet<string>, changes: Record<string, boolean>): ReadonlySet<string> {
  const next = new Set(prev);
  for (const [id, on] of Object.entries(changes)) if (on) next.add(id); else next.delete(id);
  return next.size === prev.size && [...next].every(id => prev.has(id)) ? prev : next;
}
const subscribeNarrow = (change: () => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};
/** The phone layout, for the zoom-to-fit button; false on the server, where there is no screen. */
const useNarrow = () => useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
const without = (prev: ReadonlySet<string>, ids: Iterable<string>) => toggled(prev, Object.fromEntries([...ids].map(id => [id, false])));

export function AgentBuilder(props: { providerPreviews: ProviderPreviews; copy: AgentBuilderCopy }) {
  return <ReactFlowProvider><AgentBuilderInner {...props} /></ReactFlowProvider>;
}

function AgentBuilderInner({ providerPreviews, copy }: { providerPreviews: ProviderPreviews; copy: AgentBuilderCopy }) {
  const [graph, setGraph] = useState<AgentWorkflow>(createCampaignWorkflow);
  const [source, setSource] = useState("brand");
  const [target, setTarget] = useState("prompt");
  const [newType, setNewType] = useState<NodeType>("video.generate");
  const [requestText, setRequestText] = useState("");
  const [planType, setPlanType] = useState<CreativeIntent>("image");
  const [provider, setProvider] = useState<DirectProvider>("ideogram");
  const [notice, setNotice] = useState("");
  const [positions, setPositions] = useState<Record<string, NodePosition>>({});
  const importInput = useRef<HTMLInputElement>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [remoteDrafts, setRemoteDrafts] = useState<Array<{id:string;name:string;current_version:number}>>([]);
  const [chosenDraft, setChosenDraft] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  // React Flow's view of the draft: where a card is mid-drag (saved on drop), what is selected, and its measured size.
  // None of it is the draft: graph and positions are, and everything below writes back through lib/agent-graph-editor.
  const [dragging, setDragging] = useState<Record<string, NodePosition>>({});
  const [selectedNodes, setSelectedNodes] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(() => new Set());
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const narrow = useNarrow();
  const fitOptions = narrow ? FIT_NARROW : FIT;
  // What to frame next: the whole draft (on load, import, planner, example) or one new card. Run after the render that
  // gives React Flow the new nodes; React Flow holds a fit until those nodes are measured.
  const [fitRequest, setFitRequest] = useState<{ n: number; id?: string }>({ n: 0 });
  const [focusRequest, setFocusRequest] = useState<{ n: number; id: string | null } | null>(null);
  const { fitView, getNode, getZoom, setCenter } = useReactFlow<AgentFlowNode, AgentFlowEdge>();
  useEffect(() => {
    if (!fitRequest.id) { void fitView(isNarrow() ? FIT_NARROW : FIT); return; }
    // A new card: centre on it at the zoom the person chose, rather than re-fitting the whole draft under them.
    const node = getNode(fitRequest.id);
    if (node) void setCenter(node.position.x + 110, node.position.y + 120, { zoom: getZoom(), duration: 200 });
  }, [fitRequest, fitView, getNode, getZoom, setCenter]);
  const flowArea = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const area = flowArea.current;
    const card = focusRequest.id ? [...(area?.querySelectorAll<HTMLElement>(".react-flow__node") ?? [])].find(n => n.dataset.id === focusRequest.id) : null;
    (card ?? area)?.focus();
  }, [focusRequest]);
  const relayout = () => { setDragging({}); setSelectedNodes(new Set()); setSelectedEdges(new Set()); setFitRequest(r => ({ n: r.n + 1 })); };
  const moveNode = (id: string, position: NodePosition) => setPositions(prev => ({ ...prev, [id]: clampPosition(position.x, position.y) }));
  const report = useMemo(() => inspectWorkflow(graph), [graph]);
  // An empty plan passes inspectWorkflow (0130 and its tests define that), but there is nothing in it to export or save.
  const empty = graph.nodes.length === 0;
  const exportable = report.ok && !empty;
  const nodeMap = useMemo(() => new Map(graph.nodes.map(n => [n.id, n])), [graph]);
  const labelOf = (id: string) => nodeMap.get(id)?.label ?? id;
  const flowNodes = useMemo(() => toFlowNodes(graph, positions, { dragging, selected: selectedNodes, measured }), [graph, positions, dragging, selectedNodes, measured]);
  const flowEdges = useMemo(() => toFlowEdges(graph, selectedEdges), [graph, selectedEdges]);
  const providerPreview = providerPreviews[provider];
  /** checkConnection's reason in the reader's language; its English when it is one this map does not know. */
  const reasonText = (reason: string) => { const key = connectionReason(reason); return key ? copy.reasons[key] : reason; };
  const generatePlan = () => {
    const planned = planCreativeRequest(requestText, planType);
    if (!planned.ok) { setNotice("Planner refused request: " + planned.error); return; }
    setGraph(planned.workflow);
    setPositions({});
    relayout();
    setSavedId(null);
    setSavedVersion(null);
    setSource("");
    setTarget("");
    setNotice("Offline draft prepared: " + planned.intent + ". No AI APIs, execution or spending.");
  };
  const addConnection = () => {
    const outcome = checkConnection(graph, source, target);
    if (!outcome.ok) { setNotice(reasonText(outcome.reason)); return; }
    setGraph(prev => ({ ...prev, edges: [...prev.edges, { source, target }] }));
    setNotice(copy.connected);
  };
  const add = () => {
    const next = addNode(graph, newType);
    if (next === graph) return;
    setGraph(next);
    setNotice("Node added to workspace.");
    // The new card lands on its grid slot, often outside the current view: bring it in.
    setFitRequest(r => ({ n: r.n + 1, id: next.nodes[next.nodes.length - 1].id }));
  };
  /** Nodes leave with their wires and saved positions (removeNodeAndPosition), and with every trace React Flow's view kept. */
  const removeMany = (ids: readonly string[]) => {
    const gone = new Set(ids.filter(id => graph.nodes.some(n => n.id === id)));
    if (!gone.size) return;
    let next = { graph, positions };
    for (const id of gone) next = removeNodeAndPosition(next.graph, next.positions, id);
    const wires = graph.edges.filter(e => gone.has(e.source) || gone.has(e.target)).map(e => edgeId(e.source, e.target));
    setGraph(next.graph);
    setPositions(next.positions);
    setDragging(prev => [...gone].reduce(dropPosition, prev));
    setMeasured(prev => [...gone].reduce(dropPosition, prev));
    setSelectedNodes(prev => without(prev, gone));
    setSelectedEdges(prev => without(prev, wires));
    if (gone.has(source)) setSource("");
    if (gone.has(target)) setTarget("");
    setFocusRequest(r => ({ n: (r?.n ?? 0) + 1, id: focusAfterRemoval(graph, gone) }));
  };
  const remove = (id: string) => removeMany([id]);
  const disconnect = (ids: ReadonlySet<string>) => {
    setGraph(prev => removeEdges(prev, ids));
    setSelectedEdges(prev => without(prev, ids));
  };
  // The drag only colours the target; the types decide (checkConnection), and named handles must be the ports the wire would
  // be drawn on, so it never jumps to another input once added.
  const isValidConnection = useCallback((conn: Connection | Edge) => connectionAllowed(graph, conn), [graph]);
  const onConnect = (conn: Connection) => {
    // Checked again on the drop (lib/agent-flow applyConnect): isValidConnection is advice to the pointer, not a gate.
    const outcome = applyConnect(graph, conn.source, conn.target);
    if (!outcome.ok) { setNotice(reasonText(outcome.reason)); return; }
    setGraph(prev => applyConnect(prev, conn.source, conn.target).graph);
    setNotice(copy.connected);
  };
  // A drop React Flow refused never reaches onConnect: say why here, from the same checks, so a pointer (dragged, or
  // click-to-connect) gets the reason too.
  const onConnectEnd = (_: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid !== false || !state.fromNode || !state.toNode) return;
    // Output on output or input on input: no pair of types to judge, only the direction to explain.
    if (state.toHandle && state.fromHandle && state.toHandle.type === state.fromHandle.type) { setNotice(copy.dragOutToIn); return; }
    const [from, to] = state.fromHandle?.type === "target" ? [state.toNode.id, state.fromNode.id] : [state.fromNode.id, state.toNode.id];
    const outcome = checkConnection(graph, from, to);
    if (!outcome.ok) { setNotice(reasonText(outcome.reason)); return; }
    // An allowed pair dropped on another input of the same card: name the one it goes to.
    const fromType = nodeMap.get(from)?.type, toType = nodeMap.get(to)?.type;
    const port = fromType && toType ? wirePorts(fromType, toType).targetHandle : null;
    if (port) setNotice(fmt(copy.wrongPort, { port: copy.ports[port] }));
  };
  const onNodesChange = (changes: NodeChange<AgentFlowNode>[]) => {
    const out = readNodeChanges(graph, changes);
    const persisted = Object.keys(out.persist);
    if (Object.keys(out.dragging).length) setDragging(prev => ({ ...prev, ...out.dragging }));
    if (persisted.length) {
      setPositions(prev => ({ ...prev, ...out.persist }));
      setDragging(prev => persisted.reduce(dropPosition, prev));
    }
    if (Object.keys(out.select).length) setSelectedNodes(prev => toggled(prev, out.select));
    if (Object.keys(out.measured).length) setMeasured(prev => ({ ...prev, ...out.measured }));
    if (out.remove.length) removeMany(out.remove);
  };
  const onNodeDragStop = (_: unknown, _node: AgentFlowNode, moved: AgentFlowNode[]) => {
    // The drop is what is kept: the same clamp as every other move, whatever the pointer reported.
    const ids = new Set(graph.nodes.map(n => n.id));
    const kept = Object.fromEntries(moved.filter(n => ids.has(n.id)).map(n => [n.id, clampPosition(n.position.x, n.position.y)]));
    if (!Object.keys(kept).length) return;
    setPositions(prev => ({ ...prev, ...kept }));
    setDragging(prev => Object.keys(kept).reduce(dropPosition, prev));
  };
  const onEdgesChange = (changes: EdgeChange<AgentFlowEdge>[]) => {
    const out = readEdgeChanges(graph, changes);
    if (Object.keys(out.select).length) setSelectedEdges(prev => toggled(prev, out.select));
    if (out.remove.size) disconnect(out.remove);
  };
  // React Flow listens for Delete / Backspace on the whole document. A node selected a minute ago must not vanish because
  // Backspace was pressed on a sidebar button: a delete is honoured only while focus is on the canvas itself.
  const onBeforeDelete = async () => !!flowArea.current && flowArea.current.contains(document.activeElement);
  const actions: AgentCanvasActions = {
    copy,
    onRename: (id, label) => setGraph(prev => ({ ...prev, nodes: prev.nodes.map(x => x.id === id ? { ...x, label } : x) })),
    onRemove: remove,
    onNudge: (id, index, dx, dy) => { const at = nodePosition(positions, id, index); moveNode(id, { x: at.x + dx, y: at.y + dy }); },
    onDisconnect: id => disconnect(new Set([id])),
    labelOf,
  };
  const ariaLabelConfig = useMemo(() => ({
    "node.a11yDescription.default": copy.a11yNode,
    "node.a11yDescription.keyboardDisabled": copy.a11yNode,
    "node.a11yDescription.ariaLiveMessage": ({ direction, x, y }: { direction: string; x: number; y: number }) =>
      fmt(copy.a11yMoved, { dir: Object.hasOwn(copy.dir, direction) ? copy.dir[direction as keyof AgentBuilderCopy["dir"]] : direction, x: Math.round(x), y: Math.round(y) }),
    "edge.a11yDescription.default": copy.a11yEdge,
    "controls.ariaLabel": copy.controls,
    "controls.zoomIn.ariaLabel": copy.zoomIn,
    "controls.zoomOut.ariaLabel": copy.zoomOut,
    "controls.fitView.ariaLabel": copy.fitView,
    "handle.ariaLabel": copy.handle,
  }), [copy]);
  const exportPlan = () => {
    if (empty) { setNotice(copy.emptyReason); return; }
    if (!report.ok) { setNotice("Fix graph validation errors before exporting."); return; }
    const content = exportWorkflowDraft(graph, positions);
    const file = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "nightshift-workflow-draft.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Draft plan downloaded. Nothing was executed or published.");
  };
  const saveCloudDraft = async () => {
    if (empty) { setNotice(copy.emptyReason); return; }
    if (!report.ok) { setNotice("Fix workflow validation before saving."); return; }
    setCloudBusy(true);
    try {
      const body = JSON.stringify({ id: savedId, expectedVersion: savedVersion, document: JSON.parse(exportWorkflowDraft(graph, positions)) });
      const res = await fetch("/api/agent-builder/drafts", { method:"POST", headers:{ "Content-Type":"application/json" }, credentials:"same-origin", body });
      const out: { id?:string;version?:number;error?:string } = await res.json();
      if (!res.ok || !out.id || !out.version) { setNotice("Cloud save unavailable: " + (out.error || String(res.status))); return; }
      setSavedId(out.id);
      setSavedVersion(out.version);
      setNotice("Private draft saved as version " + out.version + ". No workflow was executed.");
    } catch { setNotice("Cloud save failed. Your local draft is unchanged."); }
    finally { setCloudBusy(false); }
  };
  const listCloudDrafts = async () => {
    setCloudBusy(true);
    try {
      const res = await fetch("/api/agent-builder/drafts", { credentials:"same-origin", cache:"no-store" });
      const out: { drafts?: Array<{id:string;name:string;current_version:number}>; error?:string } = await res.json();
      if (!res.ok || !Array.isArray(out.drafts)) { setNotice("Saved drafts unavailable: " + (out.error || String(res.status))); return; }
      setRemoteDrafts(out.drafts);
      setChosenDraft(out.drafts[0]?.id || "");
      setNotice(out.drafts.length ? "Select a saved workflow to load." : "No saved drafts were found.");
    } catch { setNotice("Could not load draft list."); }
    finally { setCloudBusy(false); }
  };
  const loadCloudDraft = async () => {
    if (!chosenDraft) return;
    setCloudBusy(true);
    try {
      const res = await fetch("/api/agent-builder/drafts/" + encodeURIComponent(chosenDraft), { credentials:"same-origin", cache:"no-store" });
      const out: { draft?:{id:string;current_version:number}; revision?:{document:unknown}; error?:string } = await res.json();
      if (!res.ok || !out.draft || !out.revision) { setNotice("Load failed: " + (out.error || String(res.status))); return; }
      const imported = importWorkflowDraft(JSON.stringify(out.revision.document));
      setGraph(imported.workflow);
      setPositions(imported.positions);
      relayout();
      setSource(""); setTarget("");
      setSavedId(out.draft.id);
      setSavedVersion(out.draft.current_version);
      setNotice("Private cloud draft restored. This did not execute anything.");
    } catch { setNotice("Invalid or unavailable cloud draft."); }
    finally { setCloudBusy(false); }
  };
  const deleteCloudDraft = async () => {
    if (!chosenDraft) return;
    const chosen = remoteDrafts.find(d => d.id === chosenDraft);
    if (!window.confirm("Delete the private draft \u201c" + (chosen?.name ?? "") + "\u201d and all of its saved versions? This cannot be undone.")) return;
    setCloudBusy(true);
    try {
      const res = await fetch("/api/agent-builder/drafts/" + encodeURIComponent(chosenDraft), { method:"DELETE", credentials:"same-origin" });
      const out: { deleted?:string; error?:string } = await res.json();
      if (!res.ok || out.deleted !== chosenDraft) { setNotice("Delete failed: " + (out.error || String(res.status))); return; }
      const rest = remoteDrafts.filter(d => d.id !== chosenDraft);
      setRemoteDrafts(rest);
      setChosenDraft(rest[0]?.id || "");
      // The canvas keeps the plan; it is no longer tied to the deleted cloud draft, so the next save starts a new one.
      if (savedId === chosenDraft) { setSavedId(null); setSavedVersion(null); }
      setNotice("Private draft deleted with all of its versions. Your canvas is unchanged.");
    } catch { setNotice("Could not delete the draft."); }
    finally { setCloudBusy(false); }
  };
  const importPlan = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 150_000) { setNotice("File too large (150 KB maximum)."); return; }
    try {
      const draft = importWorkflowDraft(await file.text());
      setGraph(draft.workflow);
      setPositions(draft.positions);
      relayout();
      setSavedId(null);
      setSavedVersion(null);
      setSource("");
      setTarget("");
      setNotice("Validated workflow draft imported. No execution or server upload.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Invalid workflow draft");
    }
  };
  return <main className={styles.page}>
    <header className={styles.top}>
      <Link href="/" className={styles.brand}>N<span>IGHTSHIFT</span></Link>
      <div className={styles.topRight}><span>AGENT BUILDER / PREVIEW ONLY</span><Link href="/studio">Studio</Link></div>
    </header>
    <section className={styles.hero}>
      <div className={styles.eyebrow}>SYSTEMS / AUTOMATION / GRAPH 001</div>
      <h1>Build the workflow.<br/><em>Own the process.</em></h1>
      <p>Connect typed creative nodes. Validate your workflow before any model runs, credits are spent, or assets are exported.</p>
    </section>
    <div className={styles.workspace}>
      <aside className={styles.controls}>
        <div className={styles.sectionTitle}>00 / Agent Planner (offline preview)</div>
        <label>Creative request<textarea className={styles.planInput} maxLength={500} rows={3} placeholder="Create a brand ad image using my approved product details" value={requestText} onChange={e => setRequestText(e.target.value)}/></label>
        <label>Output type<select value={planType} onChange={e => setPlanType(e.target.value as CreativeIntent)}><option value="image">Image</option><option value="video">Video</option><option value="vector">Vector / SVG</option></select></label>
        <button type="button" onClick={generatePlan} disabled={!requestText.trim()}>Build safe workflow draft</button>
        <p className={styles.disclaimer}>Rule-based planner, not an LLM. It generates an editable template and does not execute the request or choose an API provider.</p>
        <div className={styles.sectionTitle}>00B / Direct model provider review</div>
        <label>Original API source<select value={provider} onChange={e => setProvider(e.target.value as DirectProvider)}>
          <option value="ideogram">Ideogram — Vector / SVG</option>
          <option value="byteplus">BytePlus ModelArk — Seedance video</option>
        </select></label>
        {"error" in providerPreview ? <p className={styles.disclaimer}>Provider selection invalid.</p> : <div className={styles.providerPreview}>
          <strong>{providerPreview.capability.toUpperCase()} · INTEGRATION PLANNED</strong>
          <p>Price: not quoted. Real provider access: disabled.</p>
          <ul>{providerPreview.blockers.slice(0,3).map(b => <li key={b}>{b}</li>)}</ul>
        </div>}
        <p className={styles.disclaimer}>No paid model requests are possible from this screen.</p>
        <div className={styles.sectionTitle}>01 / Workflow</div>
        <label>Workflow name<input maxLength={120} value={graph.name} onChange={e => setGraph(prev => ({...prev, name:e.target.value}))}/></label>
        <div className={styles.sectionTitle}>{copy.addSection}</div>
        <label>Node type<select value={newType} onChange={e => setNewType(e.target.value as NodeType)}>{NODE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <button type="button" onClick={add}>+ Add node</button>
        <div className={styles.sectionTitle}>03 / Connect nodes</div>
        <label>{copy.from}<select value={source} onChange={e => setSource(e.target.value)}><option value="">Choose source</option>{graph.nodes.map(n => <option key={n.id} value={n.id}>{n.label} [{n.id}]</option>)}</select></label>
        <label>{copy.to}<select value={target} onChange={e => setTarget(e.target.value)}><option value="">Choose target</option>{graph.nodes.map(n => <option key={n.id} value={n.id}>{n.label} [{n.id}]</option>)}</select></label>
        <button type="button" onClick={addConnection}>Connect selected nodes</button>
        <div className={styles.sectionTitle}>04 / Plan</div>
        <button type="button" className={styles.secondary} onClick={() => {setGraph(createCampaignWorkflow());setPositions({});relayout();setSavedId(null);setSavedVersion(null);setNotice("Example restored.");}}>{copy.restoreExample}</button>
        <button type="button" className={styles.download} disabled={!exportable} onClick={exportPlan}>Download validated draft ↓</button>
        <button type="button" className={styles.secondary} onClick={() => importInput.current?.click()}>Import workflow draft ↑</button>
        <input ref={importInput} type="file" accept=".json,application/json" onChange={importPlan} className={styles.hiddenInput} tabIndex={-1} aria-label="Import Nightshift workflow JSON draft"/>
        <div className={styles.sectionTitle}>05 / Private drafts (optional)</div>
        <p className={styles.disclaimer}>Cloud storage requires a signed-in account and the server feature flag. It is disabled by default.</p>
        <button type="button" disabled={cloudBusy || !exportable} onClick={saveCloudDraft}>Save private draft to cloud</button>
        <button type="button" className={styles.secondary} disabled={cloudBusy} onClick={listCloudDrafts}>List my cloud drafts</button>
        {remoteDrafts.length > 0 && <>
          <label>Saved workflow<select value={chosenDraft} onChange={e => setChosenDraft(e.target.value)}>{remoteDrafts.map(d => <option key={d.id} value={d.id}>{d.name} (v{d.current_version})</option>)}</select></label>
          <button type="button" className={styles.secondary} disabled={cloudBusy || !chosenDraft} onClick={loadCloudDraft}>Load selected private draft</button>
          <button type="button" className={styles.secondary} disabled={cloudBusy || !chosenDraft} onClick={deleteCloudDraft}>Delete selected private draft</button>
        </>}
        <p className={styles.disclaimer}>No model APIs, credentials, billing, background jobs, or automated publishing are connected.</p>
        {/* The same words as the canvas's status line, which is the one live region: announced once, not twice. */}
        <p className={styles.notice}>{notice}</p>
      </aside>
      <section className={styles.canvas} aria-label="Workflow node graph">
        <div className={styles.canvasHeader}>
          <div><div className={styles.eyebrow}>COMPOSITION</div><h2>{graph.name || "Untitled workflow"}</h2></div>
          <span className={exportable ? styles.passed : styles.failed} title={empty ? copy.emptyReason : undefined}>{exportable ? "VALID GRAPH" : "NEEDS REVIEW"}</span>
        </div>
        <div className={styles.legend}>NODES {graph.nodes.length} <span>CONNECTIONS {graph.edges.length}</span> <span>EXECUTION DISABLED</span></div>
        <p className={styles.disclaimer}>{copy.canvasHint}</p>
        <AgentCanvasContext.Provider value={actions}>
          {/* tabIndex -1: where focus goes when the last card is removed (M7), never a Tab stop of its own. */}
          <div className={styles.flow} ref={flowArea} role="region" aria-label={copy.canvasLabel} tabIndex={-1}>
            <ReactFlow<AgentFlowNode, AgentFlowEdge>
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={FLOW_NODE_TYPES}
              edgeTypes={FLOW_EDGE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeDragStop={onNodeDragStop}
              isValidConnection={isValidConnection}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              onClickConnectEnd={onConnectEnd}
              onBeforeDelete={onBeforeDelete}
              nodeExtent={WORLD}
              translateExtent={PAN_LIMIT}
              minZoom={0.2}
              maxZoom={1.5}
              nodesFocusable
              edgesFocusable
              deleteKeyCode={DELETE_KEYS}
              // The wheel scrolls the page, as it does everywhere else on it; Ctrl / ⌘ + wheel, a pinch or the buttons zoom.
              zoomOnScroll={false}
              preventScrolling={false}
              zoomActivationKeyCode={ZOOM_KEYS}
              multiSelectionKeyCode={null}
              selectionKeyCode={null}
              ariaLabelConfig={ariaLabelConfig}
              proOptions={PRO_OPTIONS}
              className={styles.flowBoard}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#4b5055" />
              <Controls showInteractive={false} fitViewOptions={fitOptions} className={styles.flowControls} />
              <Panel position="top-center" className={styles.flowStatus}>
                <p role="status" aria-live="polite" className={notice ? undefined : styles.flowStatusIdle}>{notice}</p>
              </Panel>
              {empty && <Panel position="top-left" className={styles.flowEmpty}><p>{copy.empty}</p></Panel>}
            </ReactFlow>
          </div>
        </AgentCanvasContext.Provider>
        <div className={styles.sectionTitle}>CONNECTION MAP</div>
        <div className={styles.edges}>{graph.edges.map(e => <div className={styles.edge} key={e.source+"->"+e.target}>
          <span>{nodeMap.get(e.source)?.label || e.source}</span><strong>→</strong><span>{nodeMap.get(e.target)?.label || e.target}</span>
          <button type="button" onClick={() => disconnect(new Set([edgeId(e.source, e.target)]))} aria-label={fmt(copy.disconnectList, { from: labelOf(e.source), to: labelOf(e.target) })}>×</button>
        </div>)}</div>
        <div className={styles.validation}><strong>GRAPH VALIDATION</strong>
          {empty ? <p>{copy.emptyReason}</p> : report.ok ? <p>✓ Schema, edges, cycles and structural review prerequisites passed. This is not human approval.</p> :
            <ul>{report.errors.slice(0,8).map((err,i) => <li key={i}>{err}</li>)}</ul>}
        </div>
      </section>
    </div>
  </main>;
}
