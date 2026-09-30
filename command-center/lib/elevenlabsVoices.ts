/**
 * List every ElevenLabs voice an account can use, through the paginated
 * `GET /v2/voices`.
 *
 * The route used `GET /v1/voices`, which ElevenLabs documents as no longer
 * working once a workspace has more than 500 voices — an account that had
 * added enough library voices would have seen the picker break. v2 returns at
 * most 100 voices a page plus a `next_page_token`; this follows the tokens,
 * with a hard page cap so a misbehaving upstream cannot loop forever.
 *
 * Server-only: the key is sent to ElevenLabs and nowhere else, never logged,
 * never part of a result.
 */

export const ELEVENLABS_VOICES_URL = "https://api.elevenlabs.io/v2/voices";
export const PAGE_SIZE = 100;
/** 20 pages × 100 = 2,000 voices, four times the size at which v1 gave up. */
export const MAX_PAGES = 20;

export type PickerVoice = {
  voiceId: string;
  name: string;
  category: string;
  previewUrl: string;
  labels: string;
};

type RawVoice = {
  voice_id: string;
  name?: string;
  category?: string;
  preview_url?: string;
  labels?: Record<string, string>;
};

type Page = { voices?: RawVoice[]; has_more?: boolean; next_page_token?: string | null };

export type VoiceListResult =
  | { ok: true; voices: PickerVoice[]; truncated: boolean }
  | { ok: false; error: "elevenlabs_unreachable" | "elevenlabs_unavailable" }
  | { ok: false; error: "key_rejected"; reason: string };

function toPickerVoice(v: RawVoice): PickerVoice {
  return {
    voiceId: v.voice_id,
    name: v.name ?? v.voice_id,
    category: v.category ?? "",
    previewUrl: v.preview_url ?? "",
    // Accent, age, gender and use case, as ElevenLabs labels them. This is what
    // makes two voices distinguishable in a dropdown of thirty.
    labels: Object.values(v.labels ?? {}).filter(Boolean).join(" · "),
  };
}

export async function listAllVoices(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VoiceListResult> {
  const out: PickerVoice[] = [];
  const seen = new Set<string>();
  let token: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(ELEVENLABS_VOICES_URL);
    url.searchParams.set("page_size", String(PAGE_SIZE));
    if (token) url.searchParams.set("next_page_token", token);

    let res: Response;
    try {
      res = await fetchImpl(url.toString(), { headers: { "xi-api-key": apiKey }, cache: "no-store" });
    } catch {
      return { ok: false, error: "elevenlabs_unreachable" };
    }

    if (res.status === 401) {
      // 401 covers three different situations that need three different fixes,
      // so the caller gets ElevenLabs' own code rather than a flat "rejected":
      // invalid_api_key is a wrong key, quota_exceeded is an account out of
      // characters, detected_unusual_activity is a blocked free tier.
      let reason = "";
      try {
        const detail = ((await res.json()) as { detail?: { status?: string } }).detail;
        reason = detail?.status ?? "";
      } catch {
        /* an unparseable body is still a 401 */
      }
      return { ok: false, error: "key_rejected", reason };
    }
    if (!res.ok) return { ok: false, error: "elevenlabs_unavailable" };

    let data: Page;
    try {
      data = (await res.json()) as Page;
    } catch {
      return { ok: false, error: "elevenlabs_unavailable" };
    }
    for (const v of data.voices ?? []) {
      if (!v?.voice_id || seen.has(v.voice_id)) continue;
      seen.add(v.voice_id);
      out.push(toPickerVoice(v));
    }

    const next = data.next_page_token || null;
    if (!next || data.has_more === false || next === token) {
      return { ok: true, voices: out, truncated: false };
    }
    token = next;
  }
  // Hit the page cap: return what was read, and say it is not the whole list.
  return { ok: true, voices: out, truncated: true };
}
