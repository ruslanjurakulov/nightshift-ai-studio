/**
 * Writes a few `channels.agent_config` keys through the database function `patch_channel_agent_config` (migration 0119), not by
 * reading the object, merging a key and writing the whole of it back. The function merges in ONE statement under the row lock, so
 * two writers (two tabs, an administrator and an editor, the limit and a switch) cannot lose each other's keys, and it runs as the
 * caller, so every rule of the table's guard applies to it: an editor still cannot raise or remove a spend limit that is in force
 * (isSpendCeilingLockRefusal) nor turn a control on. It accepts four keys only (spend_ceiling_usd, pinned_comment, watch_next,
 * storyboard_review); a JSON null removes a key. Client-safe and pure: the client is passed in.
 */
import { isSpendCeilingLockRefusal } from "@/lib/channelRisk";

export type AgentConfigPatch = {
  spend_ceiling_usd?: number | null;
  pinned_comment?: boolean | null;
  watch_next?: boolean | null;
  storyboard_review?: boolean | null;
};

type RpcError = { code?: string | null; message?: string | null; hint?: string | null };
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError | null }> };

export type PatchResult =
  | { ok: true; agentConfig: Record<string, unknown> }
  | {
      ok: false;
      /**
       * spendLock: an editor tried to raise or remove a limit. notWritable: the channel is not the caller's to change (or does not
       * exist; the database answers both the same). unavailable: the function is not in the database yet (migration 0119 not
       * applied). failed: anything else, with the database's message.
       */
      reason: "spendLock" | "notWritable" | "unavailable" | "failed";
      message: string;
    };

/** PostgREST answers PGRST202 for a function it does not know; Postgres itself 42883. */
function functionIsMissing(e: RpcError): boolean {
  return e.code === "PGRST202" || e.code === "42883" || /could not find the function/i.test(e.message ?? "");
}

export async function patchChannelAgentConfig(client: RpcClient, channelId: string, patch: AgentConfigPatch): Promise<PatchResult> {
  const { data, error } = await client.rpc("patch_channel_agent_config", { p_channel_id: channelId, p_patch: patch });
  if (error) {
    const message = error.message ?? "";
    if (isSpendCeilingLockRefusal(error)) return { ok: false, reason: "spendLock", message };
    if (functionIsMissing(error)) return { ok: false, reason: "unavailable", message };
    if (error.hint === "channel_not_writable") return { ok: false, reason: "notWritable", message };
    return { ok: false, reason: "failed", message };
  }
  const out = (data ?? null) as { ok?: unknown; agent_config?: unknown } | null;
  // No error and no confirmation is not "saved": say so rather than show a value that may not be stored.
  if (!out || out.ok !== true || typeof out.agent_config !== "object" || out.agent_config === null) {
    return { ok: false, reason: "notWritable", message: "" };
  }
  return { ok: true, agentConfig: out.agent_config as Record<string, unknown> };
}
