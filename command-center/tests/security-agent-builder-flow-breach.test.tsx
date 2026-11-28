// @vitest-environment jsdom
/**
 * Breach, against the Agent Builder's React Flow canvas (commit bbb59c398: AgentBuilder.tsx, AgentNode.tsx, lib/agent-flow.ts).
 *
 * The attacker here holds a crafted draft file (a teammate's "workflow.json", or a cloud draft written straight through the RPC)
 * and a browser's devtools, so React Flow's callbacks can be fed anything a forged event could carry. What would break:
 *   - markup in a label or an id reaching the DOM as elements, or a label rewriting another control's accessible name;
 *   - a node drawn at NaN / Infinity / off the canvas, including through a node id that is also an Object.prototype name;
 *   - an edge checkConnection refuses, or a handle id choosing the port a wire lands on;
 *   - more than 64 nodes or 128 edges through the canvas;
 *   - a state inspectWorkflow calls ok that migration 0130's save_agent_workflow_draft would refuse (or the reverse);
 *   - React Flow's add / replace / remove changes, a forged Connection or onBeforeDelete making an export with no review;
 *   - any canvas gesture reaching fetch (CLAUDE.md rule 3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import type { Connection, EdgeChange, NodeChange, ReactFlowProps } from "@xyflow/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

type FlowProps = ReactFlowProps<AgentFlowNode, AgentFlowEdge>;
const flow = vi.hoisted(() => ({ props: null as unknown }));
vi.mock("@xyflow/react", async importOriginal => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    ReactFlow: (p: FlowProps) => {
      flow.props = p;
      return createElement(actual.ReactFlow as unknown as (q: FlowProps) => ReactNode, p);
    },
  };
});

import { dictionaries } from "@/lib/i18n";
import { createCampaignWorkflow, inspectWorkflow, NODE_TYPES, type AgentWorkflow, type NodeType } from "@/lib/agent-graph";
import { CONNECTIONS, addNode, clampPosition, type NodePosition } from "@/lib/agent-graph-editor";
import { defaultNodePosition, exportWorkflowDraft, importWorkflowDraft } from "@/lib/agent-draft";
import {
  applyConnect,
  readEdgeChanges,
  readNodeChanges,
  removeEdges,
  removeNodeAndPosition,
  toFlowEdges,
  toFlowNodes,
  type AgentFlowEdge,
  type AgentFlowNode,
} from "@/lib/agent-flow";
import { AgentBuilder, type ProviderPreviews } from "@/components/agent-builder/AgentBuilder";

const copy = dictionaries.en.agentBuilder;
const previews = { ideogram: { error: "x" }, byteplus: { error: "x" } } as ProviderPreviews;
const props = () => flow.props as FlowProps;
const edgeIds = () => (props().edges ?? []).map(e => e.id);
const status = () => screen.getByRole("status").textContent;

class FakeResizeObserver {
  constructor(private cb: (entries: { target: Element }[], o: unknown) => void) {}
  observe(target: Element) { this.cb([{ target }], this); }
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class { m22 = 1; };
Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { configurable: true, get() { return parseFloat((this as HTMLElement).style.height) || 1; } },
  offsetWidth: { configurable: true, get() { return parseFloat((this as HTMLElement).style.width) || 1; } },
});
(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
if (!Blob.prototype.text) {
  Blob.prototype.text = function (this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error("no network on the canvas")));
  vi.stubGlobal("fetch", fetchSpy);
  flow.props = null;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => render(<AgentBuilder providerPreviews={previews} copy={copy} />);
const connect = (source: string | null, target: string | null, handles: Partial<Connection> = {}) =>
  act(() => props().onConnect!({ source, target, sourceHandle: null, targetHandle: null, ...handles } as Connection));
const nodesChange = (changes: NodeChange<AgentFlowNode>[]) => act(() => props().onNodesChange!(changes));
const edgesChange = (changes: EdgeChange<AgentFlowEdge>[]) => act(() => props().onEdgesChange!(changes));
const draftOf = (workflow: AgentWorkflow, positions: Record<string, unknown> = {}) =>
  ({ format: "nightshift.agent-draft", layoutVersion: 1, workflow, positions });
async function importFile(text: string) {
  const input = screen.getByLabelText("Import Nightshift workflow JSON draft") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([text], "x.json", { type: "application/json" })] } });
  await waitFor(() => expect(status()).not.toBe(""));
}
const finite = (p: unknown) => {
  const q = p as { x?: unknown; y?: unknown } | undefined;
  return !!q && typeof q === "object" && Number.isFinite(q.x) && Number.isFinite(q.y);
};

/** The campaign example with the brand node renamed to `id`, a valid draft both inspectWorkflow and 0130 accept. */
function campaignWithBrandId(id: string): AgentWorkflow {
  const wf = createCampaignWorkflow();
  return {
    ...wf,
    nodes: wf.nodes.map(n => (n.id === "brand" ? { ...n, id } : n)),
    edges: wf.edges.map(e => (e.source === "brand" ? { ...e, source: id } : e)),
  };
}

