import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { requireOperator } from "@/lib/auth/org-roles";
import { VOICE_LIST_RATE, rateRefusal, takeWebRate } from "@/lib/server/web-rate";
import { listAllVoices } from "@/lib/elevenlabsVoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List the ElevenLabs voices this account can actually use.
 *
 * The wizard used to ask for a voice id as free text. Nobody knows an
 * ElevenLabs voice id by heart, so what got typed was a plausible-looking
 * number — `16516516145` — which the form accepted, the database stored, and
 * the pipeline discovered four Gemini calls into a run. Offering the real
 * voices removes the guess: you cannot mistype a value you picked from a list.
 *
 * Same contract as the YouTube route next door: the key arrives in the body,
 * is used for exactly one upstream call, and is dropped when the handler
 * returns. It is not stored, not cached, not logged, and not echoed back. The
 * response carries only what the picker needs to draw itself.
 *
 * Operator only, and rate-limited per user: the key belongs to the platform's
 * own ElevenLabs account (there are no customer provider keys), and a route
 * that tells any signed-in account whether an arbitrary ElevenLabs key is
 * valid — and whether its account is out of characters — would be a free
 * key-checking proxy running from our servers.
 *
 * The list comes from the paginated v2 endpoint (lib/elevenlabsVoices.ts):
 * v1 stops working once an account has more than 500 voices.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const access = await requireOperator();
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  let body: { apiKey?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const apiKey = (body.apiKey ?? "").trim();
  if (!apiKey) return NextResponse.json({ error: "missing_key" }, { status: 400 });

  // Counted only once the request would reach ElevenLabs.
  const rate = await takeWebRate(user.id, VOICE_LIST_RATE);
  if (rate !== "ok") {
    const r = rateRefusal(rate, VOICE_LIST_RATE);
    return NextResponse.json(r.body, { status: r.status, headers: r.headers });
  }

  const result = await listAllVoices(apiKey);
  if (!result.ok) {
    if (result.error === "key_rejected") {
      return NextResponse.json({ error: "key_rejected", reason: result.reason }, { status: 400 });
    }
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  return NextResponse.json({ voices: result.voices, truncated: result.truncated });
}
