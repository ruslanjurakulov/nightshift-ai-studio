import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { dispatchWorkflow, isGithubConfigured } from "@/lib/server/github-secrets";
import { isVoiceId } from "@/lib/ttsModels";

/**
 * Voice preview clips for the Create page (tools/voice_previews.py writes them
 * to the private `voice-previews` bucket, migration 0025).
 *
 *   GET  ?voice_id=…  → { ready: true, url } (a 10-minute signed URL) or { ready: false }
 *   POST { voice_id, channel_id } → asks the voice_previews workflow to prepare
 *                                    that one clip; the page then polls GET.
 *
 * The ElevenLabs key stays in GitHub: this route never calls ElevenLabs. A
 * clip for a voice with no ready-made preview costs about a hundred
 * characters, so asking for one is an admin action on the channel, like
 * starting a run.
 */

const SIGNED_URL_SECONDS = 600;

export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const voiceId = new URL(request.url).searchParams.get("voice_id")?.trim() ?? "";
  if (!isVoiceId(voiceId)) return NextResponse.json({ error: "bad_voice_id" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "supabase_not_configured" }, { status: 503 });
  const { data, error } = await supabase.storage
    .from("voice-previews")
    .createSignedUrl(`${voiceId}.mp3`, SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) return NextResponse.json({ ready: false });
  return NextResponse.json({ ready: true, url: data.signedUrl });
}

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { voice_id?: unknown; channel_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const voiceId = typeof body.voice_id === "string" ? body.voice_id.trim() : "";
  const channelId = typeof body.channel_id === "string" ? body.channel_id.trim() : "";
  if (!isVoiceId(voiceId)) return NextResponse.json({ error: "bad_voice_id" }, { status: 400 });
  if (!channelId) return NextResponse.json({ error: "channel_required" }, { status: 400 });

  const access = await requireOrgRole({ channelId }, "admin");
  if (!access.ok) {
    const error = access.error === "not_found" ? "channel_not_found" : access.error;
    return NextResponse.json({ error }, { status: access.status });
  }
  if (!isGithubConfigured) return NextResponse.json({ error: "github_not_configured" }, { status: 503 });
  try {
    await dispatchWorkflow("voice_previews.yml", { voice_id: voiceId });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "github_dispatch_failed";
    return NextResponse.json({ error: reason }, { status: reason === "github_unauthorized" ? 403 : 502 });
  }
  return NextResponse.json({ queued: true });
}
