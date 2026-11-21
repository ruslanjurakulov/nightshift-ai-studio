/**
 * The public model list (migration 0193), parsed. Pure, so a test can feed it anything the database might answer.
 *
 * A model's capability codes become the words a visitor knows: image, video or voice. A code we do not know is left out of
 * the words, never guessed; a model left with no known kind is still listed by name.
 *
 * adultOnly is 0192's mark (the maker's terms are 18+): such a model stays listed and says so. A row whose mark is not a real
 * boolean is dropped rather than shown unmarked: "not known to be for adults only" must never read as "not for adults only".
 */
export type ModelKind = "image" | "video" | "voice";

export interface PublicModel {
  name: string;
  kinds: ModelKind[];
  adultOnly: boolean;
}

const KIND_OF: Record<string, ModelKind> = {
  t2i: "image",
  edit: "image",
  upscale: "image",
  remove_bg: "image",
  expand: "image",
  relight: "image",
  erase: "image",
  t2v: "video",
  i2v: "video",
  video_upscale: "video",
  video_edit: "video",
  video_reframe: "video",
  video_remove_bg: "video",
  tts: "voice",
  sfx: "voice",
  voice_change: "voice",
  dub: "voice",
};
const ORDER: ModelKind[] = ["video", "image", "voice"];

/** null for an answer that is not a list (the read is then treated as failed); malformed rows are dropped. */
export function parsePublicModels(raw: unknown): PublicModel[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PublicModel[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const { display_name: name, capabilities, adult_only: adult } = row as { display_name?: unknown; capabilities?: unknown; adult_only?: unknown };
    if (typeof name !== "string" || name.trim() === "" || seen.has(name) || typeof adult !== "boolean") continue;
    seen.add(name);
    const kinds = new Set<ModelKind>();
    if (Array.isArray(capabilities)) for (const c of capabilities) if (typeof c === "string" && KIND_OF[c]) kinds.add(KIND_OF[c]);
    out.push({ name: name.trim(), kinds: ORDER.filter((k) => kinds.has(k)), adultOnly: adult });
  }
  return out;
}
