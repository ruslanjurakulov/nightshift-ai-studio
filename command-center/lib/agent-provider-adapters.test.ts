import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { executeAdapterRequest, inspectAdapterRequest } from "./server/agent-provider-adapters";

const base = {
  provider: "ideogram", modelId: "approved-vector-model", capability: "vector",
  prompt: "Brand mark", requestId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222", assetIds: [],
} as const;
const model = {
  id: "approved-vector-model", provider: "ideogram", capability: "vector",
  enabled: true, termsApproved: true,
} as const;

describe("server provider adapter remains inert", () => {
  it("refuses unregistered model and leaked extra properties", () => {
    expect(inspectAdapterRequest(base)).toEqual({ok:false,error:"model_not_approved"});
    expect(inspectAdapterRequest({...base, apiKey:"secret"}, [model]))
      .toEqual({ok:false,error:"invalid_request"});
  });
  it("refuses unsupported provider capabilities", () => {
    expect(inspectAdapterRequest({...base,capability:"video"}, [model]))
      .toEqual({ok:false,error:"capability_mismatch"});
  });
  it("requires recorded commercial license approval", () => {
    expect(inspectAdapterRequest(base, [{...model, termsApproved:false}]))
      .toEqual({ok:false,error:"provider_terms_unverified"});
  });
  it("will not execute even if a model is marked approved", async () => {
    const inspected = inspectAdapterRequest(base, [model]);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) expect(inspected.executionReady).toBe(false);
    await expect(executeAdapterRequest(base)).rejects.toThrow("nightshift_agent_provider_execution_disabled");
  });
});
