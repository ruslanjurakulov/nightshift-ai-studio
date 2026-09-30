import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOperator } from "@/lib/auth/org-roles";
import { VOICE_PREVIEW_RATE, rateRefusal, takeWebRate } from "@/lib/server/web-rate";
import { dispatchWorkflow, isGithubConfigured } from "@/lib/server/github-secrets";
import { isVoiceId } from "@/lib/ttsModels";

/**
 * Voice preview clips for the Create page (tools/voice_previews.py writes them
 * to the private `voice-previews` bucket, migration 0026).
 *
 *   GET  ?voice_id=…  → { ready: true, url } (a 10-minute signed URL) or { ready: false }
 *   POST { voice_id } → asks the voice_previews workflow to prepare that one
 *                       clip; the page then polls GET. A clip that already
 *                       exists is not prepared again.
 *
 * The ElevenLabs key stays in GitHub: this route never calls ElevenLabs. But
 * each new clip spends the OPERATOR's ElevenLabs characters (about a hundred)
 * and an Actions run, and nothing charges the asker for either — so preparing
 * one is an operator action, rate-limited per user. A customer hears every
 * clip that already exists through GET.
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
  const access = await requireOperator();
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  let body: { voice_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const voiceId = typeof body.voice_id === "string" ? body.voice_id.trim() : "";
  if (!isVoiceId(voiceId)) return NextResponse.json({ error: "bad_voice_id" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "supabase_not_configured" }, { status: 503 });
  // A clip that exists is never paid for twice.
  const existing = await supabase.storage.from("voice-previews").createSignedUrl(`${voiceId}.mp3`, 60);
  if (!existing.error && existing.data?.signedUrl) return NextResponse.json({ queued: false, ready: true });

  if (!isGithubConfigured) return NextResponse.json({ error: "github_not_configured" }, { status: 503 });
  const rate = await takeWebRate(user.id, VOICE_PREVIEW_RATE);
  if (rate !== "ok") {
    const r = rateRefusal(rate, VOICE_PREVIEW_RATE);
    return NextResponse.json(r.body, { status: r.status, headers: r.headers });
  }
  try {
    await dispatchWorkflow("voice_previews.yml", { voice_id: voiceId });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "github_dispatch_failed";
    return NextResponse.json({ error: reason }, { status: reason === "github_unauthorized" ? 403 : 502 });
  }
  return NextResponse.json({ queued: true });
}
