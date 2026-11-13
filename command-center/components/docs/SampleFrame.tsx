import type { SceneKind } from "@/lib/dev/mcp-landing";
import { placeMedia, type PlaceDef, type PlaceMedia } from "@/components/site/samples";
import type { ShowcaseEntry } from "@/lib/site/showcase";

/**
 * The picture behind each scene kind of the /mcp examples carousel, one line each in the same shape as the site's slots
 * (components/site/samples.tsx PlaceDef): `ai` is the showcase job that fills the card (one of our generations, labelled with
 * its model), and the rest is the stock fallback (a Pexels contributor's photograph, credited on the card) kept until that job's
 * files are merged. Six different pictures, none of them one the page shows anywhere else. `position` is where each stock
 * picture is framed in the tall card.
 */
export const SCENE_SAMPLE: Record<SceneKind, PlaceDef> = {
  hills: { ai: null, id: "valley", position: "30% 50%" },
  waves: { ai: null, id: "lighthouse", position: "58% 50%" },
  city: { ai: null, id: "market", position: "32% 50%" },
  stars: { ai: null, id: "moon", position: "90% 50%" },
  rings: { ai: null, id: "library", position: "50% 50%" },
  // The one stock card that moves: a camel caravan on the sand, the same footage /solutions plays (a different page), framed on the camels.
  dunes: { ai: null, id: "caravan", position: "36% 50%", clip: "caravan" },
};

/** What a scene's card shows (a sample or the stock fallback). */
export function sceneMedia(kind: SceneKind, entries?: readonly ShowcaseEntry[]): PlaceMedia {
  return placeMedia(SCENE_SAMPLE[kind], null, entries);
}