/**
 * Migration 0130's save_agent_workflow_draft document rules, re-stated in JS (structure, ids, kinds, export-has-an-incoming-edge,
 * positions as plain-digit integers in range). Character classes are left to the shared regex: what is checked here is the graph
 * shape, which is where a canvas gesture could make the two disagree.
 */
const DB_KINDS: Array<[NodeType[], NodeType[]]> = [
  [["brand.input", "product.catalog"], ["prompt.compose"]],
  [["prompt.compose"], ["image.generate", "vector.generate", "video.generate"]],
  [["image.generate", "vector.generate", "video.generate"], ["review.approval"]],
  [["review.approval"], ["asset.export"]],
];
function dbAccepts(doc: unknown): boolean {
  const d = doc as { workflow: AgentWorkflow; positions: Record<string, unknown> } & Record<string, unknown>;
  if (JSON.stringify(doc).length > 150_000) return false;
  if (Object.keys(d).sort().join() !== "format,layoutVersion,positions,workflow") return false;
  const wf = d.workflow as unknown as Record<string, unknown>;
  if (Object.keys(wf).sort().join() !== "edges,name,nodes,version") return false;
  const nodes = d.workflow.nodes, edges = d.workflow.edges;
  if (nodes.length > 64 || edges.length > 128) return false;
  const types = new Map<string, NodeType>();
  for (const n of nodes) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(n.id) || types.has(n.id) || !NODE_TYPES.includes(n.type)) return false;
    const len = Array.from(n.label).length;
    if (len < 1 || len > 80) return false;
    if (n.config !== undefined && JSON.stringify(n.config) !== "{}") return false;
    types.set(n.id, n.type);
  }
  const seen = new Set<string>(), targets = new Set<string>();
  for (const e of edges) {
    const a = types.get(e.source), b = types.get(e.target);
    if (!a || !b || seen.has(e.source + ">" + e.target)) return false;
    if (!DB_KINDS.some(([from, to]) => from.includes(a) && to.includes(b))) return false;
    seen.add(e.source + ">" + e.target);
    targets.add(e.target);
  }
  for (const [id, t] of types) if (t === "asset.export" && !targets.has(id)) return false;
  for (const [key, xy] of Object.entries(d.positions)) {
    if (!types.has(key)) return false;
    const p = xy as Record<string, unknown>;
    if (Object.keys(p).sort().join() !== "x,y") return false;
    for (const k of ["x", "y"] as const) if (typeof p[k] !== "number" || !/^[0-9]{1,4}$/.test(JSON.stringify(p[k]))) return false;
    if ((p.x as number) > 2200 || (p.y as number) > 1600) return false;
  }
  return true;
}

