import type { PickerVoice, VoiceTraits } from "@/lib/elevenlabsVoices";

/**
 * The Studio's speech voice picker, as pure rules: which voices come first, which characters a person can
 * filter by, and what a filter keeps. Client-safe: no request, no key. The list itself is the platform
 * ElevenLabs account's own (GET /api/creative/voices), so a voice that appears here is one the account can speak in.
 */

export type CatalogVoice = PickerVoice;

/** The characters a person narrows the list by. Each is an ElevenLabs label key (use_case is `useCase` here). */
export const VOICE_FACETS = ["gender", "age", "accent", "useCase"] as const;
export type VoiceFacet = (typeof VOICE_FACETS)[number];

export type VoiceFilter = Partial<Record<VoiceFacet, string>> & { query?: string };

/**
 * Premade voices are ElevenLabs' own and our Voice Design voices (`generated`) are the account's: neither can be
 * withdrawn from under a channel, so they are offered first. Everything else follows, a library voice last.
 */
function rank(v: CatalogVoice): number {
  if (v.category === "premade") return 0;
  if (v.category === "generated") return 1;
  return v.library ? 3 : 2;
}

export function sortVoices(voices: readonly CatalogVoice[]): CatalogVoice[] {
  return [...voices].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.voiceId.localeCompare(b.voiceId));
}

/** ElevenLabs writes label values in snake case ("middle_aged"); shown as words, never translated (they are its words). */
export function traitText(value: string): string {
  return value.replace(/_/g, " ");
}

const norm = (s: string) => s.trim().toLowerCase();

/** The values each facet takes across the list, sorted. A facet no voice carries has no values, and no filter is drawn for it. */
export function facetValues(voices: readonly CatalogVoice[]): Record<VoiceFacet, string[]> {
  const out = {} as Record<VoiceFacet, string[]>;
  for (const f of VOICE_FACETS) {
    const seen = new Map<string, string>();
    for (const v of voices) {
      const value = v.traits[f as keyof VoiceTraits];
      if (value && !seen.has(norm(value))) seen.set(norm(value), value);
    }
    out[f] = [...seen.values()].sort((a, b) => a.localeCompare(b));
  }
  return out;
}

/**
 * The voices a filter keeps. A facet filter keeps only voices that carry that exact value: a voice with no gender
 * label is not "any gender", it is unlabelled, and it drops out once a gender is chosen. The search reads the name
 * and the description, not the id: an id is never something a person types here.
 */
export function filterVoices(voices: readonly CatalogVoice[], filter: VoiceFilter): CatalogVoice[] {
  const q = norm(filter.query ?? "");
  return voices.filter((v) => {
    for (const f of VOICE_FACETS) {
      const want = filter[f];
      if (want && norm(v.traits[f as keyof VoiceTraits] ?? "") !== norm(want)) return false;
    }
    if (!q) return true;
    return norm(v.name).includes(q) || norm(v.traits.description ?? "").includes(q);
  });
}

export function isFiltered(filter: VoiceFilter): boolean {
  return Boolean(filter.query?.trim()) || VOICE_FACETS.some((f) => Boolean(filter[f]));
}
