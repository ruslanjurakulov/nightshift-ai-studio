/**
 * lib/channelPatch.ts: the Channels page writes agent_config keys through patch_channel_agent_config (migration 0119) and turns the
 * database's answer into one of four reasons. What would break without these: a refusal of the spend-limit lock shown as a raw
 * database error; the "function not found" of a database the migration has not reached shown as a failure of the person's input;
 * an answer without a confirmation taken as saved; the function called with anything but the channel and the patch.
 */
import { describe, expect, it, vi } from "vitest";
import { patchChannelAgentConfig } from "@/lib/channelPatch";

const client = (reply: { data?: unknown; error?: { code?: string; message?: string; hint?: string } | null }) => {
  const rpc = vi.fn(() => Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null }));
  return { rpc };
};

describe("patchChannelAgentConfig", () => {
  it("calls the function with the channel and the patch only", async () => {
    const c = client({ data: { ok: true, agent_config: { watch_next: false } } });
    const out = await patchChannelAgentConfig(c, "chronos", { watch_next: false });
    expect(c.rpc).toHaveBeenCalledWith("patch_channel_agent_config", { p_channel_id: "chronos", p_patch: { watch_next: false } });
    expect(out).toEqual({ ok: true, agentConfig: { watch_next: false } });
  });

  it("sends null to remove a key", async () => {
    const c = client({ data: { ok: true, agent_config: {} } });
    await patchChannelAgentConfig(c, "chronos", { spend_ceiling_usd: null });
    expect(c.rpc).toHaveBeenCalledWith("patch_channel_agent_config", { p_channel_id: "chronos", p_patch: { spend_ceiling_usd: null } });
  });

  it.each([
    ["the lock, by its hint", { code: "42501", hint: "spend_ceiling_lock", message: "x" }, "spendLock"],
    ["the lock, by its message", { code: "42501", message: "spend_ceiling_lock: only an administrator" }, "spendLock"],
    ["a channel that is not the caller's", { code: "42501", hint: "channel_not_writable", message: "channel not found or not yours" }, "notWritable"],
    ["a database without the migration (PostgREST)", { code: "PGRST202", message: "Could not find the function public.patch_channel_agent_config" }, "unavailable"],
    ["a database without the migration (Postgres)", { code: "42883", message: "function does not exist" }, "unavailable"],
    ["the administrator-only control", { code: "42501", message: "only an administrator of this organization may change: storyboard_review" }, "failed"],
    ["an invalid patch", { code: "22023", hint: "invalid_patch", message: "invalid_patch: x" }, "failed"],
    ["anything else", { message: "network down" }, "failed"],
  ])("%s", async (_n, error, reason) => {
    const out = await patchChannelAgentConfig(client({ error }), "chronos", { watch_next: false });
    expect(out).toMatchObject({ ok: false, reason, message: error.message });
  });

  it.each([[null], [{}], [{ ok: false }], [{ ok: true }], [{ ok: true, agent_config: null }], [{ ok: true, agent_config: "x" }]])(
    "an answer without a confirmation (%j) is not saved",
    async (data) => {
      const out = await patchChannelAgentConfig(client({ data }), "chronos", { watch_next: false });
      expect(out).toMatchObject({ ok: false, reason: "notWritable" });
    },
  );
});
