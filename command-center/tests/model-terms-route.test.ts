import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireOperator, rpc, logAudit } = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  rpc: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/org-roles", () => ({ requireOperator }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));
vi.mock("@/lib/server/audit", () => ({ logAudit }));

import { POST } from "@/app/api/models/terms/route";

const acceptance = { id: "test-model", gate: "vendor-terms-v1", confirm: "test-model" };

function post(body: unknown, origin = "https://example.test") {
  return POST(new Request("https://example.test/api/models/terms", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  requireOperator.mockResolvedValue({ ok: true });
  rpc.mockResolvedValue({ data: {}, error: null });
});

describe("model terms POST", () => {
  it("refuses a platform admin who is not the owner", async () => {
    rpc.mockResolvedValue({ error: { code: "42501" } });
    expect((await post(acceptance)).status).toBe(403);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("asks the owner to verify again when the database requires recent MFA", async () => {
    rpc.mockResolvedValue({ error: { code: "42501", message: "terms_mfa_required" } });
    const response = await post(acceptance);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "mfa_required" });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("checks the operator and request origin before calling the RPC", async () => {
    requireOperator.mockResolvedValueOnce({ ok: false, status: 403, error: "forbidden" });
    expect((await post(acceptance)).status).toBe(403);
    expect((await post(acceptance, "https://foreign.test")).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires the exact model id as confirmation", async () => {
    const response = await post({ ...acceptance, confirm: `${acceptance.id} ` });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_confirm" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([undefined, "", 123])("rejects an invalid gate (%s)", async (gate) => {
    const response = await post({ ...acceptance, gate });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_gate" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["gate", "confirm"] as const)("rejects revocation with %s", async (field) => {
    const response = await post({ id: acceptance.id, revoke: true, [field]: acceptance[field] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("accepts the named gate through the session RPC and audits it", async () => {
    expect((await post(acceptance)).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("owner_accept_model_terms", {
      p_model: acceptance.id,
      p_gate: acceptance.gate,
      p_confirm: acceptance.confirm,
    });
    expect(logAudit).toHaveBeenCalledWith({
      action: "model.terms_accept", target: acceptance.id, detail: { gate: acceptance.gate },
    });
  });

  it("revokes the recorded gate through the session RPC and audits it", async () => {
    expect((await post({ id: acceptance.id, revoke: true })).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("owner_revoke_model_terms", { p_model: acceptance.id });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "model.terms_revoke", target: acceptance.id,
    }));
  });

  it.each([
    ["22023", 400, "bad_confirm"],
    ["P0002", 404, "not_found"],
    ["P2271", 403, "bytedance"],
    ["P2272", 409, "gate_changed"],
    ["P2273", 409, "not_accepted"],
    ["PGRST202", 503, "not_enabled"],
  ])("maps SQL refusal %s to %s with its remedy code", async (code, status, error) => {
    rpc.mockResolvedValue({ error: { code } });
    const response = await post(acceptance);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(logAudit).not.toHaveBeenCalled();
  });
});
