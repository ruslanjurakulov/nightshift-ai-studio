import "server-only";
import { getChannelContext } from "@/lib/channels-server";
import { fetchTokenStatuses } from "@/lib/server/channel-tokens";
import type { ChannelTokenStatus } from "@/lib/channel-tokens";
import { listConnectedSocialAccounts } from "@/lib/server/social-accounts";
import type { ChannelCredentialRow, ChannelRow } from "@/lib/types";

/**
 * The publishing accounts connected to this workspace, for the account panel.
 *
 * Read with the signed-in user's own session (RLS): the channels of the
 * organization being viewed, their credential health, and — for a customer
 * organization — channel_token_status() (migration 0022), which returns
 * connection metadata only, never a token.
 *
 * Instagram and TikTok rows are the organization's social_accounts (migration
 * 0028, RLS: org members) — metadata only; their tokens are in Vault.
 */

export type Platform = "youtube" | "instagram" | "tiktok";

export interface ConnectedAccount {
  platform: Platform;
  /** Stable key for the row: the channel id for YouTube, the social_accounts
   *  id for Instagram / TikTok. */
  id: string;
  name: string;
  /** Public avatar URL read back from the platform, or null. */
  avatarUrl: string | null;
  /** True only when a usable token is on record right now. */
  connected: boolean;
}

/** Only an https URL is rendered as an image; anything else is dropped. */
function safeAvatar(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

/**
 * One YouTube row per channel.
 *
 * Name and avatar come from `credential_ref` — the public facts YouTube
 * returned when the channel was verified (0005) — falling back to the
 * channel's own name. "Connected" is the token that publishing actually uses:
 *
 * - a customer channel has a Vault reference (0022): connected while that
 *   reference is live (not revoked). Its row is the truth even when the bot's
 *   older health row says otherwise;
 * - the operator's channels keep their token as a GitHub secret, whose health
 *   the bot writes to channel_credentials: connected when that says so.
 *
 * `tokens` is null when 0022 is not applied; credential health is then the only
 * signal.
 */
export function youtubeAccounts(
  channels: readonly ChannelRow[],
  credentials: readonly ChannelCredentialRow[],
  tokens: readonly ChannelTokenStatus[] | null,
): ConnectedAccount[] {
  return channels.map((c) => {
    const token = tokens?.find((t) => t.channel_id === c.channel_id);
    const health = credentials.find((r) => r.channel_id === c.channel_id && r.provider === "youtube");
    const connected = token ? token.connected : health?.status === "connected";
    const ref = c.credential_ref ?? {};
    return {
      platform: "youtube" as const,
      id: c.channel_id,
      name: ref.youtube_title || c.name || c.channel_id,
      avatarUrl: safeAvatar(ref.youtube_thumbnail),
      connected,
    };
  });
}

/** Every connected (or connectable) account of the workspace being viewed. */
export async function readConnectedAccounts(): Promise<ConnectedAccount[]> {
  const [youtube, social] = await Promise.all([readYoutubeAccounts(), listConnectedSocialAccounts().catch(() => [])]);
  return [...youtube, ...social];
}

async function readYoutubeAccounts(): Promise<ConnectedAccount[]> {
  const { channels, credentials } = await getChannelContext();
  if (channels.length === 0) return [];
  const tokens = await fetchTokenStatuses();
  return youtubeAccounts(channels, credentials, tokens.available ? tokens.rows : null);
}
