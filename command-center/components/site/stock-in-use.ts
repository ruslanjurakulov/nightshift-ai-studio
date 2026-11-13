/**
 * The stock pictures the public site still shows: every slot and every /mcp scene whose sample has not replaced it yet. The
 * footer credits exactly these, so a picture a sample replaced leaves the credits (and the stock sentence) by itself, and once
 * this is empty the site says nothing about stock at all, because it shows none. A credit for a picture nobody can see would be
 * a claim about the page that is not true; a picture shown without its credit would break the promise lib/site/media.ts makes.
 */
import type { MediaId } from "@/lib/site/media";
import { MEDIA_IDS } from "@/lib/site/media";
import { SLOTS, slotMedia, type SlotId } from "@/components/site/samples";
import { SCENE_SAMPLE, sceneMedia } from "@/components/docs/SampleFrame";
import type { SceneKind } from "@/lib/dev/mcp-landing";

export function stockInUse(): MediaId[] {
  const used = new Set<MediaId>();
  for (const slot of Object.keys(SLOTS) as SlotId[]) {
    const m = slotMedia(slot);
    if (m.kind === "stock") used.add(m.id);
  }
  for (const kind of Object.keys(SCENE_SAMPLE) as SceneKind[]) {
    const m = sceneMedia(kind);
    if (m.kind === "stock") used.add(m.id);
  }
  // In the data file's order, so the list reads the same from one deploy to the next.
  return MEDIA_IDS.filter((id) => used.has(id));
}
