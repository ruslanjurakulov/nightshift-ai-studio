import { SHOWCASE_ENTRIES, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { SHOWCASE_ITEMS, type ShowcaseItem } from "@/lib/showcase/items";
import { REGISTRY_NAMES } from "@/lib/creative/model-names";

/**
 * The landing's moving pictures, all of them real generations from our own Studio. Never stock footage and never a competitor's
 * output: tests/home-page.test.tsx checks the hero is a showcase entry with its own clip, and every reel piece a
 * lib/showcase/items.ts item with its files in public/showcase/ and a model the registry names.
 *
 * The hero: Earth from orbit, its dark left third behind the headline (lib/site/showcase.json, written only by
 * tools/export_showcase.py; docs/design/MEDIA_CREDITS.md "Model samples").
 */
export const HERO_JOB = "4e85c7e4-fd1a-4771-97ee-66c1fb853367";

export type ReelItem = { e: ShowcaseEntry; f: ShowcaseFiles };

/** An id with no entry or no clip is dropped, never shown as a broken frame. */
export function reelItem(jobId: string): ReelItem | null {
  const e = SHOWCASE_ENTRIES.find((x) => x.jobId === jobId);
  const f = SHOWCASE_FILES[jobId];
  if (!e || !f || e.kind !== "video" || !f.clip) return null;
  return { e, f };
}

/** A reel piece and the display names of the models that made it, for its "Made with … in Nightshift Studio" line. */
export type StudioPiece = ShowcaseItem & { models: string[] };

/** The shape of each piece's box (the posters are a few pixels off these; the box's aspect-ratio and object-fit cover decide). */
export const PIECE_SIZE: Readonly<Record<ShowcaseItem["aspect"], { width: number; height: number }>> = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 1080, height: 1080 },
};

/**
 * The reel, in lib/showcase/items.ts's order (language-duo first). A piece with a model the registry does not name is left out
 * rather than credited to a raw id or to fewer models than made it: the credit is the point of the line, and the test fails on
 * such a piece.
 */
export function studioPieces(): StudioPiece[] {
  return SHOWCASE_ITEMS.flatMap((it) => {
    const models = it.modelIds.map((id) => REGISTRY_NAMES[id]);
    return it.modelIds.length > 0 && models.every(Boolean) ? [{ ...it, models }] : [];
  });
}
