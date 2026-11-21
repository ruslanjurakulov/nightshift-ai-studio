import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Breach round 1 on PR #848. With 0107's second-factor gate on, the database refuses a password-only owner the two 0196/0197
// blocks (NS401), and the PR's lab test says why: "these facts are what the owner's AI hands a model: a stolen password must not
// read them". buildOwnerFacts() only turns that refusal into people/health "unknown" and goes on: revenue (0182
// owner_analytics_money) and provider balances, pace and the payment plan (0184 + the provider tables) have no second-factor
// check, so the same stolen password still gets them, tagged measured/estimated, in the object the owner's AI is handed.
// Fixed: buildOwnerFacts() asks admin_aal_ok() first and withholds the whole object, before any read.

const NOW = Date.parse("2026-11-21T12:00:00Z");

describe("owner facts with the second-factor gate on", () => {
  it("give a password-only owner no revenue and no provider balances, not only no people and no health", async () => {
    vi.resetModules();
    const readMoney = vi.fn(async () => ({ ok: true, data: [], truncated: false }));
    const readRunway = vi.fn(async () => ({}));
    vi.doMock("@/lib/server/owner-analytics", () => ({ ownerAccess: async () => "owner", readMoney }));
    vi.doMock("@/lib/server/owner-runway", () => ({ readRunway }));
    vi.doMock("@/lib/owner-analytics/runway", () => ({ providerRunways: () => [] }));
    vi.doMock("@/lib/supabase/server", () => ({
      // What PostgREST answers a password-only owner while the gate is on: 0196/0197 raise mfa_required (NS401).
      createClient: async () => ({
        rpc: async (name: string) =>
          name === "admin_aal_ok" ? { data: false, error: null } : { data: null, error: { code: "NS401", message: "mfa_required" } },
      }),
    }));
    const { buildOwnerFacts } = await import("@/lib/server/owner-brain-facts");
    const out = await buildOwnerFacts(NOW).catch((e: unknown) => e);
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).name === "SecondFactorRequiredError" || (out as Error).message.includes("second factor")).toBe(true);
    expect(readMoney).not.toHaveBeenCalled();
    expect(readRunway).not.toHaveBeenCalled();
  });
});
