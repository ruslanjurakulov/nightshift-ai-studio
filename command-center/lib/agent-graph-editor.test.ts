import { describe, it, expect } from "vitest";
import { createCampaignWorkflow } from "./agent-graph";
import { addNode, checkConnection, removeNode } from "./agent-graph-editor";
describe("safe visual workflow editor operations", () => {
  it("adds unique allowlisted node instances", () => {
    const graph = createCampaignWorkflow();
    const next = addNode(addNode(graph, "video.generate"), "video.generate");
    expect(next.nodes.length).toBe(graph.nodes.length + 2);
    expect(new Set(next.nodes.map(n => n.id)).size).toBe(next.nodes.length);
  });
  it("removes dangling edges with a node", () => {
    const graph = removeNode(createCampaignWorkflow(), "image");
    expect(graph.edges.every(e => e.source !== "image" && e.target !== "image")).toBe(true);
  });
  it("rejects incompatible connections", () => {
    expect(checkConnection(createCampaignWorkflow(), "brand", "export").ok).toBe(false);
  });
  it("rejects duplicate connections", () => {
    expect(checkConnection(createCampaignWorkflow(), "brand", "prompt").ok).toBe(false);
  });
  it("rejects unknown node ids", () => {
    expect(checkConnection(createCampaignWorkflow(), "missing", "prompt").ok).toBe(false);
  });
});
