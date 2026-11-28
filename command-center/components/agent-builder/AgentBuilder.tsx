"use client";

import { useCallback, useMemo, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { fmt } from "@/lib/i18n/core";
import { createCampaignWorkflow, inspectWorkflow, NODE_TYPES, type AgentWorkflow, type NodeType } from "@/lib/agent-graph";
import { addNode, checkConnection, removeNode, clampPosition, type NodePosition } from "@/lib/agent-graph-editor";
import { exportWorkflowDraft, importWorkflowDraft } from "@/lib/agent-draft";
import {
  applyConnect,
  dropPosition,
  nodePosition,
  readEdgeChanges,
  readNodeChanges,
  removeEdges,
  toFlowEdges,
  toFlowNodes,
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
const FIT = { padding: 0.12, maxZoom: 1 };

/** Turn a set of ids on or off; the same object back when nothing changed, so React keeps its render. */
function toggled(prev: ReadonlySet<string>, changes: Record<string, boolean>): ReadonlySet<string> {
  const next = new Set(prev);
  for (const [id, on] of Object.entries(changes)) if (on) next.add(id); else next.delete(id);
  return next.size === prev.size && [...next].every(id => prev.has(id)) ? prev : next;
}

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
  // A new draft (import, cloud load, planner, example) remounts the flow so fitView frames it, not the last one's view.
  const [layoutKey, setLayoutKey] = useState(0);
  const relayout = () => { setDragging({}); setSelectedNodes(new Set()); setSelectedEdges(new Set()); setMeasured({}); setLayoutKey(k => k + 1); };
  const flowArea = useRef<HTMLDivElement>(null);
  const moveNode = (id: string, position: NodePosition) => setPositions(prev => ({ ...prev, [id]: clampPosition(position.x, position.y) }));
  const report = useMemo(() => inspectWorkflow(graph), [graph]);
  const nodeMap = useMemo(() => new Map(graph.nodes.map(n => [n.id, n])), [graph]);
  const flowNodes = useMemo(() => toFlowNodes(graph, positions, { dragging, selected: selectedNodes, measured }), [graph, positions, dragging, selectedNodes, measured]);
  const flowEdges = useMemo(() => toFlowEdges(graph, selectedEdges), [graph, selectedEdges]);
  const providerPreview = providerPreviews[provider];
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
    if (!outcome.ok) { setNotice(outcome.reason); return; }
    setGraph(prev => ({ ...prev, edges: [...prev.edges, { source, target }] }));
    setNotice("Connection added.");
  };
  const remove = (id: string) => {
    setGraph(prev => removeNode(prev, id));
    setPositions(prev => dropPosition(prev, id));
    setDragging(prev => dropPosition(prev, id));
    if (source === id) setSource("");
    if (target === id) setTarget("");
  };
  const disconnect = (ids: ReadonlySet<string>) => {
    setGraph(prev => removeEdges(prev, ids));
    setSelectedEdges(prev => toggled(prev, Object.fromEntries([...ids].map(id => [id, false]))));
  };
  // The drag only colours the target; checkConnection decides by the two nodes' types, never by a handle id.
  const isValidConnection = useCallback((conn: Connection | Edge) => checkConnection(graph, conn.source, conn.target).ok, [graph]);
  const onConnect = (conn: Connection) => {
    // Checked again on the drop (lib/agent-flow applyConnect): isValidConnection is advice to the pointer, not a gate.
    const outcome = applyConnect(graph, conn.source, conn.target);
    if (!outcome.ok) { setNotice(outcome.reason); return; }
    setGraph(prev => applyConnect(prev, conn.source, conn.target).graph);
    setNotice("Connection added.");
  };
  // A drop React Flow refused never reaches onConnect: say why here, from the same check, so a pointer gets the reason too.
  const onConnectEnd = (_: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid !== false || !state.fromNode || !state.toNode) return;
    const [from, to] = state.fromHandle?.type === "target" ? [state.toNode.id, state.fromNode.id] : [state.fromNode.id, state.toNode.id];
    // An allowed pair refused anyway was dropped output-on-output or input-on-input: nothing to explain by type.
    const outcome = checkConnection(graph, from, to);
    if (!outcome.ok) setNotice(outcome.reason);
  };
  const onNodesChange = (changes: NodeChange<AgentFlowNode>[]) => {
    const out = readNodeChanges(graph, changes);
    const persisted = Object.keys(out.persist);
    if (Object.keys(out.dragging).length) setDragging(prev => ({ ...prev, ...out.dragging }));
    if (persisted.length) {
      setPositions(prev => ({ ...prev, ...out.persist }));
      setDragging(prev => persisted.reduce(dropPosition, prev));
    }
    for (const id of out.remove) remove(id);
    if (Object.keys(out.select).length) setSelectedNodes(prev => toggled(prev, out.select));
    if (Object.keys(out.measured).length) setMeasured(prev => ({ ...prev, ...out.measured }));
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
    if (out.remove.size) disconnect(out.remove);
    if (Object.keys(out.select).length) setSelectedEdges(prev => toggled(prev, out.select));
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
  };
  const ariaLabelConfig = {
    "node.a11yDescription.default": copy.a11yNode,
    "node.a11yDescription.keyboardDisabled": copy.a11yNode,
    "node.a11yDescription.ariaLiveMessage": ({ direction, x, y }: { direction: string; x: number; y: number }) =>
      fmt(copy.a11yMoved, { dir: direction in copy.dir ? copy.dir[direction as keyof AgentBuilderCopy["dir"]] : direction, x: Math.round(x), y: Math.round(y) }),
    "edge.a11yDescription.default": copy.a11yEdge,
    "controls.ariaLabel": copy.controls,
    "controls.zoomIn.ariaLabel": copy.zoomIn,
    "controls.zoomOut.ariaLabel": copy.zoomOut,
    "controls.fitView.ariaLabel": copy.fitView,
    "handle.ariaLabel": copy.handle,
  };
  const exportPlan = () => {
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
        <div className={styles.sectionTitle}>02 / Add a node</div>
        <label>Node type<select value={newType} onChange={e => setNewType(e.target.value as NodeType)}>{NODE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <button type="button" onClick={() => {setGraph(prev => addNode(prev,newType));setNotice("Node added to workspace.");}}>+ Add node</button>
        <div className={styles.sectionTitle}>03 / Connect nodes</div>
        <label>From<select value={source} onChange={e => setSource(e.target.value)}><option value="">Choose source</option>{graph.nodes.map(n => <option key={n.id} value={n.id}>{n.label} [{n.id}]</option>)}</select></label>
        <label>To<select value={target} onChange={e => setTarget(e.target.value)}><option value="">Choose target</option>{graph.nodes.map(n => <option key={n.id} value={n.id}>{n.label} [{n.id}]</option>)}</select></label>
        <button type="button" onClick={addConnection}>Connect selected nodes</button>
        <div className={styles.sectionTitle}>04 / Plan</div>
        <button type="button" className={styles.secondary} onClick={() => {setGraph(createCampaignWorkflow());setPositions({});relayout();setSavedId(null);setSavedVersion(null);setNotice("Example restored.");}}>Restore example</button>
        <button type="button" className={styles.download} disabled={!report.ok} onClick={exportPlan}>Download validated draft ↓</button>
        <button type="button" className={styles.secondary} onClick={() => importInput.current?.click()}>Import workflow draft ↑</button>
        <input ref={importInput} type="file" accept=".json,application/json" onChange={importPlan} className={styles.hiddenInput} aria-label="Import Nightshift workflow JSON draft"/>
        <div className={styles.sectionTitle}>05 / Private drafts (optional)</div>
        <p className={styles.disclaimer}>Cloud storage requires a signed-in account and the server feature flag. It is disabled by default.</p>
        <button type="button" disabled={cloudBusy || !report.ok} onClick={saveCloudDraft}>Save private draft to cloud</button>
        <button type="button" className={styles.secondary} disabled={cloudBusy} onClick={listCloudDrafts}>List my cloud drafts</button>
        {remoteDrafts.length > 0 && <>
          <label>Saved workflow<select value={chosenDraft} onChange={e => setChosenDraft(e.target.value)}>{remoteDrafts.map(d => <option key={d.id} value={d.id}>{d.name} (v{d.current_version})</option>)}</select></label>
          <button type="button" className={styles.secondary} disabled={cloudBusy || !chosenDraft} onClick={loadCloudDraft}>Load selected private draft</button>
          <button type="button" className={styles.secondary} disabled={cloudBusy || !chosenDraft} onClick={deleteCloudDraft}>Delete selected private draft</button>
        </>}
        <p className={styles.disclaimer}>No model APIs, credentials, billing, background jobs, or automated publishing are connected.</p>
        <p role="status" className={styles.notice}>{notice}</p>
      </aside>
      <section className={styles.canvas} aria-label="Workflow node graph">
        <div className={styles.canvasHeader}>
          <div><div className={styles.eyebrow}>COMPOSITION</div><h2>{graph.name || "Untitled workflow"}</h2></div>
          <span className={report.ok ? styles.passed : styles.failed}>{report.ok ? "VALID GRAPH" : "NEEDS REVIEW"}</span>
        </div>
        <div className={styles.legend}>NODES {graph.nodes.length} <span>CONNECTIONS {graph.edges.length}</span> <span>EXECUTION DISABLED</span></div>
        <p className={styles.disclaimer}>{copy.canvasHint}</p>
        <AgentCanvasContext.Provider value={actions}>
          <div className={styles.flow} ref={flowArea} role="region" aria-label={copy.canvasLabel}>
            <ReactFlow<AgentFlowNode, AgentFlowEdge>
              key={layoutKey}
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
              onBeforeDelete={onBeforeDelete}
              nodeExtent={WORLD}
              translateExtent={[[-400, -400], [2870, 2250]]}
              fitView
              fitViewOptions={FIT}
              minZoom={0.2}
              maxZoom={1.5}
              nodesFocusable
              edgesFocusable
              deleteKeyCode={["Delete", "Backspace"]}
              multiSelectionKeyCode={null}
              selectionKeyCode={null}
              ariaLabelConfig={ariaLabelConfig}
              proOptions={{ hideAttribution: true }}
              className={styles.flowBoard}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#4b5055" />
              <Controls showInteractive={false} fitViewOptions={FIT} className={styles.flowControls} />
            </ReactFlow>
          </div>
        </AgentCanvasContext.Provider>
        <div className={styles.sectionTitle}>CONNECTION MAP</div>
        <div className={styles.edges}>{graph.edges.map(e => <div className={styles.edge} key={e.source+"->"+e.target}>
          <span>{nodeMap.get(e.source)?.label || e.source}</span><strong>→</strong><span>{nodeMap.get(e.target)?.label || e.target}</span>
          <button type="button" onClick={() => setGraph(prev => ({...prev,edges:prev.edges.filter(x => !(x.source === e.source && x.target === e.target))}))} aria-label={`Disconnect ${e.source} from ${e.target}`}>×</button>
        </div>)}</div>
        <div className={styles.validation}><strong>GRAPH VALIDATION</strong>
          {report.ok ? <p>✓ Schema, edges, cycles and structural review prerequisites passed. This is not human approval.</p> :
            <ul>{report.errors.slice(0,8).map((err,i) => <li key={i}>{err}</li>)}</ul>}
        </div>
      </section>
    </div>
  </main>;
}
