"use client";

import { useMemo, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { createCampaignWorkflow, inspectWorkflow, NODE_TYPES, type AgentWorkflow, type NodeType } from "@/lib/agent-graph";
import { addNode, checkConnection, removeNode, PORTS, clampPosition, type NodePosition } from "@/lib/agent-graph-editor";
import { canvasEdges, defaultNodePosition, exportWorkflowDraft, importWorkflowDraft } from "@/lib/agent-draft";
import styles from "./agent-builder.module.css";

export function AgentBuilder() {
  const [graph, setGraph] = useState<AgentWorkflow>(createCampaignWorkflow);
  const [source, setSource] = useState("brand");
  const [target, setTarget] = useState("prompt");
  const [newType, setNewType] = useState<NodeType>("video.generate");
  const [notice, setNotice] = useState("");
  const [positions, setPositions] = useState<Record<string, NodePosition>>({});
  const importInput = useRef<HTMLInputElement>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [remoteDrafts, setRemoteDrafts] = useState<Array<{id:string;name:string;current_version:number}>>([]);
  const [chosenDraft, setChosenDraft] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const defaultPosition = defaultNodePosition;
  const moveNode = (id: string, position: NodePosition) => setPositions(prev => ({ ...prev, [id]: clampPosition(position.x, position.y) }));
  const report = useMemo(() => inspectWorkflow(graph), [graph]);
  const nodeMap = useMemo(() => new Map(graph.nodes.map(n => [n.id, n])), [graph]);
  const paths = useMemo(() => canvasEdges(graph, positions), [graph, positions]);
  const addConnection = () => {
    const outcome = checkConnection(graph, source, target);
    if (!outcome.ok) { setNotice(outcome.reason); return; }
    setGraph(prev => ({ ...prev, edges: [...prev.edges, { source, target }] }));
    setNotice("Connection added.");
  };
  const remove = (id: string) => {
    setGraph(prev => removeNode(prev, id));
    setPositions(prev => { const next = { ...prev }; delete next[id]; return next; });
    if (source === id) setSource("");
    if (target === id) setTarget("");
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
      setSource(""); setTarget("");
      setSavedId(out.draft.id);
      setSavedVersion(out.draft.current_version);
      setNotice("Private cloud draft restored. This did not execute anything.");
    } catch { setNotice("Invalid or unavailable cloud draft."); }
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
        <button type="button" className={styles.secondary} onClick={() => {setGraph(createCampaignWorkflow());setPositions({});setSavedId(null);setSavedVersion(null);setNotice("Example restored.");}}>Restore example</button>
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
        <p className={styles.disclaimer}>Drag node cards to reposition them. On touch or keyboard, use arrow buttons. Connections remain accessible in the list below.</p>
        <div className={styles.nodeGrid} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"); if (!graph.nodes.some(n => n.id === id)) return; const rect = e.currentTarget.getBoundingClientRect(); moveNode(id, clampPosition(e.clientX - rect.left + e.currentTarget.scrollLeft - 100, e.clientY - rect.top + e.currentTarget.scrollTop - 35)); }}>
          <svg className={styles.canvasLines} viewBox="0 0 2470 1850" aria-label="Workflow connection lines" role="img" preserveAspectRatio="xMinYMin meet">{paths.map(edge => <path key={edge.source+"->"+edge.target} d={edge.path} fill="none" stroke="#d7ac78" strokeWidth="3" strokeOpacity=".75" markerEnd="url(#arrow)"/>)}<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6" fill="none" stroke="#d7ac78" strokeWidth="1.4"/></marker></defs></svg>
          {graph.nodes.map((n, index) => <article key={n.id} className={styles.node} draggable onDragStart={e => e.dataTransfer.setData("text/plain", n.id)} style={{ position: "absolute", left: (positions[n.id] || defaultPosition(index)).x, top: (positions[n.id] || defaultPosition(index)).y, width: 220 }}>
            <div className={styles.nodeTop}><span>NODE {String(index+1).padStart(2,"0")}</span><button type="button" onClick={() => remove(n.id)} aria-label={`Remove ${n.label}`}>Remove</button></div>
            <div className={styles.nodeType}>{n.type}</div>
            <input aria-label={`Rename ${n.id}`} maxLength={80} value={n.label} onChange={e => setGraph(prev => ({...prev,nodes:prev.nodes.map(x => x.id === n.id ? {...x,label:e.target.value}:x)}))}/>
            <div className={styles.nodeId}>{n.id}</div>
            <div className={styles.nodePorts}>IN: {PORTS[n.type].input.join(", ") || "—"} · OUT: {PORTS[n.type].output.join(", ") || "—"}</div>
            <div className={styles.nudge}>
              {([["←",-20,0],["↑",0,-20],["↓",0,20],["→",20,0]] as const).map(([symbol, dx, dy]) => <button type="button" key={symbol} aria-label={"Move "+n.label+" "+symbol} onClick={() => { const at = positions[n.id] || defaultPosition(index); moveNode(n.id,{x:at.x+dx,y:at.y+dy}); }}>{symbol}</button>)}
            </div>
          </article>)}
        </div>
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
