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

/** A voice's character as ElevenLabs labels it. A key the voice does not carry is absent, never guessed. */
export type VoiceTraits = {
  gender?: string;
  age?: string;
  accent?: string;
  useCase?: string;
  description?: string;
};

export type PickerVoice = {
  voiceId: string;
  name: string;
  category: string;
  previewUrl: string;
  labels: string;
  traits: VoiceTraits;
  /**
   * A community (Voice Library) voice another account owns: its owner can withdraw it after a notice period,
   * and a channel built on it would lose its narrator. True only when ElevenLabs says the account does not own
   * it (`is_owner: false`) or that it is a copy of a shared voice; an unstated owner is not read as "library".
   */
  library: boolean;
};

type RawVoice = {
  voice_id: string;
  name?: string;
  category?: string;
  description?: string | null;
  preview_url?: string;
  labels?: Record<string, string>;
  is_owner?: boolean | null;
  sharing?: { status?: string | null } | null;
};

const TRAIT_KEYS: Record<string, keyof VoiceTraits> = {
  gender: "gender",
  age: "age",
  accent: "accent",
  use_case: "useCase",
  description: "description",
};

/** A label value fit to show: a short, printable string. Anything else is left out rather than shown garbled. */
function labelValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.length <= 80 ? s : null;
}

function traitsOf(v: RawVoice): VoiceTraits {
  const out: VoiceTraits = {};
  for (const [raw, key] of Object.entries(TRAIT_KEYS)) {
    const value = labelValue(v.labels?.[raw]);
    if (value) out[key] = value;
  }
  // The voice's own description is the longer one people write; the label is a word or two.
  const own = typeof v.description === "string" ? v.description.trim().slice(0, 300) : "";
  if (own) out.description = own;
  return out;
}

function isLibraryVoice(v: RawVoice): boolean {
  if (v.category === "premade") return false;
  if (v.is_owner === false) return true;
  const status = v.sharing?.status ?? "";
  return status === "copied" || status === "copied_disabled";
}

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
    // Played straight from the browser, so only an https link is passed on (the CSP allows https media).
    previewUrl: typeof v.preview_url === "string" && v.preview_url.startsWith("https://") ? v.preview_url : "",
    // Accent, age, gender and use case, as ElevenLabs labels them. This is what
    // makes two voices distinguishable in a dropdown of thirty.
    labels: Object.values(v.labels ?? {}).filter(Boolean).join(" · "),
    traits: traitsOf(v),
    library: isLibraryVoice(v),
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
