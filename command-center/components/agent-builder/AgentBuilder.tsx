"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { createCampaignWorkflow, inspectWorkflow, NODE_TYPES, type AgentWorkflow, type NodeType } from "@/lib/agent-graph";
import { addNode, checkConnection, removeNode } from "@/lib/agent-graph-editor";
import styles from "./agent-builder.module.css";

export function AgentBuilder() {
  const [graph, setGraph] = useState<AgentWorkflow>(createCampaignWorkflow);
  const [source, setSource] = useState("brand");
  const [target, setTarget] = useState("prompt");
  const [newType, setNewType] = useState<NodeType>("video.generate");
  const [notice, setNotice] = useState("");
  const report = useMemo(() => inspectWorkflow(graph), [graph]);
  const nodeMap = useMemo(() => new Map(graph.nodes.map(n => [n.id, n])), [graph]);
  const addConnection = () => {
    const outcome = checkConnection(graph, source, target);
    if (!outcome.ok) { setNotice(outcome.reason); return; }
    setGraph(prev => ({ ...prev, edges: [...prev.edges, { source, target }] }));
    setNotice("Connection added.");
  };
  const remove = (id: string) => {
    setGraph(prev => removeNode(prev, id));
    if (source === id) setSource("");
    if (target === id) setTarget("");
  };
  const exportPlan = () => {
    if (!report.ok) { setNotice("Fix graph validation errors before exporting."); return; }
    const content = JSON.stringify(graph, null, 2);
    const file = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "nightshift-workflow-draft.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("Draft plan downloaded. Nothing was executed or published.");
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
        <button type="button" className={styles.secondary} onClick={() => {setGraph(createCampaignWorkflow());setNotice("Example restored.");}}>Restore example</button>
        <button type="button" className={styles.download} disabled={!report.ok} onClick={exportPlan}>Download validated draft ↓</button>
        <p className={styles.disclaimer}>No model APIs, credentials, billing, background jobs, automated publishing, or server storage are connected.</p>
        <p role="status" className={styles.notice}>{notice}</p>
      </aside>
      <section className={styles.canvas} aria-label="Workflow node graph">
        <div className={styles.canvasHeader}>
          <div><div className={styles.eyebrow}>COMPOSITION</div><h2>{graph.name || "Untitled workflow"}</h2></div>
          <span className={report.ok ? styles.passed : styles.failed}>{report.ok ? "VALID GRAPH" : "NEEDS REVIEW"}</span>
        </div>
        <div className={styles.legend}>NODES {graph.nodes.length} <span>CONNECTIONS {graph.edges.length}</span> <span>EXECUTION DISABLED</span></div>
        <div className={styles.nodeGrid}>
          {graph.nodes.map((n, index) => <article key={n.id} className={styles.node}>
            <div className={styles.nodeTop}><span>NODE {String(index+1).padStart(2,"0")}</span><button type="button" onClick={() => remove(n.id)} aria-label={`Remove ${n.label}`}>Remove</button></div>
            <div className={styles.nodeType}>{n.type}</div>
            <input aria-label={`Rename ${n.id}`} maxLength={80} value={n.label} onChange={e => setGraph(prev => ({...prev,nodes:prev.nodes.map(x => x.id === n.id ? {...x,label:e.target.value}:x)}))}/>
            <div className={styles.nodeId}>{n.id}</div>
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
