import { describe, expect, it } from "vitest";
import { planCreativeRequest } from "./agent-planner";
import { inspectWorkflow } from "./agent-graph";
describe("agent planner is only a safe deterministic draft builder", () => {
  it.each([["generate an image","image.generate"],["create a reels video","video.generate"],["make a logo svg","vector.generate"]] as const)(
    "creates approved %s workflow", (input, expected) => {
      const out = planCreativeRequest(input);
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.workflow.nodes.some(n => n.type === expected)).toBe(true);
        expect(inspectWorkflow(out.workflow).ok).toBe(true);
        expect(out.workflow.nodes.some(n => n.type === "review.approval")).toBe(true);
      }
    });
  it("refuses ambiguous requests unless media type is explicitly chosen", () => {
    expect(planCreativeRequest("make an image and a reels video")).toEqual({ok:false,error:"ambiguous_intent"});
    const out = planCreativeRequest("make an image and a reels video","video");
    expect(out.ok).toBe(true);
    if(out.ok) expect(out.warnings.some(w=>w.includes("Multiple media"))).toBe(true);
  });
  it("refuses unsupported intents without inventing API tools", () => {
    expect(planCreativeRequest("transfer my credits")).toEqual({ok:false,error:"unsupported_request"});
    expect(planCreativeRequest(" ")).toEqual({ok:false,error:"empty_request"});
    expect(planCreativeRequest("x".repeat(501))).toEqual({ok:false,error:"unsupported_request"});
  });
});
