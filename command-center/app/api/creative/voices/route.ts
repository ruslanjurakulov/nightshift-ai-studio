import { NextResponse } from "next/server";
import { creativeSession } from "@/lib/server/creative";
import { getUser } from "@/lib/supabase/server";
import { STUDIO_VOICE_LIST_RATE, rateRefusal, takeWebRate } from "@/lib/server/web-rate";
import { cachedStudioVoices, readStudioVoices } from "@/lib/server/studio-voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — the voices the platform's ElevenLabs account can speak in, for the Studio's speech voice picker.
 *
 * Speech in the Studio is spoken by the platform's own ElevenLabs account (there are no customer provider keys),
 * so the list a member picks from is that account's list: a voice picked here is one the worker can actually use,
 * which a hard-coded list of ids cannot promise. A person picks; nobody types an id (CLAUDE.md ceiling).
 *
 * Any signed-in member of a workspace may read it. The key is the server's own ELEVENLABS_API_KEY, sent to
 * ElevenLabs and nowhere else: never in a response, a log or an error. Without it the answer is
 * `voices_not_configured` (503), not an empty list: "no key here" and "the account has no voices" need
 * different fixes. ElevenLabs refusing the key is `elevenlabs_key_rejected` without ElevenLabs' reason, which
 * describes the platform account (its balance) and is the operator's business, not a member's.
 *
 * Only a read that would reach ElevenLabs counts against the member's rate limit (lib/server/studio-voices.ts
 * keeps a fresh read for a few minutes). Read-only: nothing is priced, held or spent.
 */
export async function GET() {
  const session = await creativeSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  if (!session.defaultOrg) return NextResponse.json({ error: "org_required" }, { status: 403 });

  const apiKey = (process.env.ELEVENLABS_API_KEY ?? "").trim();
  if (!apiKey) return NextResponse.json({ error: "voices_not_configured" }, { status: 503 });

  const fresh = cachedStudioVoices();
  if (fresh) return NextResponse.json({ voices: fresh.voices, truncated: fresh.truncated });

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rate = await takeWebRate(user.id, STUDIO_VOICE_LIST_RATE);
  if (rate !== "ok") {
    const r = rateRefusal(rate, STUDIO_VOICE_LIST_RATE);
    return NextResponse.json(r.body, { status: r.status, headers: r.headers });
  }

  const result = await readStudioVoices(apiKey);
  if (!result.ok) {
    const error = result.error === "key_rejected" ? "elevenlabs_key_rejected" : result.error;
    return NextResponse.json({ error }, { status: 502 });
  }
  return NextResponse.json({ voices: result.voices, truncated: result.truncated });
}
