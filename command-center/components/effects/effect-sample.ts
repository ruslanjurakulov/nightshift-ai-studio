import { isEffectPrompt, type Effect } from "@/lib/effects/catalog";
import type { ShowcaseCard, ShowcaseFiles } from "@/lib/site/showcase";
import { SHOWCASE_CARDS, SHOWCASE_FILES } from "@/components/site/showcase-assets";

// Its own module, not EffectFrame.tsx: that file is a Client Component, and a Server Component that imports a plain function
// from a "use client" module gets a client reference it cannot call. The public gallery (a Server Component) needs the sample's
// size on the server to size its grid rows; EffectFrame re-exports this for its existing callers.

/**
 * An effect's real sample: the showcase entry its `previewJobId` names, only when that entry is in lib/site/showcase.json (the
 * export checked it was the operator's own completed job, byte for byte), its files are in the repository, and it IS this
 * effect's output: a clip from the effect's tool, by one of the effect's models, given exactly the effect's words (with a subject
 * in the slot). Anything less is no sample, and the card draws its placeholder: a preview is never borrowed from another job.
 *
 * The words are checked only where the entry carries them (a full entry, on the server or in a test). The default is the client-safe
 * slice (components/site/showcase-assets.ts SHOWCASE_CARDS), which has no prompt: this runs in the browser (EffectFrame, the
 * Studio's desk), and the full manifest is server-only. Both lists are build-time constants, so tests/showcase-cards.test.ts
 * holding the slice's answer equal to the full entries' answer for every effect in the catalog is the same guard, run once in CI.
 */
export function effectSample(
  effect: Pick<Effect, "previewJobId" | "capability" | "models" | "prompt">,
  entries: readonly (ShowcaseCard & { prompt?: string })[] = SHOWCASE_CARDS,
  files: Readonly<Record<string, ShowcaseFiles>> = SHOWCASE_FILES,
): { entry: ShowcaseCard; files: ShowcaseFiles } | null {
  if (!effect.previewJobId) return null;
  const entry = entries.find((e) => e.jobId === effect.previewJobId);
  const f = files[effect.previewJobId];
  if (!entry || !f || entry.kind !== "video" || !f.clip) return null;
  if (entry.capability !== effect.capability || !effect.models.includes(entry.modelId)) return null;
  if (entry.prompt !== undefined && !isEffectPrompt(effect, entry.prompt)) return null;
  return { entry, files: f };
}

/** The effect's own shape, height / width: what its drawing reserves. */
function aspectRatio(aspect: Effect["aspect"]): number {
  return aspect === "9:16" ? 16 / 9 : aspect === "16:9" ? 9 / 16 : 1;
}

/** How far a sample's shape may be from its effect's (relative) and still be the card's frame: a model's 1280 x 2240 for a 9:16. */
const SHAPE_SLACK = 0.03;

/**
 * Whether a sample sets its card's frame at its own size. Only when it is the effect's shape: a picture-to-video sample takes the
 * shape of the picture it was made from, and product-burst's (from a 4:5 perfume still) at 4:5 left the public Effects grid with no
 * level arrangement at all (130 px apart at two columns, lib/effects/masonry.ts). Such a sample is shown in the effect's own
 * shape, cut from the centre (object-fit: cover; there 10% of empty backdrop off the top and the bottom), and the grid is planned
 * on that shape.
 */
export function sampleKeepsShape(effect: Pick<Effect, "aspect">, entry: Pick<ShowcaseCard, "width" | "height">): boolean {
  return Math.abs(entry.height / entry.width / aspectRatio(effect.aspect) - 1) <= SHAPE_SLACK;
}

/** height / width of the card's frame: the sample's own size when it is the effect's shape (sampleKeepsShape), else the effect's. */
export function effectFrameRatio(effect: Pick<Effect, "previewJobId" | "capability" | "models" | "prompt" | "aspect">): number {
  const s = effectSample(effect);
  if (s && sampleKeepsShape(effect, s.entry)) return s.entry.height / s.entry.width;
  return aspectRatio(effect.aspect);
}
