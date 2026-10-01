import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  characterIdsByChannel,
  dnaAnchor,
  dnaFromChannel,
  runDna,
  studioDna,
  withChannelDna,
  type RunDna,
  type StudioDna,
} from "@/lib/channel-dna";
import { getChannelPath } from "@/lib/channels-path-server";
import type { StudioPrefill } from "@/lib/creative/studio";
import type { ChannelRow } from "@/lib/types";
import { isMissingRelation } from "@/lib/style-kits";

/**
 * Each channel's DNA characters (migration 0056), read as the member (RLS:
 * the organizations they belong to). `available: false` before 0056 is
 * applied; `failed` when the read failed — never an empty list that would
 * read as "this channel has none".
 */
export async function loadDnaCharacters(
  channelIds: readonly string[],
): Promise<{ available: boolean; failed: boolean; byChannel: Map<string, string[]> }> {
  const empty = new Map<string, string[]>();
  const supabase = await createClient();
  if (!supabase || channelIds.length === 0) return { available: Boolean(supabase), failed: false, byChannel: empty };
  try {
    const { data, error } = await supabase
      .from("channel_dna_characters")
      .select("channel_id, character_id, position")
      .in("channel_id", [...channelIds].slice(0, 200))
      .order("position", { ascending: true })
      .limit(1600);
    if (error) return isMissingRelation(error) ? { available: false, failed: false, byChannel: empty } : { available: true, failed: true, byChannel: empty };
    return { available: true, failed: false, byChannel: characterIdsByChannel(data) };
  } catch {
    return { available: true, failed: true, byChannel: empty };
  }
}

/**
 * What the Create page's two forms start from, for the channel in view (none
 * for "All channels"). Pure over the row the page already read — no extra
 * query, and nothing priced or spent: these only fill the forms.
 */
export async function channelDnaForCreate(channel: ChannelRow | undefined): Promise<{
  studio: (StudioDna & { href: string }) | null;
  run: (RunDna & { href: string }) | null;
  withStudio: (initial: StudioPrefill | null) => StudioPrefill | null;
}> {
  const dna = dnaFromChannel(channel);
  const studio = channel ? studioDna(dna) : null;
  const run = channel ? runDna(dna) : null;
  const href = channel ? (await getChannelPath())("/channels") + "#" + dnaAnchor(channel.channel_id) : "";
  return {
    studio: studio ? { ...studio, href } : null,
    run: run ? { ...run, href } : null,
    withStudio: (initial) => withChannelDna(initial, studio),
  };
}
