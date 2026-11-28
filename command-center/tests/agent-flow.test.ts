/**
 * lib/agent-flow: the Agent Builder's bridge to React Flow. What would break without these: a wire allowed because a
 * handle id said so, a refused drop that still changed the draft, a removed node that left its wires or a saved position
 * behind, a drag that saved a position off the canvas, and React Flow's own changes acting on ids the draft does not hold.
 */
import { describe, expect, it } from "vitest";
import { NODE_TYPES, createCampaignWorkflow } from "@/lib/agent-graph";
import { PORTS, addNode, checkConnection, clampPosition } from "@/lib/agent-graph-editor";
import { defaultNodePosition, exportWorkflowDraft, importWorkflowDraft } from "@/lib/agent-draft";
import {
  applyConnect,
  connectionAllowed,
  connectionReason,
  edgeId,
  focusAfterRemoval,
  readEdgeChanges,
  readNodeChanges,
  removeEdges,
  removeNodeAndPosition,
  toFlowEdges,
  toFlowNodes,
  wirePorts,
} from "@/lib/agent-flow";

describe("applyConnect: a drop is checked by type, and a refusal changes nothing", () => {
  it("a disallowed pair returns the very same graph and the refusal reason", () => {
    const graph = createCampaignWorkflow();
    const out = applyConnect(graph, "brand", "export");
    expect(out.ok).toBe(false);
    expect(out.graph).toBe(graph);
    expect(out.graph.edges).toEqual(createCampaignWorkflow().edges);
    expect(out.reason).toBe("These node types cannot be connected.");
  });

  it("an allowed pair adds exactly one edge, and the same drop again adds none", () => {
    const graph = addNode(createCampaignWorkflow(), "video.generate");
    const once = applyConnect(graph, "prompt", "video_generate_1");
    expect(once.ok).toBe(true);
    expect(once.graph.edges).toHaveLength(graph.edges.length + 1);
    expect(once.graph.edges.at(-1)).toEqual({ source: "prompt", target: "video_generate_1" });
    const twice = applyConnect(once.graph, "prompt", "video_generate_1");
    expect(twice.ok).toBe(false);
    expect(twice.graph).toBe(once.graph);
    expect(twice.reason).toBe("Connection already exists.");
  });

  it("a missing end (React Flow's null source or target) is refused, not added", () => {
    const graph = createCampaignWorkflow();
    expect(applyConnect(graph, null, "prompt")).toMatchObject({ ok: false, graph });
    expect(applyConnect(graph, "brand", undefined)).toMatchObject({ ok: false, graph });
  });
});

describe("removing a node", () => {
  it("removes its edges and its saved position, and leaves every other position", () => {
    const graph = createCampaignWorkflow();
    const positions = { review: { x: 400, y: 300 }, brand: { x: 10, y: 10 } };
    const out = removeNodeAndPosition(graph, positions, "review");
    expect(out.graph.nodes.some(n => n.id === "review")).toBe(false);
    expect(out.graph.edges.some(e => e.source === "review" || e.target === "review")).toBe(false);
    expect(out.positions).toEqual({ brand: { x: 10, y: 10 } });
  });

  it("an id not in the workflow changes nothing", () => {
    const graph = createCampaignWorkflow();
    const positions = { brand: { x: 10, y: 10 } };
    const out = removeNodeAndPosition(graph, positions, "ghost");
    expect(out.graph).toBe(graph);
    expect(out.positions).toBe(positions);
  });
});

describe("toFlowNodes / toFlowEdges derive React Flow's view from our state", () => {
  it("a node without a saved position sits at defaultNodePosition(index); a saved one where it was saved", () => {
    const nodes = toFlowNodes(createCampaignWorkflow(), { prompt: { x: 900, y: 40 } });
    expect(nodes.map(n => n.id)).toEqual(["brand", "products", "prompt", "image", "review", "export"]);
    expect(nodes[0].position).toEqual(defaultNodePosition(0));
    expect(nodes[2].position).toEqual({ x: 900, y: 40 });
    expect(nodes[5].position).toEqual(defaultNodePosition(5));
  });

  it("one wire per workflow edge, drawn on the port its two types share", () => {
    const edges = toFlowEdges(createCampaignWorkflow());
    expect(edges.map(e => e.id)).toEqual(["brand->prompt", "products->prompt", "prompt->image", "image->review", "review->export"]);
    expect(edges.find(e => e.id === "products->prompt")).toMatchObject({ sourceHandle: "catalog", targetHandle: "catalog" });
    expect(edges.every(e => (e.interactionWidth ?? 0) >= 20)).toBe(true);
  });

  it("every allowed type pair has a shared port to draw on", () => {
    for (const from of NODE_TYPES) for (const to of NODE_TYPES) {
      const p = wirePorts(from, to);
      if (p.sourceHandle) {
        expect(PORTS[from].output).toContain(p.sourceHandle);
        expect(PORTS[to].input).toContain(p.targetHandle);
      }
    }
  });
});