describe("Breach: crafted draft content on the React Flow canvas", () => {
  it("markup in a label renders as text: no element is created, and aria-labels carry the literal string", async () => {
    mount();
    const evil = `<img src=x onerror="window.__pwn=1">"'><svg onload=alert(1)>`.slice(0, 80);
    const wf = createCampaignWorkflow();
    wf.nodes[0] = { ...wf.nodes[0], label: evil };
    await importFile(JSON.stringify(draftOf(wf)));
    expect(status()).toBe("Validated workflow draft imported. No execution or server upload.");
    const canvas = screen.getByRole("region", { name: copy.canvasLabel });
    expect(canvas.querySelector("img, svg[onload], [onerror]")).toBeNull();
    expect((window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
    expect(screen.getByLabelText("Rename brand")).toHaveProperty("value", evil);
    expect(screen.getByRole("button", { name: `Remove ${evil}` })).toBeTruthy();
  });

  it("a label holding a {placeholder} does not rewrite the other words of an aria-label (fmt is single pass)", async () => {
    mount();
    const wf = createCampaignWorkflow();
    wf.nodes[0] = { ...wf.nodes[0], label: "{dir} {label} {id} {constructor}" };
    await importFile(JSON.stringify(draftOf(wf)));
    expect(screen.getByRole("button", { name: "Move {dir} {label} {id} {constructor} left" })).toBeTruthy();
  });

  it("ids and types that are not the registry's are refused before React Flow sees them", () => {
    const base = createCampaignWorkflow();
    const bad: unknown[] = [
      { ...base, nodes: [{ ...base.nodes[0], id: `x"]<script>` }, ...base.nodes.slice(1)] },
      { ...base, nodes: [{ ...base.nodes[0], type: "code.exec" }, ...base.nodes.slice(1)] },
      { ...base, nodes: [{ ...base.nodes[0], id: "__proto__" }, ...base.nodes.slice(1)] },
      { ...base, nodes: [{ ...base.nodes[0], config: { endpoint: "http://169.254.169.254/" } }, ...base.nodes.slice(1)] },
    ];
    for (const wf of bad) expect(() => importWorkflowDraft(JSON.stringify(draftOf(wf as AgentWorkflow)))).toThrow();
  });

  it("NaN, Infinity (1e400), fractions out of range and a __proto__ layout key never become a position", () => {
    const wf = createCampaignWorkflow();
    const text = (positions: string) => `{"format":"nightshift.agent-draft","layoutVersion":1,"workflow":${JSON.stringify(wf)},"positions":${positions}}`;
    expect(() => importWorkflowDraft(text(`{"brand":{"x":1e400,"y":0}}`))).toThrow();
    expect(() => importWorkflowDraft(text(`{"brand":{"x":-1e400,"y":0}}`))).toThrow();
    expect(() => importWorkflowDraft(text(`{"brand":{"x":2200.5,"y":0}}`))).toThrow();
    expect(() => importWorkflowDraft(text(`{"brand":{"x":"5","y":0}}`))).toThrow();
    expect(() => importWorkflowDraft(text(`{"ghost":{"x":5,"y":0}}`))).toThrow();
    let out: ReturnType<typeof importWorkflowDraft> | null = null;
    try { out = importWorkflowDraft(text(`{"__proto__":{"x":5,"y":5},"brand":{"x":1,"y":2}}`)); } catch { /* refusing is fine too */ }
    if (out) {
      expect(Object.getPrototypeOf(out.positions)).toBe(Object.prototype);
      expect(Object.keys(out.positions)).toEqual(["brand"]);
    }
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  // BROKE (low). A node id that is also an Object.prototype property ("constructor", "toString", "valueOf", ...) matches the id
  // regex in agent-graph.ts and in migration 0130, so a crafted file or a cloud draft can carry it. toFlowNodes reads
  // `view.dragging?.[id] ?? positions[id] ?? default` and `view.measured?.[id]` off plain objects, so for such an id it hands React
  // Flow the inherited function (Object, Object.prototype.toString, ...) as the node's position and measured size: x and y are
  // undefined, the card is drawn at NaN, and a nudge computes undefined + 20. Fix: read the three maps with Object.hasOwn (or hold
  // them in Map / Object.create(null)) in lib/agent-flow.ts nodePosition/toFlowNodes and in agent-draft.ts exportWorkflowDraft.
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "toLocaleString"])(
    "a node id equal to Object.prototype.%s is still drawn at a finite position on its grid slot",
    id => {
      const wf = campaignWithBrandId(id);
      expect(inspectWorkflow(wf).ok).toBe(true);
      const [node] = toFlowNodes(wf, {}, { dragging: {}, selected: new Set(), measured: {} });
      expect(finite(node.position), `${id} position`).toBe(true);
      expect(node.position).toEqual(defaultNodePosition(0));
      expect(node.measured === undefined || Number.isFinite(node.measured.width), `${id} measured`).toBe(true);
    },
  );

  it("a cloud draft or a file with node id \"constructor\" mounts with every card at a finite position (BROKE, low)", async () => {
    mount();
    await importFile(JSON.stringify(draftOf(campaignWithBrandId("constructor"))));
    expect(status()).toBe("Validated workflow draft imported. No execution or server upload.");
    for (const n of props().nodes!) expect(finite(n.position), n.id).toBe(true);
    // fitView over one NaN card makes the whole viewport translate(NaNpx,NaNpx) scale(NaN): every card vanishes, not just that one.
    await new Promise(r => setTimeout(r, 50));
    expect((document.querySelector(".react-flow__viewport") as HTMLElement | null)?.style.transform ?? "").not.toContain("NaN");
    fireEvent.click(screen.getByRole("button", { name: "Move Brand kit right" }));
    const at = props().nodes!.find(n => n.id === "constructor")!.position;
    expect(at).toEqual({ x: defaultNodePosition(0).x + 20, y: defaultNodePosition(0).y });
  });

  // INFO (fails closed). A lone UTF-16 surrogate is one code point to Array.from and matches no REFUSED_TEXT_CHARS range, so
  // inspectWorkflow calls the label ok and the Save button is enabled; Postgres refuses the request body before the function runs
  // ("Unicode low surrogate must follow a high surrogate", checked on the local lab's Postgres 16). Nothing is stored; the person
  // gets "Cloud save unavailable" instead of the validation message. Fix: add \uD800-\uDFFF (unpaired, i.e. test with the `u`
  // flag on a string that fails `isWellFormed()`) to the browser's refusal.
  it("a label with an unpaired surrogate is refused by inspectWorkflow as the database would refuse it (INFO)", () => {
    const wf = createCampaignWorkflow();
    wf.nodes[0] = { ...wf.nodes[0], label: "Brand \ud800 kit" };
    expect(inspectWorkflow(wf).ok).toBe(false);
  });
});

describe("Breach: React Flow's own events and forged connections", () => {
  it("handle ids never pick the port: a forged Connection with spoofed handles lands on the type-derived port or is refused", () => {
    mount();
    const before = edgeIds();
    connect("brand", "export", { sourceHandle: "approval", targetHandle: "approval" });
    connect("image", "export", { sourceHandle: "approval", targetHandle: "approval" });
    connect("prompt", "review", { sourceHandle: "image", targetHandle: "image" });
    connect("export", "export");
    connect(null, "export");
    connect("brand", "__proto__");
    expect(edgeIds()).toEqual(before);
    act(() => { fireEvent.change(screen.getByLabelText("Node type"), { target: { value: "vector.generate" } }); });
    fireEvent.click(screen.getByRole("button", { name: "+ Add node" }));
    connect("prompt", "vector_generate_1", { sourceHandle: "approval", targetHandle: "brand" });
    const wire = props().edges!.find(e => e.id === "prompt->vector_generate_1")!;
    expect(wire.sourceHandle).toBe("prompt");
    expect(wire.targetHandle).toBe("prompt");
  });

  it("a short-circuit to export is refused on every path, whatever the review it goes around", () => {
    mount();
    fireEvent.change(screen.getByLabelText("Node type"), { target: { value: "review.approval" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add node" }));
    fireEvent.change(screen.getByLabelText("Node type"), { target: { value: "asset.export" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add node" }));
    // An unconnected export already makes the graph invalid; neither a forged drop nor the selects can make it ok without a review.
    for (const src of ["brand", "products", "prompt", "image", "export"]) connect(src, "asset_export_1");
    expect(edgeIds().some(id => id.endsWith("->asset_export_1"))).toBe(false);
    expect(screen.getByRole("button", { name: /Download validated draft/ })).toHaveProperty("disabled", true);
    connect("review_approval_1", "asset_export_1");
    expect(edgeIds()).toContain("review_approval_1->asset_export_1");
    // A review with no input approves nothing reachable from a generator, but inspectWorkflow treats a review node as reviewed:
    // that is the documented rule (every path to export passes a review), and 0130 agrees (review -> export is the only kind).
    expect(inspectWorkflow({ ...createCampaignWorkflow() }).ok).toBe(true);
  });

  it("add and replace changes from React Flow are ignored: no node or edge appears that the draft did not make", () => {
    mount();
    const nodesBefore = props().nodes!.map(n => n.id);
    const edgesBefore = edgeIds();
    const fake = { id: "rogue", type: "agent", position: { x: NaN, y: Infinity }, data: { node: { id: "rogue", type: "asset.export", label: "x", config: {} }, index: 0 } } as AgentFlowNode;
    nodesChange([
      { type: "add", item: fake },
      { type: "replace", id: "review", item: { ...fake, id: "review", data: { ...fake.data, node: { ...fake.data.node, id: "review", type: "brand.input" } } } },
      { type: "position", id: "rogue", position: { x: 5, y: 5 }, dragging: false },
      { type: "position", id: "brand", position: { x: NaN, y: Infinity }, dragging: false },
      { type: "position", id: "image", position: { x: 1e308 * 10, y: -1e308 * 10 }, dragging: true },
      { type: "dimensions", id: "ghost", dimensions: { width: 1, height: 1 } },
    ] as NodeChange<AgentFlowNode>[]);
    expect(props().nodes!.map(n => n.id)).toEqual(nodesBefore);
    expect(props().nodes!.find(n => n.id === "review")!.data.node.type).toBe("review.approval");
    expect(props().nodes!.find(n => n.id === "brand")!.position).toEqual({ x: 0, y: 0 });
    expect(props().nodes!.find(n => n.id === "image")!.position).toEqual({ x: 0, y: 0 });
    for (const n of props().nodes!) expect(finite(n.position), n.id).toBe(true);
    edgesChange([
      { type: "add", item: { id: "image->export", source: "image", target: "export", type: "agent" } },
      { type: "replace", id: "review->export", item: { id: "review->export", source: "image", target: "export", type: "agent" } },
    ] as EdgeChange<AgentFlowEdge>[]);
    expect(edgeIds()).toEqual(edgesBefore);
    expect(props().edges!.find(e => e.id === "review->export")!.source).toBe("review");
  });

  it("a drag-stop with forged nodes keeps only our ids, clamped", () => {
    mount();
    const node = props().nodes!.find(n => n.id === "brand")!;
    act(() => props().onNodeDragStop!(new MouseEvent("mouseup"), node, [
      { ...node, position: { x: NaN, y: -Infinity } },
      { ...node, id: "ghost", position: { x: 1, y: 1 } },
    ]));
    expect(props().nodes!.find(n => n.id === "brand")!.position).toEqual({ x: 0, y: 0 });
    expect(props().nodes!.some(n => n.id === "ghost")).toBe(false);
  });

  it("removing the review through React Flow (node delete) leaves export unreachable and the plan not exportable or saveable", () => {
    mount();
    nodesChange([{ type: "remove", id: "review" }]);
    expect(edgeIds()).not.toContain("review->export");
    expect(screen.getByRole("button", { name: /Download validated draft/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Save private draft to cloud" })).toHaveProperty("disabled", true);
    edgesChange([{ type: "remove", id: "image->review" }]);
    expect(screen.getByText("NEEDS REVIEW")).toBeTruthy();
  });

  it("onBeforeDelete refuses while focus is off the canvas, so a stray Backspace cannot strip a review", async () => {
    mount();
    const review = props().nodes!.filter(n => n.id === "review");
    (document.body as HTMLElement).focus();
    expect(await props().onBeforeDelete!({ nodes: review, edges: [] })).toBe(false);
    (screen.getByLabelText("Workflow name") as HTMLElement).focus();
    expect(await props().onBeforeDelete!({ nodes: review, edges: [] })).toBe(false);
  });

  it("the canvas cannot pass 64 nodes or 128 edges", () => {
    mount();
    for (let i = 0; i < 70; i++) fireEvent.click(screen.getByRole("button", { name: "+ Add node" }));
    expect(props().nodes!.length).toBe(64);

    // 8 brands x 16 prompts = 128 legal edges; the 129th, through a forged drop or the selects, is refused.
    let wf: AgentWorkflow = { version: 1, name: "edges", nodes: [], edges: [] };
    for (let i = 0; i < 9; i++) wf = addNode(wf, "brand.input");
    for (let i = 0; i < 16; i++) wf = addNode(wf, "prompt.compose");
    for (let b = 1; b <= 8; b++) for (let p = 1; p <= 16; p++) wf.edges.push({ source: `brand_input_${b}`, target: `prompt_compose_${p}` });
    expect(inspectWorkflow(wf).ok).toBe(true);
    const out = applyConnect(wf, "brand_input_9", "prompt_compose_1");
    expect(out.ok).toBe(false);
    expect(out.graph).toBe(wf);
  }, 60_000);
});

describe("Breach: canvas state versus migration 0130", () => {
  it("every state a random run of canvas gestures reaches that inspectWorkflow calls ok exports, re-imports and passes 0130's rules", () => {
    let seed = 0x5eed;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const weird = [NaN, Infinity, -Infinity, -5, 3.7, 1e9, 2200.4, 1599.6, -0];
    let graph = createCampaignWorkflow();
    let positions: Record<string, NodePosition> = {};
    let okStates = 0;
    for (let step = 0; step < 4000; step++) {
      // Start over now and then: an unconnected export (or 64 nodes) would otherwise keep every later state invalid.
      if (step % 120 === 0) { graph = createCampaignWorkflow(); positions = {}; }
      const ids = graph.nodes.map(n => n.id);
      const r = rnd();
      if (r < 0.2) graph = addNode(graph, rnd() < 0.15 ? "asset.export" : pick(NODE_TYPES.filter(t => t !== "asset.export")));
      else if (r < 0.6 && ids.length) graph = applyConnect(graph, pick(ids), pick(ids)).graph;
      else if (r < 0.7 && ids.length) ({ graph, positions } = removeNodeAndPosition(graph, positions, pick(ids)));
      else if (r < 0.78 && graph.edges.length) { const e = pick(graph.edges); graph = removeEdges(graph, new Set([`${e.source}->${e.target}`])); }
      else if (ids.length) {
        const out = readNodeChanges(graph, [{ type: "position", id: pick(ids), position: { x: rnd() < 0.3 ? pick(weird) : rnd() * 3000 - 400, y: rnd() < 0.3 ? pick(weird) : rnd() * 2200 - 300 }, dragging: false }]);
        positions = { ...positions, ...out.persist };
      }
      expect(graph.nodes.length).toBeLessThanOrEqual(64);
      expect(graph.edges.length).toBeLessThanOrEqual(128);
      const types = new Map(graph.nodes.map(n => [n.id, n.type]));
      for (const e of graph.edges) expect(CONNECTIONS[types.get(e.source)!]).toContain(types.get(e.target));
      for (const p of Object.values(positions)) expect(p).toEqual(clampPosition(p.x, p.y));
      for (const n of toFlowNodes(graph, positions)) expect(finite(n.position)).toBe(true);
      expect(toFlowEdges(graph).length).toBe(graph.edges.length);
      if (inspectWorkflow(graph).ok) {
        okStates++;
        const text = exportWorkflowDraft(graph, positions);
        expect(dbAccepts(JSON.parse(text))).toBe(true);
        expect(() => importWorkflowDraft(text)).not.toThrow();
      }
    }
    expect(okStates).toBeGreaterThan(50);
  }, 60_000);

  it("readEdgeChanges and readNodeChanges drop ids the draft does not hold, including prototype names", () => {
    const g = createCampaignWorkflow();
    const n = readNodeChanges(g, [
      { type: "remove", id: "__proto__" }, { type: "remove", id: "constructor" },
      { type: "position", id: "toString", position: { x: 1, y: 1 }, dragging: false },
    ]);
    expect(n).toEqual({ persist: {}, dragging: {}, remove: [], select: {}, measured: {} });
    const e = readEdgeChanges(g, [{ type: "remove", id: "__proto__" }, { type: "remove", id: "brand->export" }]);
    expect(e.remove.size).toBe(0);
  });
});

describe("Breach: rule 3 on the canvas", () => {
  it("no forged React Flow event, import or gesture reaches fetch", async () => {
    mount();
    connect("brand", "export", { sourceHandle: "approval", targetHandle: "approval" });
    nodesChange([{ type: "remove", id: "review" }, { type: "position", id: "brand", position: { x: NaN, y: NaN }, dragging: true }]);
    edgesChange([{ type: "remove", id: "brand->prompt" }]);
    await act(async () => { await props().onBeforeDelete!({ nodes: props().nodes!, edges: props().edges! }); });
    act(() => props().onConnectEnd!(new MouseEvent("mouseup"), { isValid: false, fromNode: { id: "brand" }, toNode: { id: "export" }, fromHandle: { type: "target" }, toHandle: null } as unknown as Parameters<NonNullable<FlowProps["onConnectEnd"]>>[1]));
    await importFile(JSON.stringify(draftOf(createCampaignWorkflow())));
    for (const b of screen.getAllByRole("button", { name: /Zoom|Fit|Move|Disconnect/ })) fireEvent.click(b);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
