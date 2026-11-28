import type { ChannelRow } from "@/lib/types";

/**
 * Which ElevenLabs voice belongs to which channel, voice id -> display name.
 *
 * Two channels narrated by the same voice sound like one channel with two
 * names, which is the opposite of why there is more than one. The creation
 * wizard greys out the voices this returns, so a collision is impossible to
 * select rather than rejected on save.
 *
 * Its own module, imported by the wizard alone: in lib/channels.ts, which nearly
 * every screen imports (the public site's too), it put the narration vendor's
 * name and its voice-id column in a chunk every visitor downloads.
 */
export function voiceOwners(channels: ChannelRow[]): Record<string, string> {
  const owners: Record<string, string> = {};
  for (const c of channels) {
    const agent = c.agent_config ?? {};
    if (agent.tts_provider !== "elevenlabs") continue;
    const voice = (agent.elevenlabs_voice_id ?? "").trim();
    if (voice && !owners[voice]) owners[voice] = c.name || c.channel_id;
  }
  return owners;
}
