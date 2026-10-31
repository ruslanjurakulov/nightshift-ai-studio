import { describe, it, expect } from "vitest";
import { createCampaignWorkflow } from "./agent-graph";
import { addNode, checkConnection, removeNode, portsCompatible, clampPosition, PORTS } from "./agent-graph-editor";
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
  it("checks typed input-output ports", () => {
    expect(portsCompatible("brand.input","prompt.compose")).toBe(true);
    expect(portsCompatible("prompt.compose","image.generate")).toBe(true);
    expect(portsCompatible("image.generate","asset.export")).toBe(false);
    expect(PORTS["asset.export"].input).toContain("approval");
  });
  it("clamps invalid canvas positions", () => {
    expect(clampPosition(-20, 9999)).toEqual({x:0,y:1600});
    expect(clampPosition(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({x:0,y:0});
  });
  it("rejects unknown node ids", () => {
    expect(checkConnection(createCampaignWorkflow(), "missing", "prompt").ok).toBe(false);
  });
});
