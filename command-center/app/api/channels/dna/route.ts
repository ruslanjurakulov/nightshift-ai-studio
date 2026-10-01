import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { readJsonBody } from "@/lib/server/style-kits";
import { dnaRpcArgs, mapDnaError, parseDnaInput } from "@/lib/channel-dna";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Set a channel's DNA: POST `{ channel_id, style_kit_id, character_ids,
 * voice_id, language, format, aspect, tone }` (see lib/channel-dna.ts).
 *
 * One call to set_channel_dna (migration 0056) under the caller's own session
 * — an editor of the channel's organization, the channels update policy's
 * rule — which checks that the kit and every character are the channel's own
 * organization's (another organization's id is refused exactly like a made-up
 * one) and merges the voice and language into agent_config in the database,
 * so no other setting can be rewritten on the way.
 *
 * It sets configuration only. Nothing is generated, priced, rendered or
 * published here: the forms that create things start from these values.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = parseDnaInput(await readJsonBody(request));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("set_channel_dna", dnaRpcArgs(parsed.value));
  if (error) {
    const mapped = mapDnaError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  const v = parsed.value;
  // What changed, never the tone's words: an audit line is not a place for
  // free text someone typed.
  await logAudit({
    action: "channel.dna.update",
    channelId: v.channelId,
    detail: {
      style_kit: Boolean(v.styleKitId),
      characters: v.characterIds.length,
      voice: v.voiceId !== null,
      language: v.language,
      format: v.format,
      aspect: v.aspect,
      tone: v.tone.length > 0,
    },
  });
  return NextResponse.json({ ok: true, dna: data ?? null });
}
