import { describe, it, expect } from "vitest";
import { createCampaignWorkflow, inspectWorkflow } from "./agent-graph";

describe("Nightshift agent graph: safe planning only", () => {
  it("accepts the reviewed brand-to-image workflow", () => {
    const result = inspectWorkflow(createCampaignWorkflow());
    expect(result.ok).toBe(true);
    expect(result.order.at(-1)).toBe("export");
    expect(result.requiresApproval).toBe(true);
  });
  it("blocks a cycle", () => {
    const graph = createCampaignWorkflow();
    graph.edges.push({ source: "export", target: "brand" });
    expect(inspectWorkflow(graph).ok).toBe(false);
  });
  it("blocks unknown node code execution", () => {
    const graph = createCampaignWorkflow() as unknown as {nodes: {type:string}[]};
    graph.nodes[3].type = "shell.execute";
    expect(inspectWorkflow(graph).ok).toBe(false);
  });
  it("blocks missing review node", () => {
    const graph = createCampaignWorkflow();
    graph.nodes = graph.nodes.filter(n => n.id !== "review");
    graph.edges = graph.edges.filter(e => e.source !== "review" && e.target !== "review");
    graph.edges.push({ source: "image", target: "export" });
    expect(inspectWorkflow(graph).errors.some(e => e.includes("review.approval"))).toBe(true);
  });
  it("blocks bypass of an existing review", () => {
    const graph = createCampaignWorkflow();
    graph.edges.push({ source: "image", target: "export" });
    expect(inspectWorkflow(graph).ok).toBe(false);
  });
  it("blocks duplicate ids and dangling edges", () => {
    const graph = createCampaignWorkflow();
    graph.nodes.push({ ...graph.nodes[0] });
    graph.edges.push({ source: "missing", target: "export" });
    expect(inspectWorkflow(graph).ok).toBe(false);
  });
  it("blocks provider secrets in graph", () => {
    const graph = createCampaignWorkflow();
    graph.nodes[3].config = { apiKey: "never-persist-secrets-here" };
    expect(inspectWorkflow(graph).ok).toBe(false);
  });
  it("does not accept unrecognized fields", () => {
    expect(inspectWorkflow({ ...createCampaignWorkflow(), script: "run" }).ok).toBe(false);
  });
});
