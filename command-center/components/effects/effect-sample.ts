import { isEffectPrompt, type Effect } from "@/lib/effects/catalog";
import { SHOWCASE_ENTRIES, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";

// Its own module, not EffectFrame.tsx: that file is a Client Component, and a Server Component that imports a plain function
// from a "use client" module gets a client reference it cannot call. The public gallery (a Server Component) needs the sample's
// size on the server to size its grid rows; EffectFrame re-exports this for its existing callers.

/**
 * An effect's real sample: the showcase entry its `previewJobId` names, only when that entry is in lib/site/showcase.json (the
 * export checked it was the operator's own completed job, byte for byte), its files are in the repository, and it IS this
 * effect's output: a clip from the effect's tool, by one of the effect's models, given exactly the effect's words (with a subject
 * in the slot). Anything less is no sample, and the card draws its placeholder: a preview is never borrowed from another job.
 */
export function effectSample(
  effect: Pick<Effect, "previewJobId" | "capability" | "models" | "prompt">,
  entries: readonly ShowcaseEntry[] = SHOWCASE_ENTRIES,
  files: Readonly<Record<string, ShowcaseFiles>> = SHOWCASE_FILES,
): { entry: ShowcaseEntry; files: ShowcaseFiles } | null {
  if (!effect.previewJobId) return null;
  const entry = entries.find((e) => e.jobId === effect.previewJobId);
  const f = files[effect.previewJobId];
  if (!entry || !f || entry.kind !== "video" || !f.clip) return null;
  if (entry.capability !== effect.capability || !effect.models.includes(entry.modelId) || !isEffectPrompt(effect, entry.prompt)) return null;
  return { entry, files: f };
}

/** height / width of the card's frame: the sample's own size when it has one, else the drawing's shape (the effect's aspect). */
export function effectFrameRatio(effect: Pick<Effect, "previewJobId" | "capability" | "models" | "prompt" | "aspect">): number {
  const s = effectSample(effect);
  if (s) return s.entry.height / s.entry.width;
  return effect.aspect === "9:16" ? 16 / 9 : effect.aspect === "16:9" ? 9 / 16 : 1;
}
