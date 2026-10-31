import { describe, expect, it } from "vitest";
import { planProviderSelection, validateProviderCostQuote } from "./agent-providers";
describe("direct provider preview is fail-closed", () => {
  it("does not claim actual prices or execution readiness", () => {
    const ideogram = planProviderSelection({provider:"ideogram", capability:"vector"});
    expect("error" in ideogram).toBe(false);
    if ("error" in ideogram) return;
    expect(ideogram.estimate).toBeNull();
    expect(ideogram.canExecute).toBe(false);
    expect(ideogram.requiresUserApproval).toBe(true);
  });
  it("denies mismatched capabilities", () => {
    expect(planProviderSelection({provider:"ideogram",capability:"video"}))
      .toEqual({error:"capability_not_supported_by_provider"});
    expect(planProviderSelection({provider:"byteplus",capability:"image"}))
      .toEqual({error:"capability_not_supported_by_provider"});
  });
  it("never accepts an arbitrary endpoint or key", () => {
    expect(planProviderSelection({provider:"byteplus",capability:"video",apiKey:"x"}))
      .toEqual({error:"invalid_selection"});
  });
  it("rejects fake or incomplete prices", () => {
    expect(validateProviderCostQuote({amountMinor:50,currency:"USD"})).toBeNull();
    expect(validateProviderCostQuote({amountMinor:-1,currency:"USD",source:"provider_api"})).toBeNull();
  });
  it("accepts structured provider quotes without treating them as approval", () => {
    const q = validateProviderCostQuote({
      amountMinor:50,currency:"USD",source:"provider_api",modelId:"verified-model",
      units:1,retrievedAt:"2026-10-31T00:00:00.000Z",expiresAt:"2026-10-31T00:05:00.000Z",
    });
    expect(q?.amountMinor).toBe(50);
  });
});