describe("readNodeChanges / readEdgeChanges", () => {
  it("clamps every move; a drag in progress is drawn, only a finished one is kept", () => {
    const graph = createCampaignWorkflow();
    const out = readNodeChanges(graph, [
      { type: "position", id: "brand", position: { x: -80, y: 9000 }, dragging: true },
      { type: "position", id: "prompt", position: { x: 5000.4, y: 12.6 }, dragging: false },
    ]);
    expect(out.dragging).toEqual({ brand: { x: 0, y: 1600 } });
    expect(out.persist).toEqual({ prompt: { x: 2200, y: 13 } });
  });

  it("ignores React Flow's changes (remove, move, select) for ids the workflow does not hold", () => {
    const graph = createCampaignWorkflow();
    const out = readNodeChanges(graph, [
      { type: "remove", id: "ghost" },
      { type: "position", id: "ghost", position: { x: 1, y: 1 }, dragging: false },
      { type: "select", id: "ghost", selected: true },
      { type: "remove", id: "image" },
    ]);
    expect(out.remove).toEqual(["image"]);
    expect(out.persist).toEqual({});
    expect(out.select).toEqual({});
    const edges = readEdgeChanges(graph, [{ type: "remove", id: "ghost->prompt" }, { type: "remove", id: edgeId("image", "review") }]);
    expect([...edges.remove]).toEqual(["image->review"]);
  });

  it("removeEdges filters by wire id and returns the same graph for an unknown id", () => {
    const graph = createCampaignWorkflow();
    expect(removeEdges(graph, new Set(["nope"]))).toBe(graph);
    const next = removeEdges(graph, new Set(["image->review"]));
    expect(next.edges).toHaveLength(graph.edges.length - 1);
    expect(next.edges.some(e => e.source === "image" && e.target === "review")).toBe(false);
  });
});

describe("drafts keep the layout", () => {
  it("export -> import round-trips every node's position, defaulting the unsaved ones", () => {
    const graph = createCampaignWorkflow();
    const moved = readNodeChanges(graph, [{ type: "position", id: "review", position: { x: 1234, y: 567 }, dragging: false }]).persist;
    const back = importWorkflowDraft(exportWorkflowDraft(graph, moved));
    expect(back.positions.review).toEqual({ x: 1234, y: 567 });
    expect(back.positions.brand).toEqual(defaultNodePosition(0));
    expect(toFlowNodes(back.workflow, back.positions).map(n => n.position)).toEqual(
      graph.nodes.map((n, i) => (n.id === "review" ? { x: 1234, y: 567 } : defaultNodePosition(i))),
    );
  });
});

describe("defaultNodePosition: a slot for every node the schema allows", () => {
  it("the first 21 slots are where every earlier draft without positions was drawn", () => {
    for (let i = 0; i < 21; i++) expect(defaultNodePosition(i)).toEqual({ x: 20 + (i % 3) * 250, y: 20 + Math.floor(i / 3) * 250 });
  });

  it("64 default positions: all inside clampPosition's bounds, no two cards (220 x 250 slots) overlapping", () => {
    const at = Array.from({ length: 64 }, (_, i) => defaultNodePosition(i));
    for (const p of at) expect(p).toEqual(clampPosition(p.x, p.y));
    for (let a = 0; a < at.length; a++) for (let b = a + 1; b < at.length; b++) {
      const apart = Math.abs(at[a].x - at[b].x) >= 220 || Math.abs(at[a].y - at[b].y) >= 250;
      expect(apart, `slots ${a} and ${b} overlap`).toBe(true);
    }
  });
});

describe("connectionAllowed: what a pointer may drop on", () => {
  it("named handles must be the ports wirePorts draws on; absent handles leave it to the types", () => {
    const graph = createCampaignWorkflow();
    const g = { ...graph, edges: graph.edges.filter(e => e.target !== "review") };
    expect(connectionAllowed(g, { source: "image", target: "review", sourceHandle: "image", targetHandle: "image" })).toBe(true);
    expect(connectionAllowed(g, { source: "image", target: "review", sourceHandle: "image", targetHandle: "vector" })).toBe(false);
    expect(connectionAllowed(g, { source: "image", target: "review" })).toBe(true);
    expect(connectionAllowed(g, { source: "brand", target: "export", sourceHandle: "approval", targetHandle: "approval" })).toBe(false);
    expect(connectionAllowed(g, { source: null, target: "review" })).toBe(false);
  });
});

describe("connectionReason maps every refusal checkConnection gives to a dictionary key", () => {
  it("each refusal of a real graph has a key, so no reason reaches a Russian or Uzbek reader in English", () => {
    const graph = addNode(createCampaignWorkflow(), "video.generate");
    const refusals = [
      checkConnection(graph, "ghost", "prompt"),
      checkConnection(graph, "brand", "export"),
      checkConnection(graph, "brand", "prompt"),
      checkConnection({ ...graph, edges: [...graph.edges, { source: "image", target: "export" }] }, "prompt", "video_generate_1"),
    ];
    expect(refusals.map(r => connectionReason(r.reason))).toEqual(["pick", "types", "exists", "review"]);
    expect(connectionReason("Workflow contains a cycle")).toBe("cycle");
    expect(connectionReason("edges: Too big: expected array to have <=128 items")).toBe("tooMany");
    expect(connectionReason("something new")).toBeNull();
  });
});

describe("focusAfterRemoval", () => {
  it("the next card that stays, else the previous one, else none", () => {
    const graph = createCampaignWorkflow();
    expect(focusAfterRemoval(graph, new Set(["image"]))).toBe("review");
    expect(focusAfterRemoval(graph, new Set(["image", "review"]))).toBe("export");
    expect(focusAfterRemoval(graph, new Set(["export"]))).toBe("review");
    expect(focusAfterRemoval(graph, new Set(graph.nodes.map(n => n.id)))).toBeNull();
    expect(focusAfterRemoval(graph, new Set(["ghost"]))).toBeNull();
  });
});
