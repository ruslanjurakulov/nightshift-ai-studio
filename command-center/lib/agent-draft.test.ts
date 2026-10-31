import { describe, expect, it } from "vitest";
import { createCampaignWorkflow } from "./agent-graph";
import { canvasEdges, defaultNodePosition, exportWorkflowDraft, importWorkflowDraft } from "./agent-draft";

describe("versioned Nightshift draft persistence", () => {
  it("round trips workflow and bounded positions", () => {
    const workflow = createCampaignWorkflow();
    const raw = exportWorkflowDraft(workflow, { brand: { x: 150, y: 250 } });
    const imported = importWorkflowDraft(raw);
    expect(imported.format).toBe("nightshift.agent-draft");
    expect(imported.layoutVersion).toBe(1);
    expect(imported.positions.brand).toEqual({ x: 150, y: 250 });
    expect(imported.workflow).toEqual(workflow);
    expect(Object.keys(imported.positions)).toHaveLength(workflow.nodes.length);
  });
  it("rejects a missing human-review structure", () => {
    const d = JSON.parse(exportWorkflowDraft(createCampaignWorkflow(), {}));
    d.workflow.edges = d.workflow.edges.filter((e: {source:string;target:string}) => e.target !== "review" && e.source !== "review");
    d.workflow.edges.push({ source: "image", target: "export" });
    expect(() => importWorkflowDraft(JSON.stringify(d))).toThrow("Workflow validation failed");
  });
  it("rejects unknown layout keys, unsupported versions and huge inputs", () => {
    const raw = exportWorkflowDraft(createCampaignWorkflow(), {});
    const parsed = JSON.parse(raw);
    parsed.positions.injected = { x: 1, y: 2 };
    expect(() => importWorkflowDraft(JSON.stringify(parsed))).toThrow("Layout contains unknown node");
    parsed.positions = {};
    parsed.layoutVersion = 42;
    expect(() => importWorkflowDraft(JSON.stringify(parsed))).toThrow("Unsupported");
    expect(() => importWorkflowDraft("x".repeat(150_001))).toThrow("150 KB");
  });
  it("rejects off-canvas coordinates instead of silently changing them", () => {
    const parsed = JSON.parse(exportWorkflowDraft(createCampaignWorkflow(), {}));
    parsed.positions.brand = { x: -10, y: 20 };
    expect(() => importWorkflowDraft(JSON.stringify(parsed))).toThrow("bounds");
  });
  it("renders edges deterministically and only as SVG path data", () => {
    const g = createCampaignWorkflow();
    const paths = canvasEdges(g, {});
    expect(paths).toHaveLength(g.edges.length);
    expect(paths[0].source).toBe("brand");
    expect(paths[0].path.startsWith("M ")).toBe(true);
    expect(defaultNodePosition(3).y).toBeGreaterThan(defaultNodePosition(0).y);
  });
});
